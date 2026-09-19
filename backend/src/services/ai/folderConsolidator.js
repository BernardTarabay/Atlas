// Finding the folders that turned out to be the same idea twice.
//
// WHY THIS IS NEEDED AT ALL
//
// folderPlanner works a batch at a time, and it is shown the existing tree each
// time precisely so it reuses rather than reinvents. That stops duplication
// WITHIN a run. It does not stop drift ACROSS runs: batch three meets a pile of
// blank forms and proposes "Forms And Templates", batch nine meets another and
// proposes "Document Templates", and neither is wrong given what it could see.
//
// Measured on the first real backlog, that produced five separate homes for
// "templates" and both "Abstract Art" and "Abstract Geometric Art". Nothing was
// misfiled -- every document sat somewhere defensible -- but the taxonomy had
// more folders than ideas, which is its own kind of mess and exactly what a
// person notices first.
//
// So this is the pass that reads the whole tree at once, which no single
// planning call ever does, and asks the only question that needs that view:
// which of these are the same thing?
//
// WHAT IT IS NOT ALLOWED TO DO
//
// It never deletes or renames a folder the USER made. A person's taxonomy is
// theirs, and "the assistant tidied away the folder I created" is a far worse
// outcome than a slightly redundant tree. Where a group contains a user folder,
// that folder is the survivor and the AI-created ones fold into it -- which is
// the best possible result, because it pulls the assistant's inventions back
// into the structure the person actually chose.
const env = require("../../config/env");
const { acquireRateLimitSlot, parseRetryDelayMs, sleep } = require("./rateLimiter");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

// Same reasoning as folderPlanner's own timeout: this reads an entire taxonomy
// and reasons across all of it, which is not a lookup.
const TIMEOUT_MS = parseInt(process.env.AI_PLAN_TIMEOUT_MS || "180000", 10);

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    merges: {
      type: "array",
      description:
        "Groups of folders that hold the same kind of document and should become one. " +
        "Leave empty if the taxonomy has no genuine duplicates -- a tree with distinct folders is the goal, not a smaller tree.",
      items: {
        type: "object",
        properties: {
          survivor_path: {
            type: "string",
            description:
              "The path that should REMAIN, copied exactly from the list. Prefer a folder marked [user] -- always, if the group contains one. " +
              "Otherwise prefer the clearer, more general name, and then the one holding more files.",
          },
          merge_paths: {
            type: "array",
            items: { type: "string" },
            description: "Paths to fold into the survivor, copied exactly. Never include the survivor itself, and never a folder marked [user].",
          },
          rationale: { type: "string", description: "One sentence on why these are the same idea. Shown to the user." },
        },
        required: ["survivor_path", "merge_paths", "rationale"],
      },
    },
    reparents: {
      type: "array",
      description:
        "Folders sitting in the wrong PLACE rather than duplicating another. Most often a folder stranded at the " +
        "top level that is plainly a kind of thing an existing top-level folder already covers. Moving a folder " +
        "takes its whole branch and all its files with it; nothing is merged or deleted.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "The folder to move, copied exactly from the list. Never one marked [user]." },
          new_parent_path: { type: "string", description: "The folder it should sit under, copied exactly. Prefer a [user] folder -- pulling the assistant's folders into the structure the person actually built is the whole point." },
          rationale: { type: "string", description: "One sentence on why it belongs there." },
        },
        required: ["path", "new_parent_path", "rationale"],
      },
    },
  },
  required: ["merges", "reparents"],
};

