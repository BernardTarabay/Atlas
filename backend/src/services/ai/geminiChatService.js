// Subjects-page chatbot (docs/08-api-contracts.md §9.10).
//
// Deliberately NOT a function-calling / tool-execution loop. The product
// decision here is "confirm first": this service only ever returns a
// conversational reply plus a list of PROPOSED actions as structured JSON
// (same response_format trick geminiClassifier.js uses to get a closed,
// parseable shape out of the model). Nothing is executed server-side --
// the frontend renders each action as a card and only calls the normal
// REST endpoints (PATCH /files/:id, POST/PATCH/DELETE /subjects) once a
// human clicks Apply. That also means this file never needs write access
// to anything; it's pure read (taxonomy + visible files) in, JSON out.
const env = require("../../config/env");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

const MAX_HISTORY_TURNS = 10;
const MAX_VISIBLE_FILES = 200;

const ACTION_TYPES = [
  "move_file", "rename_file", "delete_file",
  // move_by_filter is move_subject_contents' general case: it files everything
  // MATCHING criteria rather than everything currently in one folder. The
  // difference matters at scale -- "every 2019 invoice from the old NAS" is not
  // a folder, and enumerating it as thousands of move_file actions is not a
  // plan the model can produce or the user can review.
  "move_subject_contents", "move_by_filter",
  "create_subject", "rename_subject", "delete_subject",
  "approve_proposals", "reject_proposals", "resolve_duplicates",
  // Read-only. Run as soon as they are proposed instead of waiting for an
  // Apply click -- see READ_ONLY_ACTIONS below.
  "compare_files", "find_files",
];

/**
 * Actions that only READ. The frontend executes these immediately and shows
 * the answer, rather than rendering an Apply button.
 *
 * The confirm-first rule exists to stop the model changing things nobody
 * agreed to. Asking "how similar are these two files?" changes nothing, so
 * making the user click Apply to receive an answer they already asked for
 * is friction pretending to be safety.
 */
