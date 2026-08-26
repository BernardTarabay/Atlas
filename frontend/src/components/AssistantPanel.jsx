import { useRef, useEffect, useState } from "react";
import {
  Send, FolderInput, Plus, Pencil, Trash2, Check, X, Loader2,
  Bot, User, Sparkles, Mic, MicOff, GitCompare, CheckCheck, ListX, Copy, Search, MapPin,
} from "lucide-react";
import { api } from "../services/apiClient";
import { useAssistant, useAssistantAsk } from "../context/AssistantContext";
import { useToast } from "../context/ToastContext";
import { SearchSnippet } from "./SearchSnippet";

// Mirrors READ_ONLY_ACTIONS in backend/src/services/ai/geminiChatService.js:
// these only read, so they run on arrival instead of waiting for Apply.
const READ_ONLY_ACTIONS = ["compare_files", "find_files"];

const ACTION_ICONS = {
  move_file: FolderInput,
  rename_file: Pencil,
  delete_file: Trash2,
  compare_files: GitCompare,
  find_files: Search,
  approve_proposals: CheckCheck,
  reject_proposals: ListX,
  resolve_duplicates: Copy,
  move_subject_contents: FolderInput,
  move_by_filter: FolderInput,
  create_subject: Plus,
  rename_subject: Pencil,
  delete_subject: Trash2,
};

const BULK_CONCURRENCY = 3;

const SpeechRecognitionCtor =
  typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

/**
 * Reorganize-by-conversation, embedded as a floating widget on the Subjects
 * page -- a circular launcher pinned to the bottom-right corner (closed
 * state) that opens into a docked chat card above it (open state), rather
 * than a page-header button + centered modal. Talks to POST /api/ai/chat,
 * which only ever returns a reply + proposed actions -- see
 * geminiChatService.js. Every action is rendered as a card and only takes
 * effect when the user clicks Apply, at which point this component calls
 * the exact same REST endpoints the rest of the Subjects/Files pages use
 * (PATCH /files/:id, POST/PATCH/DELETE /subjects) -- there is no separate
 * "execute" endpoint, and nothing here bypasses normal permission checks or
 * validation.
 *
 * Unlike the old Modal-based version, this component is always mounted (the
 * launcher itself is the toggle), so conversation state can live here as
 * plain local state instead of being lifted to the parent -- it survives
 * opening/closing the panel for free since the component never unmounts.
 *
 * Voice input is browser-native speech-to-text (Web Speech API) transcribed
 * into the message box for the user to review before sending -- not audio
 * sent to Gemini directly. That keeps this a pure frontend addition (no new
 * backend surface, no extra API cost) and, for a chat that can propose real
 * moves/deletes, means a misheard word gets caught before Send rather than
 * silently acted on.
 */
