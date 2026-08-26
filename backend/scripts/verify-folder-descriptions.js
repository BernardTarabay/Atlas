// Proves a folder's DESCRIPTION reaches the classifier, and that the candidate
// list it reaches is only this user's folders.
//
// WHY THIS EXISTS
//
// Asked whether the system learns where to file things, the honest answer was
// no: the rule tier matches a folder's NAME as a literal phrase, and the AI
// tier was handed `slug | name` and nothing else. So a folder called "Haifa
// Monastery" matched documents containing that exact phrase, and there was no
// way to say "anything mentioning Mount Carmel belongs here too, but general
// correspondence does not".
//
// `subjects.description` had existed in the schema and in the folder dialog the
// whole time and simply never reached the model. Sending it is the closest this
// system gets to being taught -- not learning, since nothing adapts from past
// filings, but a folder becomes an instruction rather than a name to guess at.
//
// AND THE PART THAT IS NOT COSMETIC
//
// The candidate list was loaded with the base repository's unscoped
// `SELECT * FROM subjects LIMIT 1000`. Subjects carry owner_user_id, so on any
// multi-user instance that offered every account's folders as candidates for
// every file -- one person's document could be filed into another person's
// folder, and their folder names went into a stranger's prompt. Enriching that
// list with descriptions would have made the leak worse, so the scoping is
// fixed here too and checked below.
//
//     node scripts/verify-folder-descriptions.js

const { Pool } = require("pg");
const env = require("../src/config/env");
const subjectRepository = require("../src/repositories/subjectRepository");
const subjectService = require("../src/services/subjectService");
const geminiClassifier = require("../src/services/ai/geminiClassifier");
const { ACTION_TYPES } = require("../src/services/ai/geminiChatService");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

const PREFIX = "__verify_desc__";
const subjectIds = [];
let strangerId = null;

async function cleanup() {
  try {
    for (const id of subjectIds.slice().reverse()) {
      await p.query("DELETE FROM subjects WHERE id=$1", [id]).catch(() => {});
    }
    if (strangerId) {
      await p.query("DELETE FROM subjects WHERE owner_user_id=$1", [strangerId]).catch(() => {});
      await p.query("DELETE FROM audit_logs WHERE user_id=$1 OR entity_id=$1", [strangerId]).catch(() => {});
      await p.query("DELETE FROM user_roles WHERE user_id=$1", [strangerId]).catch(() => {});
      await p.query("DELETE FROM devices WHERE owner_user_id=$1", [strangerId]).catch(() => {});
      await p.query("DELETE FROM users WHERE id=$1", [strangerId]).catch(() => {});
    }
  } catch (e) { console.log(`   (cleanup) ${e.message}`); }
  await p.end().catch(() => {});
  await closeAllQueues().catch(() => {});
  
}

(async () => {
  console.log("Verifying folder descriptions\n" + "=".repeat(40));
  try {
    const owner = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
    if (!owner) { console.log("   SKIP  needs a user"); return; }

    console.log("\n1. A description reaches the model");

    const described = await subjectService.create({
      parentId: null,
      name: `${PREFIX} Haifa Monastery`,
      description: "Deeds and correspondence for the monastery at Haifa. Anything mentioning Mount Carmel belongs here. NOT for general Israel correspondence.",
    }, owner.id);
    subjectIds.push(described.id);

    const bare = await subjectService.create({
      parentId: null, name: `${PREFIX} Scans`,
    }, owner.id);
    subjectIds.push(bare.id);

    const subjects = await subjectRepository.listForOwnerTree(owner.id);
    const prompt = geminiClassifier.buildInput({
      filename: "deed.pdf", bodyText: "A property deed.",
      subjects, documentTypes: [], embeddedTitle: null,
    });

    check("the folder's description appears in the prompt",
      prompt.includes("Mount Carmel"),
      "the user's own words are in front of the model");

    check("...introduced as what the folder is FOR, not as document text",
      /\| for: Deeds and correspondence/.test(prompt),
      "labelled `for:`");

    check("a folder with no description is still listed, name only",
      prompt.includes(`name: ${PREFIX} Scans`) && !/Scans \| for:/.test(prompt),
      "no empty `for:` clause");

    // A description is prose written by a user; it cannot be allowed to make
    // the candidate list unbounded.
    const long = await subjectService.create({
      parentId: null, name: `${PREFIX} Long`, description: "x".repeat(2000),
    }, owner.id);
    subjectIds.push(long.id);
    const longPrompt = geminiClassifier.buildInput({
      filename: "a.pdf", bodyText: "", subjects: await subjectRepository.listForOwnerTree(owner.id),
      documentTypes: [], embeddedTitle: null,
    });
    const longestLine = longPrompt.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
    check("a very long description is truncated, not sent whole",
      longestLine < 400 && longPrompt.includes("…"), `longest candidate line ${longestLine} chars`);

    console.log("\n2. The model is told the description outranks the name");

    const instruction = geminiClassifier.SYSTEM_INSTRUCTION || "";
    check("the system instruction explains the `for:` note",
      /for:/.test(instruction) && /OUTRANKS/i.test(instruction),
      instruction ? "present" : "(SYSTEM_INSTRUCTION not exported -- checked prompt only)");

    console.log("\n3. The assistant can write one when it creates a folder");

    check("create_subject is still a live action", ACTION_TYPES.includes("create_subject"));
    const schema = JSON.stringify(geminiClassifier.RESPONSE_SCHEMA || {});
    void schema;
    const chatSrc = require("fs").readFileSync(
      require("path").join(__dirname, "..", "src", "services", "ai", "geminiChatService.js"), "utf8");
    check("...and the action schema carries a description field",
      /description: \{ type: \["string", "null"\][^}]*create_subject/.test(chatSrc),
      "the model can write what a folder is for");

    console.log("\n4. Candidates are THIS user's folders only");

    // The leak that mattered: an unscoped candidate list put one account's
    // folders -- and now their descriptions -- into another account's prompt.
    const { rows: [stranger] } = await p.query(
      `INSERT INTO users (email, password_hash, full_name, status)
       VALUES ($1, 'x', 'Stranger', 'active') RETURNING id`,
      [`${PREFIX}stranger_${Date.now()}@example.test`]
    );
    strangerId = stranger.id;
    const secret = await subjectRepository.create({
      ownerUserId: strangerId, parentId: null,
      name: `${PREFIX} SomebodyElsesPrivateFolder`, slug: `${PREFIX}-secret`.toLowerCase().replace(/_/g, "-"),
      description: "Another account's private filing instructions.",
    });

    const mine = await subjectRepository.listForOwnerTree(owner.id);
    check("the other account's folder is not among my candidates",
      !mine.some((s) => s.id === secret.id), `${mine.length} candidate(s), none theirs`);

    const myPrompt = geminiClassifier.buildInput({
      filename: "x.pdf", bodyText: "", subjects: mine, documentTypes: [], embeddedTitle: null,
    });
    check("...and neither their folder name nor their description is in my prompt",
      !myPrompt.includes("SomebodyElsesPrivateFolder") && !myPrompt.includes("private filing instructions"),
      "no cross-account leakage");

    // And the unscoped call that used to be here really would have leaked.
    const unscoped = await subjectRepository.list({ limit: 1000 });
    check("(the old unscoped read really did see both accounts)",
      unscoped.some((s) => s.id === secret.id) && unscoped.some((s) => s.id === described.id),
      "which is why classifyProcessor no longer uses it");
  } catch (e) {
    failed += 1;
    console.log(`\n   ERROR ${e.stack}`);
  } finally {
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