const READ_ONLY_ACTIONS = ["compare_files", "find_files"];

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description: "Your conversational reply to the user, in plain language. Explain what you're proposing (if anything) and why, or ask a clarifying question if you're missing information (e.g. an ID for something the user referenced that isn't in the provided lists).",
    },
    actions: {
      type: "array",
      description: "Zero or more proposed actions. These are PROPOSALS ONLY -- a human reviews and clicks Apply on each one, nothing happens automatically. It's fine to propose several at once for a bulk request.",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ACTION_TYPES },
          summary: { type: "string", description: "One short, human-readable sentence describing exactly what this action does, e.g. 'Move Invoice_2024.pdf to Finance > Invoices' or 'Move all 12 files in Scans > Unsorted to Personal > Medical'. Write it in the SAME language the user is using -- these English examples show the shape, not the language. Keep file and subject names in their original script." },
          fileId: { type: ["string", "null"], description: "Required for move_file -- must be an id from the provided visible-files list, never invented." },
          fromSubjectId: { type: ["string", "null"], description: "Required for move_subject_contents -- the subject whose files are being moved out." },
          toSubjectId: { type: ["string", "null"], description: "Required for move_file, move_subject_contents and move_by_filter -- the destination subject." },
          filter: {
            type: ["object", "null"],
            description: "Required for move_by_filter -- WHICH files to move, by criteria rather than by id. Every field is optional and they combine as AND. Omit a field entirely rather than sending null or an empty string. At least one field must be set: an empty filter would move the entire repository and is refused. `q` expresses what the files are ABOUT and can be used on its own.",
            properties: {
              q: { type: ["string", "null"], description: "WHAT THE FILES ARE ABOUT, in the user's own words -- 'invoices from the Marina project', '2025 financial reports', 'anything about the roof repair'. Matched against filenames, document contents AND each file's description, by meaning as well as wording, so it works for photos, video and audio too. Use this whenever the user describes the files by subject rather than by a structured property. Combines with the other fields as AND." },
              ext: { type: ["string", "null"], description: "File extensions, comma-separated, without dots: 'pdf' or 'pdf,docx'. Use 'none' for files that have no extension." },
              dateFrom: { type: ["string", "null"], description: "Earliest DOCUMENT date, YYYY-MM-DD. This is the date the document is FROM (read out of the file), not when it was imported. Inclusive." },
              dateTo: { type: ["string", "null"], description: "Latest document date, YYYY-MM-DD. Inclusive of the whole of that day. For a whole year use dateFrom 2019-01-01 and dateTo 2019-12-31." },
              subjectId: { type: ["string", "null"], description: "Only files currently filed under this subject, INCLUDING everything nested beneath it. This narrows WHICH files move; it is not the destination. Omit it to match files wherever they are filed, which is usually what 'all my invoices' means." },
              documentTypeId: { type: ["string", "null"], description: "Only files carrying this document type (the what-KIND-of-thing axis, independent of where a file is filed)." },
              storageLocationId: { type: ["string", "null"], description: "Only files found in this registered storage location -- 'the old NAS', 'the external drive'." },
              pathPrefix: { type: ["string", "null"], description: "Only files whose folder path inside their storage location starts with this, e.g. 'Archives/2019'." },
              unfiled: { type: ["boolean", "null"], description: "true to match only files that are not filed under any subject yet -- the unsorted pile. Cannot be combined with subjectId." },
            },
          },
          subjectId: { type: ["string", "null"], description: "Required for rename_subject and delete_subject -- the subject being changed." },
          parentSubjectId: { type: ["string", "null"], description: "For create_subject -- the parent subject/category to nest under, or null for a new top-level Subject." },
          name: { type: ["string", "null"], description: "For create_subject (new name) and rename_subject (new name)." },
          description: { type: ["string", "null"], description: "For create_subject -- one sentence saying what belongs in this folder, in the user's own terms. This is not decoration: the classifier reads it when deciding where future documents go, and it outranks the folder's name. Write what a person would need to know to file correctly -- 'Deeds and correspondence for the Haifa monastery, including anything mentioning Mount Carmel' is useful; 'Folder for Haifa Monastery' is not. Include exclusions when the user states them. Omit it only if the name is genuinely self-explanatory." },
          newFilename: { type: ["string", "null"], description: "For rename_file -- the new filename INCLUDING its extension, and never containing a path separator. Keep the original extension unless the user explicitly asks to change it." },
          fileIdA: { type: ["string", "null"], description: "For compare_files -- the first file, from the visible-files list." },
          fileIdB: { type: ["string", "null"], description: "For compare_files -- the second file, from the visible-files list. Must differ from fileIdA." },
          minConfidence: { type: ["number", "null"], description: "For approve_proposals -- only approve pending rename proposals whose confidence score is at or above this, between 0 and 1. If the user says 'above 90%' or 'over 0.9', that is 0.9." },
          maxConfidence: { type: ["number", "null"], description: "For reject_proposals -- discard pending rename proposals whose confidence score is at or BELOW this, between 0 and 1. 'the 0% ones' or 'the useless ones' is 0. 'anything under 20%' is 0.2." },
          query: { type: ["string", "null"], description: "For find_files -- what the user is looking for, as a DESCRIPTION rather than a keyword list. The search matches meaning, not just words, so 'a photo of a child blowing out birthday candles' works better than 'birthday candles' and much better than 'birthday'. Keep the user's own descriptive phrasing, drop only true filler like 'can you find me'. You do NOT need to guess the document's language -- an English description finds a French or Arabic document. Do include any exact names, numbers or reference codes the user gave, since those are matched literally as well." },
        },
        required: ["type", "summary"],
      },
    },
  },
  required: ["reply", "actions"],
};

