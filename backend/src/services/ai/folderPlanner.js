// Proposing the folders that do not exist yet.
//
// WHAT THIS IS FOR
//
// geminiClassifier is given a CLOSED list of subjects and told to pick the
// best one "or null if none reasonably fit". That null is honest and it is
// also a dead end: the file goes unfiled and nothing ever revisits the
// question. On this installation that produced 4,629 unfiled files against a
// taxonomy of seven folders -- not because the classifier was wrong, but
// because it was never allowed to say "the right folder for this does not
// exist yet".
//
// This is the other half. It is the only place in the system permitted to
// invent a folder.
//
// WHY IT PLANS A BATCH INSTEAD OF ANSWERING PER FILE
//
// The obvious version -- let the classifier propose a folder whenever nothing
// fits -- produces one folder per awkward file. Run over an unfiled pile that
// size and you would get thousands of folders of one document each, which is
// not an organized archive, it is the same mess with more clicks in it.
//
// Filing is a clustering problem, so the model is shown the whole batch at
// once and asked for a SMALL set of folders that covers it. It can only
// propose a folder it then puts several files in, because a folder's value is
// entirely in being somewhere a future document also belongs.
//
// WHY THE EXISTING TREE IS SENT WITH IT
//
// Two failures to avoid, and they pull in opposite directions:
//
//   inventing a duplicate   proposing "Invoices" when "Financial > Invoices"
//                           already exists is worse than filing nothing --
//                           now the archive has two homes for one idea and
//                           the user has to merge them by hand.
//   deferring too much      the point of this pass is that the user's folders
//                           did NOT fit. A planner that always finds something
//                           "close enough" among the existing ones just files
//                           documents in the wrong place, quietly.
//
// So the instruction is explicit about both: reuse when it genuinely fits,
// and otherwise say so and propose the real answer, nested under an existing
// top-level folder wherever one applies.
const env = require("../../config/env");
const { acquireRateLimitSlot, parseRetryDelayMs, sleep } = require("./rateLimiter");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

/**
 * How many files one planning call reasons over.
 *
 * Bounded by the prompt, not by ambition: each file contributes a title and a
 * short description, and a few hundred of those is a large input already. The
 * caller pages through the backlog, and each page sees the folders the
 * previous ones created -- so later batches converge on the taxonomy rather
 * than re-proposing it.
 */
const BATCH_SIZE = 120;

/**
 * A ceiling on invention per call.
 *
 * Without one, a batch of miscellaneous documents produces a proposal per
 * document -- the exact outcome the batching exists to prevent. Twelve is
 * comfortably more than a coherent batch needs and far less than "one each".
 */
const MAX_NEW_FOLDERS = 12;

/**
 * This call gets its own timeout, and a much longer one.
 *
 * env.ai.timeoutMs is 20s and correctly tuned for what it was written for: a
 * bounded, single-document classification. Planning is not that. It reads a
 * few hundred titles and descriptions and has to notice what they have in
 * common, which is genuinely more work -- measured here, 60 files did not
 * finish inside 20 seconds and the whole batch was lost to a timeout that was
 * never meant to apply to it.
 *
 * Being generous costs nothing when it succeeds and the alternative is a pass
 * that can never complete.
 */
const PLAN_TIMEOUT_MS = parseInt(process.env.AI_PLAN_TIMEOUT_MS || "180000", 10);

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    new_folders: {
      type: "array",
      description:
        `Folders that do not exist yet and should. At most ${MAX_NEW_FOLDERS}. ` +
        "Only propose one you will then assign at least two files to -- a folder holding a single " +
        "document is not organization. Leave empty if the existing folders genuinely cover this batch.",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "A short identifier for this proposal, used to refer to it in assignments below. Lowercase, no spaces." },
          name: { type: "string", description: "What the folder should be called, in the language the documents are in. Title Case. A noun phrase a person would recognise, e.g. 'Insurance Policies', not 'Misc Docs 3'." },
          parent_path: { type: ["string", "null"], description: "The path of the EXISTING folder to nest this under, copied EXACTLY as it appears in the folder list above (they look like 'financial' or 'media.photos'). null to create it at the top level. Prefer nesting under something that already exists." },
          rationale: { type: "string", description: "One sentence: what these documents have in common, and why no existing folder was right for them. This is shown to the user." },
        },
        required: ["key", "name", "parent_path", "rationale"],
      },
    },
    assignments: {
      type: "array",
      description: "Where each file goes. Every file in the input should appear exactly once, unless nothing sensible can be said about it.",
      items: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "The id exactly as given in the input list." },
          existing_path: { type: ["string", "null"], description: "The path of an EXISTING folder to file this under, copied EXACTLY as it appears in the folder list (e.g. 'media.photos'). Use this whenever one genuinely fits." },
          new_folder_key: { type: ["string", "null"], description: "The key of one of your new_folders above. Use only when no existing folder fits." },
          confidence: { type: "string", enum: ["high", "medium", "low"], description: "How sure you are this is the right home. Use low when you are guessing from the filename alone." },
        },
        required: ["file_id", "existing_path", "new_folder_key", "confidence"],
      },
    },
  },
  required: ["new_folders", "assignments"],
};

