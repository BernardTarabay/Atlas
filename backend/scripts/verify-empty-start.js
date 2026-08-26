// Proves a new account starts with NO folders, and that this is a starting
// point rather than a dead end.
//
// WHAT CHANGED AND WHY IT NEEDS HOLDING
//
// Registration used to seed twelve folders so the first visit had something in
// it. That reasoning was right about the risk -- an empty tree with a "create
// your first folder" button asks someone to invent a filing system from memory
// -- and wrong about the fix. A structure handed over before the user has said
// anything is derived from nothing, and in practice it BECAME the taxonomy,
// because rearranging someone else's structure costs more than accepting it.
// Documents then got forced into the least-wrong bucket, which is the exact
// failure the dynamic tree exists to end.
//
// So the folders are gone and the dead end is answered in the UI instead: the
// Library offers a conversation with the assistant, which can create the whole
// structure in one turn.
//
// This checks the half that can be checked from here -- that a real
// registration produces zero folders, that nothing else about the account is
// missing, and that the assistant can still build a tree from nothing.
//
//     node scripts/verify-empty-start.js

const { Pool } = require("pg");
const env = require("../src/config/env");
const authService = require("../src/services/authService");
const subjectService = require("../src/services/subjectService");
const subjectRepository = require("../src/repositories/subjectRepository");
const { ACTION_TYPES } = require("../src/services/ai/geminiChatService");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

const email = `__verify_empty_start_${Date.now()}@example.test`;
let userId = null;

async function cleanup() {
  try {
    if (userId) {
      await p.query("DELETE FROM audit_logs WHERE user_id=$1 OR entity_id=$1", [userId]);
      await p.query("DELETE FROM subjects WHERE owner_user_id=$1", [userId]);
      await p.query("DELETE FROM devices WHERE owner_user_id=$1", [userId]).catch(() => {});
      await p.query("DELETE FROM refresh_tokens WHERE user_id=$1", [userId]).catch(() => {});
      await p.query("DELETE FROM user_roles WHERE user_id=$1", [userId]).catch(() => {});
      await p.query("DELETE FROM users WHERE id=$1", [userId]);
    }
  } catch (e) { console.log(`   (cleanup) ${e.message}`); }
  await p.end().catch(() => {});
  await closeAllQueues().catch(() => {});
  
}

(async () => {
  console.log("Verifying the empty start\n" + "=".repeat(38));
  try {
    console.log("\n1. A brand-new account");

    const result = await authService.register({
      email, password: "not-a-real-password-9271", fullName: "Verify EmptyStart",
    });
    userId = result?.user?.id || (await p.query("SELECT id FROM users WHERE email=$1", [email])).rows[0]?.id;
    check("registration succeeds", Boolean(userId), userId ? "account created" : "NO USER");

    const folders = await subjectService.list({}, userId);
    check("the new account has NO folders at all", folders.length === 0,
      folders.length ? folders.map((f) => f.name).join(", ") : "empty, as intended");

    // The device row is infrastructure, not a filing decision, and must still
    // be there -- removing the seeding must not have taken it with it.
    const devices = await p.query("SELECT count(*)::int n FROM devices WHERE owner_user_id=$1", [userId]);
    check("...but the server device row still exists", devices.rows[0].n === 1, `${devices.rows[0].n} device(s)`);

    const roles = await p.query("SELECT count(*)::int n FROM user_roles WHERE user_id=$1", [userId]);
    check("...and the default role was still assigned", roles.rows[0].n >= 1, `${roles.rows[0].n} role(s)`);

    console.log("\n2. Empty is a starting point, not a dead end");

    // The way out of an empty library is the assistant building the tree. If
    // create_subject ever stopped being a real action, the empty state would
    // become the dead end the seeding was there to prevent.
    check("the assistant can still create folders", ACTION_TYPES.includes("create_subject"),
      "create_subject is a live action");
    check("...and file documents by criteria once they exist",
      ACTION_TYPES.includes("move_by_filter"), "move_by_filter is a live action");

    // And the manual path has to work from nothing, with no parent to nest
    // under -- a first folder has no parent by definition.
    const first = await subjectService.create({ parentId: null, name: "Boat stuff" }, userId);
    check("a first folder can be created with no parent", Boolean(first?.id), first?.name);

    const afterFirst = await subjectService.list({}, userId);
    check("...and it appears in the library immediately", afterFirst.length === 1, `${afterFirst.length} folder(s)`);

    // Nesting from nothing, which is what the assistant does when it proposes
    // a whole structure in one turn.
    const child = await subjectService.create({ parentId: first.id, name: "Receipts" }, userId);
    const afterChild = await subjectService.list({}, userId);
    check("a folder can be nested under it straight away",
      afterChild.length === 2 && afterChild.some((s) => s.id === child.id && s.depth === 1),
      afterChild.map((s) => `${s.name}(d${s.depth})`).join(", "));

    console.log("\n3. Nothing is seeded behind the user's back");

    const seeded = await p.query(
      "SELECT count(*)::int n FROM subjects WHERE owner_user_id=$1 AND origin='seed'", [userId]);
    check("no folder on this account is marked as seeded", seeded.rows[0].n === 0, `${seeded.rows[0].n} seeded`);

    check("the starter tree is gone from the codebase entirely",
      typeof subjectRepository.seedStarterTree === "undefined"
        && typeof subjectRepository.STARTER_TREE === "undefined",
      "no seedStarterTree, no STARTER_TREE");
  } catch (e) {
    failed += 1;
    console.log(`\n   ERROR ${e.stack}`);
  } finally {
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