const SYSTEM_INSTRUCTION = `You are a helpful assistant embedded in a document management system, available on every
page. You help the user find, rename, reclassify and tidy their documents by conversation
instead of clicking through menus.

You are told which page the user is currently looking at and what is on screen there. Use
that: on the Files page "this file" most likely means one they can see in the list; on the
Subjects page it probably means one under the selected subject. If the reference is
genuinely ambiguous, ask rather than guess.

The folder tree is the USER'S, not a fixed taxonomy. They can nest as deep as they like
(up to 12 levels, a guard rail against runaway nesting, not a shape you should design
around), name folders anything, and delete or rename the six that shipped as defaults --
Academic, Administrative, Finance, Legal, Personal, Reference are starting suggestions,
not a structure to file everything into. If someone wants "Tables", "Boat stuff" or
"2019 - Q3 - reconciled", help them build exactly that. Never talk the user back toward
the default folders, and never tell them a folder "doesn't fit the taxonomy".

Files are never attached to the tree structurally -- each file has a "classification"
pointing at exactly one folder, and "moving a file" or "moving a folder's contents" just
means changing which folder it points at. Nothing about the tree shape changes when files
move.

Document type is a SEPARATE, independent axis from where a file is filed. A file being of
type Invoice does not mean it belongs in a folder called Invoices -- type says what KIND
of thing a document is, the folder says where the user chose to keep it. Use type as a
way to FIND files (a filter), never as a reason to file them somewhere.

You will be given the full current subject tree (id, level, path, name) and whatever
files are currently visible in the user's UI (id, filename, path). You can ONLY reference
subject ids and file ids that appear in those lists -- never invent, guess, or reuse an id
from earlier in the conversation if it's not in the CURRENT lists (the tree can change
between turns as actions get applied). If the user refers to a file or folder you can't
find in the provided lists, say so in your reply and ask them to select that subject (so
its files become visible) or search for the file, rather than proposing an action with a
made-up id.

Every action you propose is shown to the user as a card with Apply/Reject buttons -- you
never change anything directly. This means: it's fine, and encouraged, to propose several
actions at once for a bulk instruction ("move all the scanned receipts into Finance"),
and it's fine to propose an action you're not 100% sure about as long as your reply
explains the uncertainty -- the user has the final say before anything happens.

Action types:
- move_file: move one specific file to a different subject. Needs fileId, toSubjectId.
- rename_file: give one file a new name. Needs fileId, newFilename. On a read-only storage
  location this records the name the system will use and shows it in the organized folder;
  the original file on disk is never renamed. Keep the extension.
- delete_file: remove one file from the repository. Needs fileId. This marks it deleted in
  the app -- it does NOT erase anything from disk. Still, only propose it when the user
  clearly asked for that specific file to go.
- move_subject_contents: move every file currently classified directly under one subject
  to a different subject (this is what "move this folder into that subcategory" means --
  it does not restructure the tree, only reclassifies the files in it). Needs
  fromSubjectId, toSubjectId.
- move_by_filter: file every document MATCHING CRITERIA into one folder, wherever those
  documents currently sit. Needs filter and toSubjectId. This is the right action for
  "put all my 2019 invoices in Archive/2019", "move everything from the old NAS into
  Imported", "file every PDF in the unsorted pile under Documents" -- anything phrased as
  a rule rather than as a list. Prefer it strongly over proposing many move_file actions:
  it is one reviewable card instead of thousands, it runs as a background job the user can
  watch, and it catches files that are not currently on screen. The filter uses the same
  fields as the app's own filter bar, PLUS 'q' for what the files are about. Set only the
  fields the user actually specified.

  'q' is the important one for instructions like "move everything related to project X into
  the Project X folder", "file the 2025 financial reports under Financial Reports", or "put
  anything with invoice in the name into Invoices". It is matched against filenames, the
  text inside documents, and every file's stored description -- by MEANING as well as
  wording -- which is the same search find_files runs. So a request phrased by subject is a
  move_by_filter with 'q', not a refusal and not a hand-listed pile of move_file actions.
  Pass the user's description in full; cutting it to two keywords throws away the meaning
  matching that makes it work.

  Combine 'q' with the structured fields when the user gave both: "every PDF about the
  Marina lease" is 'q' plus 'ext=pdf'. The card still tells the user how many files matched
  before anything moves, so a broad 'q' is visible rather than silent.
- create_subject: create a new folder anywhere in the tree. Needs name, plus
  parentSubjectId (the folder to nest inside) or null for a new top-level folder. Nest as
  deep as the user's structure calls for. When someone describes how they want to organize
  things, propose the whole set of folders at once rather than one at a time.
  ALSO write a "description" whenever the user has told you what goes in the folder. The
  classifier reads it when filing future documents, so a sentence here is the difference
  between a folder that fills itself and one the user has to fill by hand. Put what they
  said into it -- if they tell you "invoices from suppliers, not client ones", that
  distinction belongs in the description, not just in your reply.
- rename_subject: change a subject's display name only. Needs subjectId, name.
- compare_files: measure how similar two files' contents are, and report the percentage.
  Needs fileIdA and fileIdB, both from the visible-files list. This one only READS -- it
  runs immediately and the answer appears in the chat, so propose it freely whenever the
  user asks whether two documents are the same, near-duplicates, or how alike they are.
  Do not guess a number yourself; propose the action and let the real comparison answer.
- approve_proposals: approve every PENDING rename proposal at or above a confidence score.
  Needs minConfidence (0 to 1). Use this for "accept everything above 90%", "approve the
  high-confidence renames", and similar. Approving queues the rename to be applied, so
  this one does need the user's confirmation -- the card will tell them how many match
  before they commit.
- find_files: search the WHOLE repository for a document the user is describing. Needs query.
  This is the one action that is not limited to the visible-files list -- use it whenever the
  user describes a document rather than naming one you can already see ("find the lease for
  the Marina site", "where's the invoice from that supplier", "I'm looking for a letter about
  the roof"). It runs immediately and the results appear in the chat, each one clickable to
  reveal where that file sits in the subject map.

  It searches FOUR things at once: filenames, the text inside documents, and each file's
  stored description -- both by wording and by MEANING. Every file has a description of what
  it is, including photos, videos and audio recordings, which have no text at all. So this
  action works for "the video of the kids at the beach" and "the picture of a handwritten
  recipe", not only for text documents. Pass the user's description in full; meaning-matching
  is what makes it work, and reducing it to two keywords throws that away.

  Prefer this over telling the user you cannot find something: search first, then report. If
  the results look wrong, say so and suggest better terms rather than inventing a match. When
  a result matched on its description rather than its contents, the card says so -- if the
  user seems to be after something else, that is the thing to point out.
- reject_proposals: discard every PENDING rename proposal at or BELOW a confidence score.
  Needs maxConfidence (0 to 1). This is the cleanup counterpart to approve_proposals, for
  "get rid of the 0% ones", "clear the junk suggestions", "reject anything under 20%".
  Rejecting is safe -- it changes no file and queues no work, it just declines the
  suggestion -- but it is still bulk, so the card tells the user how many match first.
- resolve_duplicates: resolve every open EXACT (100% identical) duplicate group at once by
  picking a canonical copy in each. Takes no parameters. Use it for "resolve all the exact
  duplicates" or "clean up the 100% duplicates". It never deletes anything -- it only marks
  which copy is the one to treat as primary. It deliberately does NOT touch "probable"
  duplicates, which are similarity guesses a human has to confirm; if the user asks you to
  resolve those, explain that and propose nothing.
- delete_subject: needs subjectId. Only propose this when the user clearly wants it gone
  (deletion is blocked server-side if the subject still has children or files, so don't
  worry about checking that yourself -- just be conservative about proposing it at all).

LANGUAGE. Write "reply" and every action "summary" in the SAME language the user typed
their latest message in. Nothing else decides this.

In particular, the DOCUMENTS ARE NOT A LANGUAGE SIGNAL. The file names, subject names and
extracted text in this repository are largely French and Arabic. That is a fact about the
user's files, not about the conversation, and it must never pull your reply into French or
Arabic. A user who writes to you in English gets an English answer even when every single
filename around it is French. Only the user's own words count.

These instructions being in English is likewise not a signal.

If the user writes in Hebrew, answer in Hebrew; Arabic, answer in Arabic; French, French;
English, English. When their message is too short to tell (an id, "yes", "ok"), keep using
the language of the conversation so far.

Keep file names, subject names and paths exactly as they appear in the lists above, in
their original script, even when the surrounding sentence is in another language -- never
transliterate or translate them, because the user has to be able to match what you say
against what is on screen.

Keep replies concise and conversational. Respond only with the requested JSON.`;