const SYSTEM_INSTRUCTION = `
You organize a personal document archive. You are given a list of documents that
could NOT be filed into any existing folder, and the folder tree as it stands.

Your job is to decide where each one belongs -- and, where the archive has no
suitable folder, to CREATE the folder that should exist.

Rules:

1. Reuse before you invent. If an existing folder genuinely fits a document,
   file it there and do not propose a new one. Proposing a folder that
   duplicates an existing idea is the worst outcome available to you.
2. But do not force a fit. These documents are here precisely because the
   obvious folders did not suit them. Filing a medical record under "Financial"
   because it is the closest of four options is worse than proposing "Medical".
3. Propose a folder only if at least two documents in this batch belong in it.
   A folder for one document is not organization.
4. Nest under an existing top-level folder whenever one applies. A flat list of
   twenty top-level folders is harder to use than three with children.
5. Name folders the way a person would: a recognisable noun phrase, in the
   language the documents themselves are in. Never "Miscellaneous", "Other",
   "Unsorted" or a numbered bucket -- those are the absence of a decision, and
   the archive already has one of those.
6. NAME A FOLDER FOR WHAT THE DOCUMENTS ARE, NEVER FOR THE STATE OF THEIR
   CONTENT. "Insurance Policies" and "Lab Reports" are kinds of document.
   "Placeholder Documents", "Blank Scans", "Untitled Files", "Low Quality
   Scans" and "Draft Content" are observations about text, and a folder named
   after one is a junk drawer with a technical-sounding label. If several
   documents share only the fact that you could not read them properly, that
   is not a category -- leave them unfiled (see rule 8).
7. Do not create a folder whose name restates its parent
   ("Purchase Agreements > Purchase Records"), and do not propose two folders
   for the same idea in one batch. One home per idea.
8. If a document is genuinely unidentifiable, leave it out of assignments
   entirely rather than guessing. Being left unfiled is a fair outcome; being
   filed somewhere wrong is not. Unfiled is not a failure -- it is the list of
   things a person still needs to look at, and it is better short and honest
   than emptied into invented folders.
Answer as JSON matching the schema.
`.trim();

function describeTree(subjects) {
  if (!subjects.length) return "(the archive has no folders yet)";
  return subjects
    .slice()
    .sort((a, b) => String(a.materialized_path).localeCompare(String(b.materialized_path)))
    .map((s) => {
      const count = s.file_count != null ? ` [${s.file_count} file(s)]` : "";
      const desc = s.description ? ` -- ${String(s.description).slice(0, 120)}` : "";
      return `- ${s.materialized_path}${count}${desc}`;
    })
    .join("\n");
}

function describeFiles(files) {
  return files
    .map((f) => {
      const bits = [
        f.ai_short_title || f.filename_current,
        f.description ? String(f.description).slice(0, 200) : null,
        // The folder it currently sits in on disk is a real signal about what
        // it is -- often a better one than a machine-generated filename.
        f.current_path ? `path: ${String(f.current_path).slice(0, 120)}` : null,
      ].filter(Boolean);
      return `${f.id} :: ${bits.join(" :: ")}`;
    })
    .join("\n");
}

/**
 * Pull the JSON out of an Interactions API response.
 *
 * Copied from geminiClassifier rather than reinvented, and that matters: the
 * first version here guessed at `payload.outputs`, got a perfectly good 200
 * back, and reported "the planner returned nothing" -- a shape mismatch
 * wearing an empty-response error's clothes. The API returns a `steps` array
 * and the answer is in the last `model_output` step.
 */
function extractOutputText(interaction) {
  const steps = interaction?.steps || [];
  const outputSteps = steps.filter((s) => s.type === "model_output");
  const lastOutput = outputSteps[outputSteps.length - 1];
  if (!lastOutput?.content) return "";
  return lastOutput.content.filter((c) => c.type === "text").map((c) => c.text).join("");
}

/**
 * Ask for a filing plan.
 *
 * @param {object[]} files    unfiled files: { id, filename_current, ai_short_title, description, current_path }
 * @param {object[]} subjects existing tree: { materialized_path, description, file_count }
 * @returns {Promise<{ok: boolean, newFolders?: object[], assignments?: object[], reason?: string, usage?: object}>}
 */
async function planFolders(files, subjects, attempt = 1) {
  if (!env.ai.apiKey) return { ok: false, reason: "GEMINI_API_KEY is not set." };
  if (!files.length) return { ok: true, newFolders: [], assignments: [] };

  await acquireRateLimitSlot();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": env.ai.apiKey, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: env.ai.model,
        system_instruction: SYSTEM_INSTRUCTION,
        input:
          `Existing folders:\n${describeTree(subjects)}\n\n` +
          `Unfiled documents (id :: title :: description :: path):\n${describeFiles(files)}`,
        response_format: { type: "text", mime_type: "application/json", schema: RESPONSE_SCHEMA },
        // Planning benefits from more room to think than per-file
        // classification does: the whole point is noticing what a few hundred
        // documents have in common, which is not a lookup.
        generation_config: { thinking_level: "low" },
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") return { ok: false, reason: `Timed out after ${PLAN_TIMEOUT_MS}ms planning folders.` };
    return { ok: false, reason: `Could not reach Gemini: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 429 && attempt <= 2) {
      await sleep(parseRetryDelayMs(body) ?? 15_000 * attempt);
      return planFolders(files, subjects, attempt + 1);
    }
    return { ok: false, reason: `Gemini returned ${response.status}: ${body.slice(0, 300)}` };
  }

  try {
    const payload = await response.json();
    const text = extractOutputText(payload);
    if (!text) return { ok: false, reason: "The planner returned nothing." };
    const parsed = JSON.parse(text);
    return {
      ok: true,
      // Trust nothing about the shape: this is model output about to become
      // rows in the user's taxonomy.
      newFolders: Array.isArray(parsed.new_folders) ? parsed.new_folders.slice(0, MAX_NEW_FOLDERS) : [],
      assignments: Array.isArray(parsed.assignments) ? parsed.assignments : [],
      usage: payload.usage || null,
    };
  } catch (err) {
    return { ok: false, reason: `Could not parse the plan: ${err.message}` };
  }
}

module.exports = { planFolders, BATCH_SIZE, MAX_NEW_FOLDERS, PLAN_TIMEOUT_MS };