const SYSTEM_INSTRUCTION = `
You are tidying a document archive's folder tree. Some folders were created in
separate passes and describe the same idea in different words.

Identify groups that should become ONE folder.

Rules:

1. Merge only folders holding the same KIND of document. "Tax Returns" and
   "Deduction Worksheets" are both tax paperwork and are still different
   documents -- leave them alone. "Forms And Templates" and "Document
   Templates" are one idea written twice -- merge them.
2. NEVER merge away a folder marked [user]. Those were made by the person who
   owns this archive. If a group contains one, it MUST be the survivor and
   every other member folds into it.
3. Do not merge a folder into its own parent or its own child. Nesting is not
   duplication.
4. Prefer fewer, better-named folders -- but a tree of distinct folders is the
   goal, not a small tree. If nothing genuinely duplicates, return no merges.
   Over-merging destroys information; leaving two similar folders costs almost
   nothing.
5. The survivor should be the name a person would keep: the clearer and more
   general of the two, not merely the older or the larger.
6. MERGE ACROSS BRANCHES ONLY WHEN THE DOCUMENTS ARE THE SAME.
   "Employee Records" under one parent and "HR Records" under another are one
   idea in two places -- merge them.
   But A FOLDER'S MEANING INCLUDES ITS PARENT. "Legal Agreements > Templates"
   and "Academic Records > Templates" are not one idea written twice; they are
   templates for entirely different things, and merging them destroys the only
   thing that made either findable. The same goes for "Records", "Documents",
   "Forms", "Logs" and "Summaries": those are WORDS THAT FOLDERS SHARE, not
   ideas that folders duplicate.
   Before merging two folders in different branches, ask whether the SAME
   documents could sit in either one. If the answer depends on which branch it
   is in, they are not duplicates. Leave them.
7. SEPARATELY, use the reparents list for folders that are not duplicates but
   are in the wrong PLACE. A folder stranded at the top level next to the
   archive's real top-level folders, when it is plainly a kind of thing one of
   them already covers, should be moved under it -- "Official Transcripts"
   belongs under the academic folder, not beside it. Prefer moving things
   under a
   folder marked [user]: pulling invented folders into the structure the person
   actually built is the best outcome available here.
   A folder that should move AND merge belongs in the merges list, not both.
Answer as JSON matching the schema.
`.trim();

function describeTree(subjects) {
  return subjects
    .map((s) => `- ${s.materialized_path} [${s.origin}] (${s.files} file(s)${s.kids ? `, ${s.kids} subfolder(s)` : ""})`)
    .join("\n");
}

function extractOutputText(interaction) {
  const steps = interaction?.steps || [];
  const outputSteps = steps.filter((s) => s.type === "model_output");
  const last = outputSteps[outputSteps.length - 1];
  if (!last?.content) return "";
  return last.content.filter((c) => c.type === "text").map((c) => c.text).join("");
}

/**
 * @param {object[]} subjects { materialized_path, origin, files, kids }
 * @returns {Promise<{ok:boolean, merges?:object[], reason?:string}>}
 */
async function planConsolidation(subjects, attempt = 1) {
  if (!env.ai.apiKey) return { ok: false, reason: "GEMINI_API_KEY is not set." };
  if (subjects.length < 2) return { ok: true, merges: [], reparents: [] };

  await acquireRateLimitSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": env.ai.apiKey, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: env.ai.model,
        system_instruction: SYSTEM_INSTRUCTION,
        input: `The folder tree:\n${describeTree(subjects)}`,
        response_format: { type: "text", mime_type: "application/json", schema: RESPONSE_SCHEMA },
        generation_config: { thinking_level: "low" },
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") return { ok: false, reason: `Timed out after ${TIMEOUT_MS}ms consolidating.` };
    return { ok: false, reason: `Could not reach Gemini: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 429 && attempt <= 2) {
      await sleep(parseRetryDelayMs(body) ?? 15_000 * attempt);
      return planConsolidation(subjects, attempt + 1);
    }
    return { ok: false, reason: `Gemini returned ${response.status}: ${body.slice(0, 300)}` };
  }

  try {
    const payload = await response.json();
    const text = extractOutputText(payload);
    if (!text) return { ok: false, reason: "The consolidator returned nothing." };
    const parsed = JSON.parse(text);
    return {
      ok: true,
      merges: Array.isArray(parsed.merges) ? parsed.merges : [],
      reparents: Array.isArray(parsed.reparents) ? parsed.reparents : [],
    };
  } catch (err) {
    return { ok: false, reason: `Could not parse the consolidation plan: ${err.message}` };
  }
}

module.exports = { planConsolidation, TIMEOUT_MS };