class GeminiChatError extends Error {
  constructor(message) {
    super(message);
    // Surfaced straight to the chat panel's toast (via the central error
    // handler's err.publicMessage) -- 502 since this is always an upstream
    // (Gemini) failure, not something wrong with the request itself.
    this.statusCode = 502;
    this.publicMessage = message;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelayMs(bodyText) {
  const match = /retry in ([\d.]+)s/i.exec(bodyText || "");
  if (!match) return null;
  return Math.ceil(parseFloat(match[1]) * 1000) + 500;
}

const MAX_429_RETRIES = 2;

/**
 * A hard, per-request signal for what script the user actually typed in.
 *
 * The system instruction already says "reply in the user's language", and it
 * still drifted into French, because every filename in the surrounding
 * context is French and a prompt rule is a suggestion competing with a very
 * loud pattern. Naming the script explicitly on each turn gives the model
 * something specific to obey instead of something to infer.
 *
 * Script, not language: distinguishing English from French reliably needs a
 * real classifier, and guessing wrong would be worse than not guessing. What
 * this does catch is the case that was actually breaking -- Latin-script
 * input being answered in French because the documents are French.
 */
function detectScript(text) {
  const s = String(text || "");
  // \u escapes, not literal characters: the ranges below are invisible or
  // ambiguous in most editors and diffs, and a mangled range would silently
  // misdetect rather than fail loudly.
  if (/[؀-ۿݐ-ݿ]/.test(s)) return "Arabic";
  if (/[֐-׿]/.test(s)) return "Hebrew";
  if (/[Ѐ-ӿ]/.test(s)) return "Cyrillic";
  if (/[一-鿿぀-ヿ]/.test(s)) return "CJK";
  if (/[A-Za-z]/.test(s)) return "Latin";
  return null;
}

function languageDirective(message) {
  const script = detectScript(message);
  if (!script) return "";
  if (script === "Latin") {
    return (
      `\nLANGUAGE CHECK: the user's message below is in the Latin script. Reply in the ` +
      `same language they wrote it in -- if it is English, reply in English. Do NOT switch ` +
      `to French because the file names are French.\n`
    );
  }
  return `\nLANGUAGE CHECK: the user's message below is written in ${script}. Reply in that same language.\n`;
}

function buildInput({ message, history, subjectTree, visibleFiles, selectedSubject, pageContext }) {
  const treeText = subjectTree.length
    ? subjectTree.map((s) => `- id: ${s.id} | level: ${s.level} | path: ${s.materialized_path} | name: ${s.name}`).join("\n")
    : "(no subjects defined yet)";

  /**
   * One line per file, and the description is the half that matters.
   *
   * This line used to be id + filename + an always-empty path, which made the
   * filename the only thing the model could reason about. On an archive whose
   * files are called "WhatsApp Image 2026-07-29 at 20.17.33.jpeg" that is
   * nothing: the assistant could find that file if you typed its WhatsApp name
   * and not if you described what was in it, which is backwards from how
   * anybody remembers a photo.
   *
   * Fields are omitted rather than emitted empty. A line reading `path:  |
   * subject:` teaches the model that these are usually blank, and it starts
   * ignoring them where they are not.
   */
  const trimmedFiles = visibleFiles.slice(0, MAX_VISIBLE_FILES);
  /**
   * The count, stated separately from the lines themselves.
   *
   * A model reading a two-hundred-line list is being asked to count marked
   * entries in order to know how many "these" refers to, which it does
   * unreliably -- and a wrong count here produces an answer that confidently
   * covers three of four attached documents. Saying the number costs one line.
   */
  const attachedCount = trimmedFiles.filter((f) => f.attached).length;
  const attachedNote = attachedCount
    ? `\n\nThe user attached ${attachedCount} document${attachedCount === 1 ? "" : "s"} to this message (marked ATTACHED BY THE USER above).`
    : "";
  const fileLine = (f) => {
    const parts = [`id: ${f.id}`, `filename: ${f.filename}`];
    // FIRST, not last, and before the filename is even read: the model has to
    // know which of these the user pointed at before it starts matching a
    // request against a list of two hundred. A flag buried after the
    // description is a flag that arrives too late to change the answer.
    if (f.attached) parts.splice(1, 0, "ATTACHED BY THE USER");
    if (f.currentPath) parts.push(`path: ${f.currentPath}`);
    if (f.subjectName) parts.push(`subject: ${f.subjectName}`);
    if (f.waitingBecause) parts.push(`waiting: ${f.waitingBecause}`);
    // Last, and labelled, because it is prose sitting in a pipe-delimited row.
    if (f.description) parts.push(`description: ${f.description}`);
    return `- ${parts.join(" | ")}`;
  };
  const filesText = trimmedFiles.length
    ? trimmedFiles.map(fileLine).join("\n")
    : "(none currently visible in the UI -- if the user references a specific file, ask them to select its subject first)";

  const recentHistory = history.slice(-MAX_HISTORY_TURNS);
  const historyText = recentHistory.length
    ? recentHistory.map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text}`).join("\n")
    : "(this is the first message)";

  const where = pageContext?.page
    ? `The user is currently on the "${pageContext.page}" page.` +
      (pageContext.description ? ` ${pageContext.description}` : "")
    : "";

  return `${where}

Current subject taxonomy (id | level | path | name):
${treeText}

Files you can act on${selectedSubject ? ` -- including those under the currently selected subject "${selectedSubject.name}" (id: ${selectedSubject.id})` : ""}.
These are the documents matching the user's message, plus what is on screen and
what is waiting to be filed. Each line gives an id and a filename, and where
they are known, the folder path, the subject it is filed under, why it is
waiting, and a DESCRIPTION of what the file actually contains. Most filenames
in this archive are meaningless (camera and WhatsApp exports), so match the
user's request against the description first and the filename second.

Any line marked ATTACHED BY THE USER was deliberately handed to you for THIS
message. When the user says "this", "these", "them" or "the attached", they
mean those and only those -- do not widen the request to similar-looking files
from the rest of the list. If they ask a general question and attachments are
present, answer about the attachments first and say so:
${filesText}${attachedNote}

Conversation so far:
${historyText}
${languageDirective(message)}
User: ${message}`;
}

function extractOutputText(interaction) {
  const steps = interaction.steps || [];
  const outputSteps = steps.filter((s) => s.type === "model_output");
  const lastOutput = outputSteps[outputSteps.length - 1];
  if (!lastOutput) return null;
  return lastOutput.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

async function callGemini(args, attempt = 1) {
  if (!env.ai.apiKey) {
    throw new GeminiChatError("GEMINI_API_KEY is not set -- the chatbot is unavailable until it is.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.ai.timeoutMs);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-goog-api-key": env.ai.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.ai.chatModel,
        system_instruction: SYSTEM_INSTRUCTION,
        input: buildInput(args),
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: RESPONSE_SCHEMA,
        },
        generation_config: {
          // Deciding which action(s) to propose from a free-form instruction
          // benefits from a bit more deliberation than the bounded
          // classification task -- "low" instead of classifier's "minimal".
          thinking_level: "low",
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new GeminiChatError(`Gemini request timed out after ${env.ai.timeoutMs}ms.`);
    }
    throw new GeminiChatError(`Gemini request failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    if (response.status === 429 && attempt <= MAX_429_RETRIES) {
      const retryMs = parseRetryDelayMs(bodyText) ?? 5_000 * attempt;
      await sleep(retryMs);
      return callGemini(args, attempt + 1);
    }
    throw new GeminiChatError(`Gemini API returned ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  const interaction = await response.json();
  const outputText = extractOutputText(interaction);
  if (!outputText) {
    throw new GeminiChatError("Gemini response had no text output to parse.");
  }

  try {
    return JSON.parse(outputText);
  } catch (err) {
    throw new GeminiChatError(`Gemini response was not valid JSON: ${err.message}`);
  }
}

/**
 * @param {string} message - the user's new message
 * @param {{role: 'user'|'assistant', text: string}[]} history - prior turns, oldest first
 * @param {object[]} subjectTree - full, server-fetched (authoritative) subject list
 * @param {{id: string, filename: string, currentPath?: string}[]} visibleFiles
 * @param {object|null} selectedSubject
 */
async function chat({
  message, history = [], subjectTree = [], visibleFiles = [],
  selectedSubject = null, pageContext = null,
}) {
  const trimmedMessage = String(message || "").trim();
  if (!trimmedMessage) {
    throw new GeminiChatError("message is required.");
  }

  const result = await callGemini({
    message: trimmedMessage, history, subjectTree, visibleFiles, selectedSubject, pageContext,
  });

  const subjectIds = new Set(subjectTree.map((s) => s.id));
  const fileIds = new Set(visibleFiles.map((f) => f.id));

  // Defense in depth on top of the system instruction: never let a
  // hallucinated id reach the frontend as something clickable. An action
  // referencing an id outside the lists we just gave the model is dropped
  // rather than shown -- the user still gets the conversational reply.
  const actions = Array.isArray(result.actions)
    ? result.actions.filter((a) => actionReferencesKnownIds(a, subjectIds, fileIds))
    : [];

  return {
    reply: String(result.reply || "").trim() || "(no reply)",
    actions,
  };
}

function actionReferencesKnownIds(action, subjectIds, fileIds) {
  if (!action || !ACTION_TYPES.includes(action.type)) return false;
  switch (action.type) {
    case "move_file":
      return Boolean(action.fileId && fileIds.has(action.fileId) && action.toSubjectId && subjectIds.has(action.toSubjectId));
    case "rename_file":
      // A separator in the name would redirect the rename into another
      // directory -- the server rejects it too, but a proposal the user
      // cannot safely click should never reach the screen.
      return Boolean(
        action.fileId && fileIds.has(action.fileId) &&
        action.newFilename && !/[\\/]/.test(action.newFilename)
      );
    case "delete_file":
      return Boolean(action.fileId && fileIds.has(action.fileId));
    case "compare_files":
      return Boolean(
        action.fileIdA && fileIds.has(action.fileIdA) &&
        action.fileIdB && fileIds.has(action.fileIdB) &&
        action.fileIdA !== action.fileIdB
      );
    case "approve_proposals": {
      // A missing or nonsensical threshold would silently approve
      // everything, which is the one outcome nobody asked for.
      const min = Number(action.minConfidence);
      return Number.isFinite(min) && min >= 0 && min <= 1;
    }
    case "reject_proposals": {
      // Same reasoning inverted. Note 0 is the ENTIRE point of this action
      // ("clear the 0% ones"), so it must be checked with Number.isFinite
      // rather than a truthiness test that would throw the common case away.
      const max = Number(action.maxConfidence);
      return Number.isFinite(max) && max >= 0 && max <= 1;
    }
    case "resolve_duplicates":
      // Takes no ids and no threshold: it always means "every open exact
      // group", and the server re-enforces exact-only regardless.
      return true;
    case "find_files":
      // Deliberately NOT checked against the visible-files list -- searching
      // the whole repository is the entire point, and the query is free text
      // rather than an id, so there is nothing here to hallucinate.
      return Boolean(String(action.query || "").trim());
    case "move_subject_contents":
      return Boolean(
        action.fromSubjectId && subjectIds.has(action.fromSubjectId) &&
        action.toSubjectId && subjectIds.has(action.toSubjectId) &&
        action.fromSubjectId !== action.toSubjectId
      );
    case "move_by_filter": {
      // The destination is the only id here that MUST be real, and it is
      // checked against the tree we just supplied for the same reason every
      // other case is: a hallucinated folder id would render as an Apply
      // button that files thousands of documents somewhere that does not
      // exist. `filter.subjectId` is checked too when present -- it narrows
      // the set, so a wrong one silently moves a different set of files.
      if (!action.toSubjectId || !subjectIds.has(action.toSubjectId)) return false;
      const filter = action.filter;
      if (!filter || typeof filter !== "object") return false;
      if (filter.subjectId && !subjectIds.has(filter.subjectId)) return false;
      // Filtering by a folder and filing into the same folder is a no-op the
      // model sometimes proposes when the user says "tidy up Finance".
      if (filter.subjectId && filter.subjectId === action.toSubjectId) return false;
      // An empty filter means the whole repository. The server refuses it too,
      // but a card that cannot possibly apply should never be offered.
      const meaningful = ["ext", "dateFrom", "dateTo", "subjectId", "documentTypeId", "storageLocationId", "pathPrefix"]
        .some((k) => filter[k] !== undefined && filter[k] !== null && String(filter[k]).trim() !== "");
      return meaningful || filter.unfiled === true;
    }
    case "create_subject":
      return Boolean(action.name) && (action.parentSubjectId ? subjectIds.has(action.parentSubjectId) : true);
    case "rename_subject":
      return Boolean(action.subjectId && subjectIds.has(action.subjectId) && action.name);
    case "delete_subject":
      return Boolean(action.subjectId && subjectIds.has(action.subjectId));
    default:
      return false;
  }
}

// `buildInput` is exported for verification only. What reaches the model is
// the one thing here with no other way to observe it, and the failure it hides
// is silent by nature: the file line read `f.currentPath` while the controller
// set `path`, so the location rendered as empty on every row for as long as
// that mismatch existed, with nothing anywhere to say so. A field name is not
// a contract until something checks it.
// See scripts/verify-assistant-retrieval.js.
module.exports = { chat, buildInput, GeminiChatError, ACTION_TYPES, READ_ONLY_ACTIONS, detectScript };
