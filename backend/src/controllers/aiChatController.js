const subjectService = require("../services/subjectService");
const fileRepository = require("../repositories/fileRepository");
const fileDescriptionRepository = require("../repositories/fileDescriptionRepository");
const triageRepository = require("../repositories/triageRepository");
const descriptionSearchService = require("../services/descriptionSearchService");
const { parseFileFilters } = require("../repositories/fileFilters");
const geminiChatService = require("../services/ai/geminiChatService");
const { ValidationError } = require("../validators/validationError");

/**
 * How many search hits to put in front of the model.
 *
 * Enough that a real question is answerable, small enough that retrieval never
 * crowds out the page context and the backlog -- those say what the user is
 * LOOKING at, which the search cannot know.
 */
const RETRIEVED_FILE_LIMIT = 30;

/**
 * How many documents may be ATTACHED to one message.
 *
 * Deliberately far below the page-context bound. An attachment is a deliberate
 * act with a person behind it -- nobody drags four hundred files onto a chat
 * bubble on purpose -- so a number this size is not a limit anyone will meet,
 * and it is small enough that a client cannot use the field to stuff the
 * prompt. The frontend caps at the same figure and says so when a drop would
 * exceed it, so the two agree rather than one silently truncating the other.
 */
const MAX_ATTACHMENTS = 25;

/** Descriptions are prose and the prompt is shared; one sentence is the useful part. */
const MAX_DESCRIPTION_CHARS = 220;