export function AssistantPanel() {
  // Context comes from whichever page is mounted rather than from props:
  // this component lives in the app shell so it is available everywhere,
  // and each page publishes what is on screen (see AssistantContext).
  const { context, notifyChanged, revealSubject } = useAssistant();
  const { push: onNotify } = useToast();
  const visibleFiles = context.files || [];

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);

  const inputRef = useRef(null);
  /**
   * Another part of the app handing the user into a conversation -- the
   * Library's empty state, which has nothing to show a new account and every
   * reason to start them talking instead. Opens the panel and prefills the
   * sentence; deliberately does NOT send it, so the first thing the assistant
   * sees is something the user actually wrote.
   */
  useAssistantAsk((text) => {
    setOpen(true);
    setInput(text);
    // After the panel has rendered, so the field exists to focus.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      // Caret at the end -- these are sentence openers meant to be continued.
      el.setSelectionRange?.(text.length, text.length);
    });
  });

  const scrollRef = useRef(null);
  const recognitionRef = useRef(null);
  // Mirrors `messages` so send() can work out the index of the assistant
  // turn it is about to append, without waiting for a re-render.
  const messagesRef = useRef([]);
  // Identifies the active dictation session; bumped whenever one is
  // superseded so late speech results can be discarded. See toggleListening.
  const voiceSession = useRef(0);

  useEffect(() => {
    messagesRef.current = messages;
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Stop any in-progress recognition if the widget unmounts mid-listen --
  // otherwise the browser's mic indicator stays on. Retiring the session
  // first also stops the trailing result from calling setState on an
  // unmounted component.
  useEffect(
    () => () => {
      voiceSession.current += 1;
      recognitionRef.current?.stop();
    },
    []
  );

  function toggleListening() {
    if (!SpeechRecognitionCtor) return;

    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;

    // Each listening session gets an id. Calling stop() makes the browser
    // emit one LAST onresult afterwards -- so sending a dictated message
    // cleared the box and then this handler immediately refilled it with
    // the text that had just been sent. Anything arriving for a session
    // that is no longer current is ignored.
    const session = ++voiceSession.current;

    recognition.onresult = (event) => {
      if (voiceSession.current !== session) return;

      // Separate settled text from the in-progress tail. Concatenating
      // every result regardless of isFinal double-counts a phrase as it
      // firms up, which is how dictation ended up stuttering words.
      let settled = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) settled += result[0].transcript;
        else interim += result[0].transcript;
      }
      setInput((settled + interim).trimStart());
    };
    recognition.onerror = (event) => {
      setListening(false);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        onNotify?.("Microphone access was denied.", "error");
      } else if (event.error !== "aborted" && event.error !== "no-speech") {
        onNotify?.(`Voice input error: ${event.error}`, "error");
      }
    };
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    setInput("");
    setListening(true);
    recognition.start();
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;

    // Retire the current dictation session BEFORE stopping it, so the
    // trailing onresult that stop() triggers cannot repopulate the box
    // with the message being sent.
    voiceSession.current += 1;
    if (listening) recognitionRef.current?.stop();

    const priorHistory = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setSending(true);

    try {
      const res = await api.post("/ai/chat", {
        message: text,
        history: priorHistory,
        context: {
          page: context.page || null,
          description: context.description || "",
          selectedSubjectId: context.selectedSubjectId || null,
          files: visibleFiles.map((f) => ({
            id: f.id,
            filename: f.filename_current || f.display_name || f.filename,
            currentPath: f.current_path,
          })),
        },
      });
      const actions = (res.actions || []).map((a) => ({
        // Read-only actions have nothing to confirm -- they run on arrival
        // and the answer appears in the card. Making someone click Apply to
        // receive a number they just asked for is friction, not safety.
        ...a,
        _status: READ_ONLY_ACTIONS.includes(a.type) ? "running" : "pending",
      }));
      // Where this assistant turn will land: after the N turns that existed
      // when we sent, plus the one user turn we pushed. Derived from the same
      // snapshot the request was built from, so it needs no ref and no
      // assumption about when an effect ran.
      //
      // It was `messagesRef.current.length + 1`, justified as "the user turn
      // was just pushed" -- but messagesRef is written by an effect keyed on
      // `messages`, which had already flushed during the awaited /ai/chat
      // call, so the ref DID include the user turn and the +1 pointed one
      // past the assistant message. updateAction matched nothing, so every
      // compare_files and find_files card stayed at "Comparing…" forever and
      // swallowed its own errors -- the whole run-on-arrival path was dead.
      const messageIndex = priorHistory.length + 1;
      setMessages((prev) => [...prev, { role: "assistant", text: res.reply, actions }]);

      actions.forEach((a, ai) => {
        if (READ_ONLY_ACTIONS.includes(a.type)) runReadOnlyAction(messageIndex, ai, a);
      });
    } catch (err) {
      setMessages((prev) => [...prev, { role: "assistant", text: `Couldn't reach the assistant: ${err.message}`, actions: [] }]);
    } finally {
      setSending(false);
    }
  }

  function updateAction(messageIndex, actionIndex, patch) {
    setMessages((prev) =>
      prev.map((m, mi) =>
        mi !== messageIndex
          ? m
          : { ...m, actions: m.actions.map((a, ai) => (ai !== actionIndex ? a : { ...a, ...patch })) }
      )
    );
  }

  async function applyAction(messageIndex, actionIndex, action) {
    updateAction(messageIndex, actionIndex, { _status: "applying" });
    try {
      if (action.type === "move_file") {
        const detail = await api.get(`/files/${action.fileId}`);
        await api.patch(`/files/${action.fileId}`, {
          subjectId: action.toSubjectId,
          documentTypeId: detail?.latestClassification?.classified_document_type_id || null,
        });
      } else if (action.type === "move_subject_contents") {
        await bulkMoveSubjectContents(action.fromSubjectId, action.toSubjectId, (done, total) =>
          updateAction(messageIndex, actionIndex, { _status: "applying", _progress: `${done}/${total}` })
        );
      } else if (action.type === "move_by_filter") {
        // One request, not a client-side loop. move_subject_contents pages
        // through its files from the browser, which is tolerable for one
        // folder and not for a filter that can match the whole archive -- so
        // this hands the criteria to the server and gets back a job to watch.
        const res = await api.post("/files/move-by-filter", {
          filters: action.filter,
          toSubjectId: action.toSubjectId,
        });
        updateAction(messageIndex, actionIndex, {
          _result:
            res.matched === 0
              ? "Nothing matched those criteria — no files were touched."
              : `Filing ${res.matched.toLocaleString()} file${res.matched === 1 ? "" : "s"} into ${res.destination} — watch Processing Jobs for progress.`,
        });
      } else if (action.type === "rename_file") {
        // The same endpoint the Edit dialog uses -- on a read-only location
        // this records the canonical name rather than touching the original.
        await api.patch(`/files/${action.fileId}`, { filename: action.newFilename });
      } else if (action.type === "delete_file") {
        await api.del(`/files/${action.fileId}`);
      } else if (action.type === "approve_proposals") {
        const res = await api.post("/rename-proposals/above-confidence/approve", {
          minConfidence: action.minConfidence,
        });
        updateAction(messageIndex, actionIndex, {
          _result: res.approved > 0
            ? `Approved ${res.approved} proposal${res.approved === 1 ? "" : "s"} — renaming now.`
            : "Nothing matched that threshold.",
        });
      } else if (action.type === "reject_proposals") {
        const res = await api.post("/rename-proposals/below-confidence/reject", {
          maxConfidence: action.maxConfidence,
        });
        updateAction(messageIndex, actionIndex, {
          _result: res.rejected > 0
            ? `Discarded ${res.rejected} suggestion${res.rejected === 1 ? "" : "s"}. No files were touched.`
            : "Nothing matched that threshold.",
        });
      } else if (action.type === "resolve_duplicates") {
        await api.post("/duplicate-groups/auto-resolve");
        updateAction(messageIndex, actionIndex, {
          _result: "Resolving exact duplicates — watch Processing Jobs for progress.",
        });
      } else if (action.type === "create_subject") {
        // The description travels with it. Without this the assistant can write
        // a perfectly good "what belongs here" sentence and it is dropped on
        // the floor at Apply time -- and that sentence is what the classifier
        // reads when filing everything that arrives later.
        await api.post("/subjects", {
          parentId: action.parentSubjectId || null,
          name: action.name,
          description: action.description || null,
        });
      } else if (action.type === "rename_subject") {
        await api.patch(`/subjects/${action.subjectId}`, { name: action.name });
      } else if (action.type === "delete_subject") {
        await api.del(`/subjects/${action.subjectId}`);
      } else {
        throw new Error(`Unknown action type "${action.type}".`);
      }
      updateAction(messageIndex, actionIndex, { _status: "applied" });
      notifyChanged();
    } catch (err) {
      updateAction(messageIndex, actionIndex, { _status: "error", _error: err.message });
      onNotify?.(err.message, "error");
    }
  }

  function rejectAction(messageIndex, actionIndex) {
    updateAction(messageIndex, actionIndex, { _status: "rejected" });
  }

  /**
   * Run an action that only reads, as soon as it arrives.
   *
   * Comparing two files changes nothing, so the answer should just appear.
   * The result is written back onto the card rather than sent to the model
   * for a second opinion -- that would double the latency and the API cost
   * to restate a number the card already shows.
   */
  async function runReadOnlyAction(messageIndex, actionIndex, action) {
    try {
      if (action.type === "compare_files") {
        const res = await api.post("/files/compare", {
          fileIdA: action.fileIdA,
          fileIdB: action.fileIdB,
        });
        updateAction(messageIndex, actionIndex, {
          _status: "done",
          _comparison: res,
        });
      } else if (action.type === "find_files") {
        // GET /files, not GET /files/search -- the latter has never been a
        // route. It fell through to GET /files/:id, failed the uuid cast and
        // came back 400 "Malformed id", so every "find the lease for X"
        // request errored. SubjectsPage hit exactly this and was fixed there;
        // the assistant was left behind.
        const rows = await api.get("/files", { q: action.query, limit: 12 });
        updateAction(messageIndex, actionIndex, {
          _status: "done",
          _matches: (rows || []).map((f) => ({
            id: f.id,
            name: f.canonical_filename || f.filename_current,
            subjectId: f.subject_id || null,
            subjectName: f.subject_name || null,
            snippet: f.snippet || null,
            // What this file IS. For a photo, a video or a scan there is no
            // snippet to show -- the description is the only thing that tells
            // the user whether this is the one they meant.
            description: f.ai_summary || null,
            matchReasons: f.match_reasons || [],
          })),
        });
      } else {
        updateAction(messageIndex, actionIndex, { _status: "done" });
      }
    } catch (err) {
      updateAction(messageIndex, actionIndex, { _status: "error", _error: err.message });
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={open ? "Close chat" : "Ask Gemini"}
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full text-white transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
        style={{ background: "linear-gradient(135deg, var(--color-brand-500), var(--color-brand-700))", boxShadow: "var(--shadow-glow)" }}
      >
        {open ? <X size={22} /> : <Sparkles size={22} />}
      </button>

      {open && (
        <div
          className="glass-card animate-fade-in-up fixed bottom-24 right-6 z-40 flex w-[380px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden p-0 shadow-2xl"
          style={{ height: "min(560px, 70vh)" }}
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="flex items-center gap-1.5">
              <Sparkles size={13} className="text-brand-700" />
              <h3 className="text-sm font-semibold text-base-50">Ask Gemini</h3>
            </div>
            <button onClick={() => setOpen(false)} className="rounded-lg p-1 text-base-400 hover:bg-base-900 hover:text-base-100">
              <X size={15} />
            </button>
          </div>

          <div ref={scrollRef} className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <p className="py-6 text-center text-xs text-base-400">
                Tell it how you'd like things organized -- "move X into Y", "create a Legal category under
                Administrative", "rename Scans to Archive". It'll propose the changes; nothing happens until you
                click Apply.
              </p>
            )}
            {messages.map((m, mi) => (
              <div key={mi} className={`flex gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                {m.role === "assistant" && (
                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-brand-700">
                    <Bot size={13} />
                  </div>
                )}
                <div className={`max-w-[85%] space-y-2 ${m.role === "user" ? "items-end" : "items-start"}`}>
                  {/* dir="auto" lets the browser pick direction per message
                      from its first strong character. This repository is
                      largely Hebrew and Arabic, and without it those replies
                      render left-to-right with the punctuation stranded on
                      the wrong side -- unreadable to someone who actually
                      reads the language. Doing it per bubble rather than on
                      the panel means a Hebrew question and an English answer
                      each render correctly in the same conversation.
                      whitespace-pre-wrap keeps the model's line breaks. */}
                  <div
                    dir="auto"
                    className={
                      "whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-sm " +
                      (m.role === "user" ? "bg-brand-500/15 text-brand-700" : "border border-line bg-base-900 text-base-200")
                    }
                  >
                    {m.text}
                  </div>
                  {m.actions?.length > 0 && (
                    <div className="space-y-1.5">
                      {m.actions.map((a, ai) => (
                        <ActionCard
                          key={ai}
                          action={a}
                          onReveal={revealSubject}
                          onApply={() => applyAction(mi, ai, a)}
                          onReject={() => rejectAction(mi, ai)}
                        />
                      ))}
                    </div>
                  )}
                </div>
                {m.role === "user" && (
                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-base-850 text-base-300">
                    <User size={13} />
                  </div>
                )}
              </div>
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-xs text-base-500">
                <Loader2 size={12} className="animate-spin" /> Gemini is thinking…
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 border-t border-line px-3 py-3">
            {SpeechRecognitionCtor && (
              <button
                type="button"
                className={`btn-ghost btn-sm ${listening ? "text-rose-600 hover:text-rose-700" : ""}`}
                onClick={toggleListening}
                title={listening ? "Stop listening" : "Speak your message"}
              >
                {listening ? <MicOff size={14} className="animate-pulse" /> : <Mic size={14} />}
              </button>
            )}
            <input
              ref={inputRef}
              className="input flex-1"
              placeholder={listening ? "Listening…" : "Ask about your documents…"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              disabled={sending}
            />
            <button className="btn-primary btn-sm" onClick={send} disabled={sending || !input.trim()}>
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Search hits from find_files, each one a way into the map.
 *
 * Listing names would answer "does it exist?" -- which is rarely the
 * question. "Show me where it is" is, so every row asks the Subjects page to
 * select that file's subject, which opens the branches above it and lights
 * the route down to it.
 *
 * A file with no subject is shown but not clickable: it genuinely has
 * nowhere to be revealed yet, and a button that silently did nothing would
 * be worse than one that is visibly unavailable.
 */
function FoundFiles({ matches, onReveal }) {
  if (matches.length === 0) {
    return <p className="mt-1.5 text-base-500">Nothing in the repository matched that.</p>;
  }

  return (
    <div className="mt-2 space-y-1">
      {matches.map((m) => (
        <div key={m.id} className="rounded-md border border-line-strong bg-inset px-2 py-1.5">
          <p dir="auto" className="truncate text-[11px] font-medium text-base-100">{m.name}</p>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="truncate text-[10px] text-base-500">{m.subjectName || "unfiled"}</span>
            {m.subjectId ? (
              <button
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-brand-700 hover:bg-brand-500/10"
                onClick={() => onReveal?.(m.subjectId, m.id)}
                title="Show where this sits in the subject map"
              >
                <MapPin size={10} /> Show me
              </button>
            ) : (
              <span className="shrink-0 text-[10px] text-base-600">not filed yet</span>
            )}
          </div>
          {/* The snippet is the stronger evidence when there is one -- it is
              the document's own words. The description is what a photo, a
              video or an unreadable scan has instead, so it is shown when
              there is no snippet rather than alongside it. */}
          {m.snippet ? (
            <SearchSnippet snippet={m.snippet} />
          ) : m.description ? (
            <p dir="auto" className="mt-1 line-clamp-2 text-[10px] leading-snug text-base-400">
              {m.description}
            </p>
          ) : null}
          {m.matchReasons?.length > 0 && (
            <p className="mt-1 text-[9px] uppercase tracking-wide text-base-600">
              matched its {m.matchReasons.join(" and ")}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function ActionCard({ action, onApply, onReject, onReveal }) {
  const Icon = ACTION_ICONS[action.type] || FolderInput;
  const danger = action.type === "delete_subject" || action.type === "delete_file";

  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${danger ? "border-rose-500/25 bg-rose-500/[0.06]" : "border-line-strong bg-base-900"}`}>
      <div className="flex items-start gap-2">
        <Icon size={13} className={`mt-0.5 shrink-0 ${danger ? "text-rose-600" : "text-brand-600"}`} />
        {/* Same reason as the message bubbles: the model now writes these
            in the user's own language, so they need per-element direction. */}
        <p dir="auto" className="flex-1 text-base-200">{action.summary}</p>
      </div>

      {action.type === "approve_proposals" && action._status === "pending" && (
        <MatchingProposalCount minConfidence={action.minConfidence} />
      )}

      {action.type === "reject_proposals" && action._status === "pending" && (
        <DiscardableProposalCount maxConfidence={action.maxConfidence} />
      )}

      {action._status === "running" && (
        <p className="mt-1.5 flex items-center gap-1.5 text-base-400">
          <Loader2 size={11} className="animate-spin" /> Comparing…
        </p>
      )}

      {action._comparison && <ComparisonResult result={action._comparison} />}

      {action._matches && <FoundFiles matches={action._matches} onReveal={onReveal} />}

      {action._result && (
        <p className="mt-1.5 flex items-center gap-1.5 text-emerald-700">
          <Check size={11} /> {action._result}
        </p>
      )}

      {action._status === "pending" && (
        <div className="mt-2 flex justify-end gap-1.5">
          <button className="btn-ghost btn-sm" onClick={onReject}>
            <X size={11} /> Reject
          </button>
          <button className={danger ? "btn-danger btn-sm" : "btn-secondary btn-sm"} onClick={onApply}>
            <Check size={11} /> Apply
          </button>
        </div>
      )}
      {action._status === "applying" && (
        <p className="mt-1.5 flex items-center gap-1.5 text-base-400">
          <Loader2 size={11} className="animate-spin" /> Applying{action._progress ? ` (${action._progress})` : "…"}
        </p>
      )}
      {action._status === "applied" && (
        <p className="mt-1.5 flex items-center gap-1.5 text-emerald-700">
          <Check size={11} /> Applied
        </p>
      )}
      {action._status === "rejected" && (
        <p className="mt-1.5 text-base-500">Dismissed</p>
      )}
      {action._status === "done" && !action._comparison && (
        <p className="mt-1.5 text-base-500">Done</p>
      )}
      {action._status === "error" && (
        <div className="mt-1.5 space-y-1">
          <p className="text-rose-700">{action._error}</p>
          <button className="btn-ghost btn-sm" onClick={onApply}>Retry</button>
        </div>
      )}
    </div>
  );
}

/**
 * How many pending proposals a threshold would approve, fetched before the
 * user commits.
 *
 * "Approve everything above 90%" is otherwise a blind click -- it could be
 * three proposals or three hundred, and the difference matters. The count
 * comes from the same query the approval itself uses, so the number shown
 * is the number acted on.
 */
function MatchingProposalCount({ minConfidence }) {
  const [state, setState] = useState({ loading: true, count: null, error: null });

  useEffect(() => {
    let cancelled = false;
    api
      .get("/rename-proposals/above-confidence", { minConfidence })
      .then((r) => !cancelled && setState({ loading: false, count: r.count, error: null }))
      .catch((e) => !cancelled && setState({ loading: false, count: null, error: e.message }));
    return () => { cancelled = true; };
  }, [minConfidence]);

  if (state.loading) return <p className="mt-1.5 text-base-500">Checking how many match…</p>;
  if (state.error) return <p className="mt-1.5 text-rose-700">{state.error}</p>;

  return (
    <p className={`mt-1.5 ${state.count === 0 ? "text-base-500" : "text-base-300"}`}>
      {state.count === 0
        ? "No pending proposals meet that threshold."
        : `${state.count} pending proposal${state.count === 1 ? "" : "s"} at or above ${Math.round(minConfidence * 100)}% confidence.`}
    </p>
  );
}

/**
 * The mirror of MatchingProposalCount for the discard direction. Kept
 * separate rather than parameterised because the wording has to differ: for
 * approving, zero matches is a non-event; for discarding several thousand
 * suggestions, the number is the whole point of showing the card at all.
 */
function DiscardableProposalCount({ maxConfidence }) {
  const [state, setState] = useState({ loading: true, count: null, error: null });

  useEffect(() => {
    let cancelled = false;
    api
      .get("/rename-proposals/below-confidence", { maxConfidence })
      .then((r) => !cancelled && setState({ loading: false, count: r.count, error: null }))
      .catch((e) => !cancelled && setState({ loading: false, count: null, error: e.message }));
    return () => { cancelled = true; };
  }, [maxConfidence]);

  if (state.loading) return <p className="mt-1.5 text-base-500">Checking how many match…</p>;
  if (state.error) return <p className="mt-1.5 text-rose-700">{state.error}</p>;

  return (
    <p className={`mt-1.5 ${state.count === 0 ? "text-base-500" : "text-amber-700"}`}>
      {state.count === 0
        ? "No pending proposals are at or below that confidence."
        : `${state.count} pending proposal${state.count === 1 ? "" : "s"} at or below ` +
          `${Math.round(maxConfidence * 100)}% will be discarded. No files are touched.`}
    </p>
  );
}

const COMPARISON_TONE = {
  exact: "text-rose-700",
  probable: "text-amber-700",
  distinct: "text-emerald-700",
  not_comparable: "text-base-400",
};

/** The similarity answer, shown inline in the chat. */
function ComparisonResult({ result }) {
  const percent = result.similarity === null ? null : (result.similarity * 100).toFixed(1);
  return (
    <div className="mt-2 rounded-lg border border-line-strong bg-inset px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`font-medium ${COMPARISON_TONE[result.verdict] || "text-base-300"}`}>
          {result.verdict === "exact" ? "Identical"
            : result.verdict === "probable" ? "Probable duplicate"
            : result.verdict === "distinct" ? "Distinct documents"
            : "Cannot compare"}
        </span>
        {percent !== null && <span className="text-sm font-semibold tabular-nums text-base-100">{percent}%</span>}
      </div>
      <p className="mt-1 leading-relaxed text-base-400">{result.explanation}</p>
    </div>
  );
}

/** Bulk "move this folder's files elsewhere" -- pages through every file
 * currently classified under fromSubjectId (direct membership only, same
 * as the Subjects page's own file list -- not recursive into
 * subcategories) and reclassifies each one, preserving its existing
 * document-type classification the same way MoveFileModal does. */
async function bulkMoveSubjectContents(fromSubjectId, toSubjectId, onProgress) {
  const limit = 200;
  let offset = 0;
  const all = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await api.get(`/subjects/${fromSubjectId}/documents`, { limit, offset });
    if (!page?.length) break;
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  let done = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < all.length) {
      const idx = cursor;
      cursor += 1;
      const f = all[idx];
      const detail = await api.get(`/files/${f.id}`);
      await api.patch(`/files/${f.id}`, {
        subjectId: toSubjectId,
        documentTypeId: detail?.latestClassification?.classified_document_type_id || null,
      });
      done += 1;
      onProgress?.(done, all.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, all.length || 1) }, worker));
  return all.length;
}
