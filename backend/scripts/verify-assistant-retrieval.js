// Proves the assistant can find a file by what is IN it, not only by what it
// is called.
//
// THE BUG THIS EXISTS TO STOP COMING BACK
//
// Asking the assistant for "the photo of two people hugging in a kitchen"
// failed, while asking for "WhatsApp Image 2026-07-29" succeeded. That looked
// like a search-quality problem and was not one: descriptionSearchService
// finds both files from a paraphrase, and always could. The assistant simply
// never called it. Its whole world was the current page plus the triage/photo
// backlog, and every file reached the model as `id | filename | path` with the
// path always empty -- so the filename was the only string it could match on,
// and on this archive the filenames are camera and WhatsApp exports that say
// nothing.
//
// Three failures, and any one of them alone reproduces the symptom:
//   1. no retrieval    -- the file was usually not in the context at all
//   2. no description  -- and if it was, the model got only its filename
//   3. wrong ORDER     -- see section 3; the fix for (1) had this bug in it
//
// This drives the REAL controller with the Gemini call stubbed out, rather
// than reimplementing its assembly here. A script that rebuilds the logic it
// is checking passes happily while the shipped path is broken -- and the
// ordering bug in section 3 was invisible to exactly that kind of script,
// because the reimplementation had the ordering right and the controller did
// not.
//
//     node scripts/verify-assistant-retrieval.js

const { Pool } = require("pg");
const env = require("../src/config/env");
const geminiChatService = require("../src/services/ai/geminiChatService");

// Stubbed BEFORE the controller is required, so it captures the context that
// would have gone to the model. No API key needed and no call is made: the
// model's reply is non-deterministic, and it is not what broke.
let captured = null;
geminiChatService.chat = async (args) => {
  captured = args;
  return { reply: "(stubbed)", actions: [] };
};
const aiChatController = require("../src/controllers/aiChatController");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

/** One assistant turn, returning the file list the model would have seen. */
async function contextFor(message, ownerUserId, context = {}) {
  captured = null;
  await aiChatController.chat(
    { body: { message, history: [], context }, user: { id: ownerUserId } },
    { json: () => {} }
  );
  return captured?.visibleFiles || [];
}

const STOPWORDS = new Set((
  "a an the of of in on at to and or with for from is are was were this that " +
  "its his her their it be by as into while standing wearing shows showing"
).split(" "));

/** A file's own description, reduced to its content words -- a paraphrase. */
function paraphraseOf(description, wordCount = 8) {
  const terms = String(description)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .slice(0, wordCount);
  return `I am looking for the file showing ${terms.join(" ")}`;
}

