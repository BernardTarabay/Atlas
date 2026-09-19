import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * Lets the assistant know what the user is currently looking at.
 *
 * The assistant lives in the app shell so it is available everywhere, but
 * "rename this file" only means something if it can see what "this" refers
 * to. Rather than the panel reaching into every page, each page PUBLISHES
 * its own context here and the panel reads whatever the current page put in.
 *
 * A page that publishes nothing simply gives the assistant no file context,
 * which is correct -- it will ask instead of guessing.
 */

const AssistantContext = createContext(null);

export function AssistantProvider({ children }) {
  const [context, setContext] = useState({ page: null, description: "", files: [], selectedSubjectId: null });
  // Bumped whenever a page asks the assistant to refresh its data after an
  // action was applied, so pages can react without the assistant needing a
  // direct reference to their reload functions.
  const [changeToken, setChangeToken] = useState(0);
  const notifyChanged = useCallback(() => setChangeToken((t) => t + 1), []);

  // "Show me where this lives." The assistant can find a file anywhere in the
  // corpus, but an answer in the chat panel is only half of it -- the useful
  // part is the map opening the branches above that file and lighting the
  // route to it. This is the channel for that request; a page that does not
  // implement it simply ignores it.
  //
  // Carries a counter alongside the id so asking for the SAME subject twice
  // still registers. Without it, a second request for a subject already
  // selected would be a no-op state write and nothing would move.
  const [reveal, setReveal] = useState({ subjectId: null, fileId: null, n: 0 });
  const revealSubject = useCallback(
    (subjectId, fileId = null) => setReveal((r) => ({ subjectId, fileId, n: r.n + 1 })),
    []
  );

  /**
   * "Open the assistant and start this sentence for me."
   *
   * The panel owns whether it is open and what is typed in it, which is right
   * -- but it leaves the rest of the app unable to hand the user into a
   * conversation. The Library's empty state needs exactly that: a new account
   * has no folders, and the useful next step is describing what they are going
   * to file rather than clicking "new folder" twelve times.
   *
   * The text is PREFILLED, not sent. It is a starting sentence the user is
   * meant to edit -- "I get invoices from clients" is a prompt to finish, not a
   * question to fire off. Sending it for them would put words in their mouth
   * and spend an API call on a sentence they did not write.
   *
   * Counter alongside the text for the same reason `reveal` has one: asking
   * twice with the same sentence must still register.
   */
  const [ask, setAsk] = useState({ text: null, n: 0 });
  const askAssistant = useCallback((text) => setAsk((a) => ({ text, n: a.n + 1 })), []);

  /* -------------------------------------------------------------------- *
   * ATTACHMENTS: the files the user has explicitly put in front of the
   * assistant, by dragging them onto it or picking "Ask Gemini about this".
   *
   * WHY THESE LIVE HERE AND NOT IN THE PANEL
   *
   * The panel is where they are shown, but it is not where they arrive. A
   * file is dragged from the Library or the Files table, and a context-menu
   * item on any page can add one -- so the state has to be reachable from
   * outside the panel, which is exactly what this provider is for.
   *
   * WHY THEY ARE NOT THE SAME THING AS `context.files`
   *
   * `context.files` is what a page HAPPENS to be showing: it changes when you
   * scroll, page, or navigate, and it is cleared on unmount. An attachment is
   * a deliberate act. Conflating them would mean a file you attached
   * disappeared the moment you clicked to a different folder to look at
   * something -- and the answer that came back would silently be about a
   * different set of documents than the one on screen when you asked. They
   * travel to the server as separate fields for the same reason.
   * -------------------------------------------------------------------- */

  /** More than this and the prompt is being stuffed rather than given context. */
  const MAX_ATTACHMENTS = 25;
  const [attachments, setAttachments] = useState([]);

  const attachFiles = useCallback((files) => {
    const incoming = (Array.isArray(files) ? files : [files]).filter((f) => f && f.id);
    if (!incoming.length) return { added: 0, duplicates: 0, overflow: 0 };
    let added = 0;
    let duplicates = 0;
    let overflow = 0;
    setAttachments((current) => {
      const seen = new Set(current.map((f) => f.id));
      const next = [...current];
      for (const f of incoming) {
        if (seen.has(f.id)) { duplicates += 1; continue; }
        if (next.length >= MAX_ATTACHMENTS) { overflow += 1; continue; }
        seen.add(f.id);
        next.push({ id: f.id, name: f.name || f.id, path: f.path || null });
        added += 1;
      }
      return added ? next : current;
    });
    // Returned rather than announced from in here: the caller knows whether a
    // duplicate is worth a toast (a drop, yes) or noise (restoring a session).
    return { added, duplicates, overflow };
  }, []);

  const detachFile = useCallback((id) => {
    setAttachments((current) => current.filter((f) => f.id !== id));
  }, []);

  const clearAttachments = useCallback(() => setAttachments([]), []);

  /**
   * "Open the assistant." A counter rather than a boolean, so asking twice in
   * a row registers twice -- the same reason `reveal` and `ask` carry one.
   * The panel still OWNS whether it is open; this is a request, not a setter.
   */
  const [openRequest, setOpenRequest] = useState(0);
  const openAssistant = useCallback(() => setOpenRequest((n) => n + 1), []);

  const value = useMemo(
    () => ({
      context, setContext, changeToken, notifyChanged, reveal, revealSubject, ask, askAssistant,
      attachments, attachFiles, detachFile, clearAttachments, openRequest, openAssistant,
    }),
    [context, changeToken, notifyChanged, reveal, revealSubject, ask, askAssistant,
     attachments, attachFiles, detachFile, clearAttachments, openRequest, openAssistant]
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant() {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used within AssistantProvider");
  return ctx;
}

/**
 * Publish the current page's context to the assistant.
 *
 * @param {object} value
 * @param {string} value.page            - human-readable page name, e.g. "Files"
 * @param {string} [value.description]   - one line on what is on screen
 * @param {Array}  [value.files]         - [{ id, filename, currentPath }]
 * @param {string} [value.selectedSubjectId]
 */
export function usePublishAssistantContext({ page, description = "", files = [], selectedSubjectId = null }) {
  const { setContext } = useAssistant();

  // Serialised so a page re-rendering with an equal-but-new array does not
  // loop: setContext -> provider re-render -> page re-render -> new array.
  const key = JSON.stringify({
    page,
    description,
    selectedSubjectId,
    files: files.map((f) => f.id),
  });
  const latest = useRef({ page, description, files, selectedSubjectId });
  latest.current = { page, description, files, selectedSubjectId };

  useEffect(() => {
    setContext(latest.current);
    // Clear on unmount so a stale page's files never leak into the next one.
    return () => setContext({ page: null, description: "", files: [], selectedSubjectId: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setContext]);
}

/**
 * Subscribe to "reveal this subject" requests from the assistant.
 * @param {(subjectId: string, fileId: string|null) => void} onReveal
 */
export function useAssistantReveal(onReveal) {
  const { reveal } = useAssistant();
  const seen = useRef(0);
  useEffect(() => {
    if (reveal.n === seen.current || !reveal.subjectId) return;
    seen.current = reveal.n;
    onReveal?.(reveal.subjectId, reveal.fileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);
}

/** Re-run something whenever the assistant applied an action. */
export function useAssistantChanges(onChanged) {
  const { changeToken } = useAssistant();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    onChanged?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeToken]);
}

/**
 * Receive "open up and start this sentence" requests. The panel implements it;
 * nothing else needs to know how the panel is opened.
 */
export function useAssistantAsk(onAsk) {
  const { ask } = useAssistant();
  const handler = useRef(onAsk);
  handler.current = onAsk;
  useEffect(() => {
    if (ask.n === 0 || !ask.text) return;
    handler.current?.(ask.text);
  }, [ask]);
}

/**
 * Receive "open the assistant" requests. Separate from useAssistantAsk because
 * attaching a file should raise the panel WITHOUT putting words in the user's
 * message box -- the whole point of an attachment is that the question is
 * still theirs to write.
 */
export function useAssistantOpen(onOpen) {
  const { openRequest } = useAssistant();
  const handler = useRef(onOpen);
  handler.current = onOpen;
  useEffect(() => {
    if (openRequest === 0) return;
    handler.current?.();
  }, [openRequest]);
}