function trimDescription(text) {
  if (!text) return null;
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_DESCRIPTION_CHARS) return clean;
  return `${clean.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

/**
 * The subject tree is always fetched fresh from the DB here rather than
 * trusted from the request body -- the frontend already has it loaded
 * (SubjectsPage's useApiData), but re-fetching means a stale client can't
 * feed the model an out-of-date tree and get confidently wrong proposals
 * about ids that no longer exist.
 *
 * `context.files` USED to be passed straight through on the reasoning that it
 * is only read context and every proposed action is re-validated at Apply
 * time. That is still true of the ACTIONS, but it was wrong about the
 * CONVERSATION: a client could put any file ids it liked in the context, and
 * the model would then describe those documents -- filename, path, subject --
 * back in its reply. The reply is not validated by anything, so it became a
 * read oracle for another account's files, reachable without ever clicking
 * Apply.
 *
 * So the visible-file list is now filtered to files the caller actually owns
 * before it reaches the model. Anything else is dropped silently, which is
 * correct here: it is context, not a request, and a client sending ids it
 * does not own is either stale or probing.
 */
async function chat(req, res) {
  const { message, history, context } = req.body || {};
  if (!message || !String(message).trim()) {
    throw new ValidationError("message is required.");
  }

  const subjectTree = await subjectService.list({}, req.user.id);
  const selectedSubject = context?.selectedSubjectId
    ? subjectTree.find((s) => s.id === context.selectedSubjectId) || null
    : null;

  // Bounded before the database sees it -- an unbounded id list would be a
  // free full-table read dressed up as page context.
  const requestedIds = (Array.isArray(context?.files) ? context.files : [])
    .map((f) => f?.id)
    .filter((id) => typeof id === "string")
    .slice(0, 200);

  const ownedFiles = requestedIds.length
    ? await fileRepository.listByIdsForOwner(requestedIds, req.user.id)
    : [];

  /**
   * ATTACHMENTS: the documents the user explicitly handed over.
   *
   * These arrive in their own field rather than mixed into `context.files`,
   * and the distinction is the whole feature. `context.files` is whatever the
   * page happens to be rendering -- it changes when you scroll or page, and
   * the model is told it is "what is on screen". An attachment is a person
   * pointing at four specific documents and saying "these". If the two shared
   * a field, "summarise these" would resolve against a hundred rows the
   * Library happened to be listing, and the answer would look plausible and be
   * about the wrong documents.
   *
   * Owner-scoped by exactly the same rule, for exactly the same reason: the
   * model describes these files back in its reply, and the reply is not
   * validated by anything, so an unfiltered id list here would be a read
   * oracle for another account's documents that never needs an Apply click.
   *
   * Unlike page context, though, a dropped id is NOT dropped silently. Page
   * context that goes stale is noise; an attachment that goes missing changes
   * what the answer is about, and the user is entitled to know their file was
   * left out. `attachmentsUsed` in the response is that answer.
   */
  const attachmentIds = (Array.isArray(context?.attachments) ? context.attachments : [])
    .map((f) => f?.id)
    .filter((id) => typeof id === "string")
    .slice(0, MAX_ATTACHMENTS);

  const attachedRows = attachmentIds.length
    ? await fileRepository.listByIdsForOwner(attachmentIds, req.user.id)
    : [];

  const describe = (f) => ({
    id: f.id,
    filename: f.canonical_filename || f.filename_current,
    // `currentPath`, not `path`. The prompt builder reads `f.currentPath`
    // (geminiChatService.buildInput), so a key named `path` rendered as an
    // empty string on every line -- the location was computed here, carried
    // all the way to the template, and silently dropped. Same for the subject,
    // which was never read at all.
    currentPath: f.current_path || null,
    subjectName: f.subject_name || null,
  });

  const visibleFiles = ownedFiles.map(describe);
  const attachedFiles = attachedRows.map((f) => ({ ...describe(f), attached: true }));

  /**
   * WHAT THE USER IS ASKING ABOUT, NOT ONLY WHAT THEY ARE LOOKING AT.
   *
   * The assistant had no retrieval step at all. Its entire world was the page
   * context plus the backlog below -- at most a couple of hundred files out of
   * thousands -- and each one reached the model as a bare filename. So asking
   * for "the photo of two people hugging in a kitchen" failed while asking for
   * "WhatsApp Image 2026-07-29" succeeded, and the difference was not search
   * quality: the description was never sent, and the file was usually not in
   * the context in the first place. The only string the model could match on
   * was the filename.
   *
   * The archive already knows how to answer that question --
   * descriptionSearchService fuses meaning, description wording and
   * content/filename, and it finds both of those files from a paraphrase. It
   * simply was never wired to the assistant. This is that wire.
   *
   * Failure is non-fatal on purpose. If the embedding call cannot be made (no
   * key, daily cap reached) the semantic half reports `ran: false` and the
   * lexical description half still runs, so retrieval degrades to keyword
   * matching over descriptions rather than disappearing. A search that throws
   * outright must not take the conversation down with it -- the assistant is
   * still useful with only the page in front of it, which is what it had
   * before this existed.
   */
  const retrievedFiles = await descriptionSearchService
    .search(String(message).trim(), {
      filters: parseFileFilters({}, req.user.id),
      limit: RETRIEVED_FILE_LIMIT,
    })
    .then((r) => r.files.map((f) => ({ ...describe(f), foundBy: "search" })))
    .catch(() => []);

  /**
   * THE UNFILED BACKLOG, ALWAYS IN SCOPE.
   *
   * Whatever page you are on, "put the passport scan in Personal" has to
   * work. Before this, the assistant only saw `context.files` -- whatever the
   * current page happened to have rendered -- so on the Dashboard it could see
   * nothing, and on Triage or Photos it saw whatever those pages sent, which
   * was nothing at all. It could not act on the two piles that most need
   * acting on.
   *
   * So the files actually waiting for a decision are always included: the
   * triage queue and the unreviewed photos. These are precisely the documents
   * the user is likely to be talking about, and they are the ones the
   * assistant is useless without.
   *
   * Bounded, and owner-scoped by the repository queries themselves. Deduped
   * against the page context so a file visible on screen is not listed twice
   * under two different descriptions -- the model treats a repeated id as two
   * documents and proposes two moves for it.
   */
  const [triageRows, photoRows] = await Promise.all([
    triageRepository.list(req.user.id, { limit: 60, offset: 0 }).catch(() => []),
    fileRepository.listPhotos(req.user.id, { limit: 60, offset: 0 }).catch(() => []),
  ]);

  /**
   * ONE ENTRY PER FILE, IN PRIORITY ORDER, MERGING RATHER THAN DROPPING.
   *
   * Three sources overlap heavily -- an unfiled photo the user is looking at
   * and just searched for is in all three -- and the model treats a repeated
   * id as two documents and proposes two moves for it. So this collapses by
   * id, keeping the FIRST position and folding in any extra field a later
   * source knows about.
   *
   * Order is the whole point, because buildInput trims to MAX_VISIBLE_FILES
   * from the end. Retrieval leads: it is the only bucket chosen for relevance
   * to what was actually asked, and a trim that reached it would put the
   * assistant back where it started.
   *
   * Deduping in the other direction is the bug this replaced. Filtering the
   * retrieved list against a `seen` set already primed from the backlog looked
   * equivalent and was not: every unfiled photo is in the backlog, so the top
   * search hit for "people hugging in a kitchen" was demoted out of the
   * retrieval block and re-listed in backlog order, below screenshots of
   * cryptography diagrams. Position IS the signal here -- dropping a file from
   * the front of the list is not deduplication, it is a re-ranking.
   */
  const byId = new Map();
  const add = (file, extra = {}) => {
    const existing = byId.get(file.id);
    if (!existing) {
      byId.set(file.id, { ...file, ...extra });
      return;
    }
    // Keep the earlier (higher-priority) entry and its position; fill in only
    // the fields it does not already have. Written as an explicit loop rather
    // than Object.assign: the spread that reads correctly left-to-right is the
    // one where the LATER source wins, which is the opposite of what is wanted
    // here, and `Object.assign(existing, extra, existing)` does not fix it --
    // once `extra` has been copied in, the third argument is copying `existing`
    // onto itself and changes nothing.
    for (const [key, value] of Object.entries(extra)) {
      if (existing[key] === undefined || existing[key] === null) existing[key] = value;
    }
  };

  /**
   * ATTACHMENTS LEAD, ahead of even retrieval.
   *
   * Order is not cosmetic here: buildInput trims to MAX_VISIBLE_FILES from the
   * END, so position decides what survives a long list, and the block header
   * tells the model that the first entries are what the user is looking at.
   * Retrieval was the front of this list because it is the only bucket chosen
   * for relevance to what was asked -- which is exactly the argument for
   * putting attachments in front of it. A file the user physically dragged
   * into the conversation is not a guess about relevance; it is a statement.
   *
   * `add` keeps the FIRST position and merges later fields in, so a file that
   * is attached AND on screen AND a search hit appears once, at the top,
   * carrying its description and its `attached` flag.
   */
  for (const file of attachedFiles) add(file);
  for (const file of retrievedFiles) add(file);
  for (const file of visibleFiles) add(file);
  for (const row of [...triageRows, ...photoRows]) {
    add(describe(row), {
      // Says WHY it is waiting, so the model can explain its choice rather
      // than filing blind -- "this one is a photo with no readable text" is a
      // better basis for a suggestion than a bare filename. Merged onto a file
      // that was already retrieved, rather than being the reason it is absent.
      waitingBecause: row.reason || (row.is_image ? "a photo awaiting review" : "unfiled"),
    });
  }

  const selectableFiles = [...byId.values()];

  /**
   * THE DESCRIPTION IS THE POINT.
   *
   * Every active file ends up with one (services/descriptionService), and it
   * is the only field that says what a document actually IS -- a filename like
   * "WhatsApp Image 2026-07-29 at 20.17.33.jpeg" says nothing at all, and that
   * is most of this archive. Fetched in one query for the whole set rather
   * than per file, and attached here rather than inside `describe` because the
   * rows arrive from four different queries, none of which carries it.
   */
  const descriptions = await fileDescriptionRepository
    .descriptionsForFiles(selectableFiles.map((f) => f.id), req.user.id)
    .catch(() => new Map());

  for (const file of selectableFiles) {
    const description = trimDescription(descriptions.get(file.id));
    if (description) file.description = description;
  }

  const result = await geminiChatService.chat({
    message,
    history: Array.isArray(history) ? history : [],
    subjectTree,
    visibleFiles: selectableFiles,
    selectedSubject,
    // Which page the user is on and what is on it. Read-only hint for the
    // model so "rename this" can resolve against what they are looking at;
    // bounded so a client cannot stuff the prompt.
    pageContext: context?.page
      ? {
          page: String(context.page).slice(0, 60),
          description: String(context.description || "").slice(0, 400),
        }
      : null,
  });

  res.json({
    ...result,
    /**
     * Which attachments actually reached the model.
     *
     * The client marks anything absent from this list rather than deleting the
     * chip: a file removed in another tab, or an id a stale client is still
     * holding, must not just vanish from the row above the message box as
     * though it had never been attached. Always present, so the client can
     * tell "none were usable" from "this server does not report".
     */
    attachmentsUsed: attachedFiles.map((f) => f.id),
  });
}

module.exports = { chat };