(async () => {
  console.log("Verifying assistant retrieval\n" + "=".repeat(38));
  try {
    const owner = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
    if (!owner) { console.log("   SKIP  needs a user"); return; }

    // Written against whatever this archive actually holds rather than a
    // hardcoded filename: the filenames here are disposable, which is the
    // whole reason descriptions exist.
    const { rows: described } = await p.query(
      `SELECT f.id, f.filename_current, f.is_image, d.description
         FROM file_descriptions d JOIN files f ON f.id = d.file_id
        WHERE d.owner_user_id = $1 AND d.description IS NOT NULL AND d.description <> ''
          AND f.status <> 'deleted'
        ORDER BY length(d.description) DESC
        LIMIT 40`,
      [owner.id]
    );

    if (described.length < 2) {
      console.log(`   SKIP  needs at least 2 described files (found ${described.length})`);
      return;
    }

    console.log("\n1. A file is findable by what is in it");

    const target = described[0];
    const query = paraphraseOf(target.description);
    console.log(`   (query: "${query}")`);

    const context = await contextFor(query, owner.id);
    const hit = context.find((f) => f.id === target.id);

    check("the described file reaches the assistant's context",
      Boolean(hit), hit ? hit.filename : `absent -- ${context.length} other file(s) came back`);

    check("...carrying its description, not just a filename",
      Boolean(hit?.description),
      hit?.description ? `"${hit.description.slice(0, 60)}..."` : "NO DESCRIPTION ON THE CONTEXT LINE");

    check("...with no page context at all, so retrieval is what put it there",
      Boolean(hit) && context.length > 0, `${context.length} file(s) retrieved from an empty page`);

    console.log("\n2. The description survives the trip to the prompt");

    /**
     * Attaching a description to the object is NOT the same as the model
     * seeing it -- the key has to be the one buildInput reads. That is exactly
     * what was wrong before: the controller set `path` and the template
     * rendered `currentPath`, so every line carried an empty location and
     * nothing anywhere reported it. This renders the real prompt and looks for
     * the text in it.
     */
    const prompt = geminiChatService.buildInput({
      message: query, history: [], subjectTree: [],
      visibleFiles: context, selectedSubject: null, pageContext: null,
    });

    check("the rendered prompt actually contains the description text",
      prompt.includes(hit.description),
      `${hit.description.slice(0, 40)}...`);

    check("...and the file's folder path, which used to render blank on every line",
      !hit.currentPath || prompt.includes(`path: ${hit.currentPath}`),
      hit.currentPath ? `path: ${hit.currentPath}` : "(file has no path recorded)");

    check("a field with no value is omitted rather than rendered empty",
      !/\|\s*(path|subject|description):\s*(\||$)/m.test(prompt),
      "no empty labelled fields in the prompt");

    console.log("\n3. Relevance leads, even when the file is also in the backlog");

    /**
     * THE REGRESSION THIS SECTION EXISTS FOR.
     *
     * Every unfiled photo is in the backlog the controller always attaches. The
     * first version of retrieval deduped by filtering the retrieved list
     * against a `seen` set already primed from that backlog -- so a file that
     * was BOTH the top search hit and an unfiled photo got dropped from the
     * retrieval block and re-listed in backlog order. The top hit for "people
     * hugging in a kitchen" landed below screenshots of cryptography diagrams,
     * and the prompt trim would eventually cut it entirely.
     *
     * Position is the signal. A "dedup" that removes a file from the front of
     * the list is a re-ranking wearing a dedup's clothes.
     */
    const photoTarget = described.find((d) => d.is_image) || target;
    const photoQuery = paraphraseOf(photoTarget.description);
    const photoContext = await contextFor(photoQuery, owner.id);
    const rank = photoContext.findIndex((f) => f.id === photoTarget.id);

    check("the best match for the query is first in the list",
      rank === 0,
      rank === -1 ? "ABSENT from the context" : `ranked #${rank + 1} of ${photoContext.length}`);

    const first = photoContext[0];
    check("...and being in the backlog adds its reason rather than demoting it",
      Boolean(first?.description),
      first?.waitingBecause
        ? `kept position 1 and merged "waiting: ${first.waitingBecause}"`
        : "not in the backlog on this corpus, ordering still correct");

    console.log("\n4. No file is listed twice");

    // The model reads a repeated id as two documents and proposes two moves
    // for it. Three overlapping sources feed this list.
    const ids = photoContext.map((f) => f.id);
    check("every file appears exactly once across all three sources",
      new Set(ids).size === ids.length,
      `${ids.length} entries, ${new Set(ids).size} distinct`);

    console.log("\n5. Ownership still holds on the retrieval path");

    check("every retrieved file has a real id",
      context.every((f) => typeof f.id === "string" && f.id), `${context.length} checked`);

    const { rows: leaked } = await p.query(
      `SELECT count(*)::int AS n FROM files
        WHERE id = ANY($1::uuid[]) AND owner_user_id <> $2`,
      [context.map((f) => f.id), owner.id]
    );
    check("no file from another account reached the context",
      leaked[0].n === 0, `${leaked[0].n} foreign file(s)`);

    // A description that arrives as the literal string "null" is worse than
    // none -- the model reads it as a fact about the file.
    check("no file carries a placeholder where a description should be",
      context.every((f) => !f.description || !/^(null|undefined)$/i.test(String(f.description).trim())),
      "no 'null' strings in the prompt");
  } catch (e) {
    failed += 1;
    console.log(`\n   ERROR ${e.stack}`);
  } finally {
    // Closed explicitly, and `process.exit` is NOT used to finish: requiring
    // the service layer opens a shared Redis connection, and exiting while it
    // is mid-close trips a libuv assertion that leaves the process reporting
    // 127 -- a script whose every check passed would still fail a CI chain.
    await p.end().catch(() => {});
    
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
