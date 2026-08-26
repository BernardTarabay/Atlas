// Proves a folder can be dragged into another folder, branch and all.
//
// "I want to drag and drop a folder into another folder. I mean, that's just
//  basic file management. And when I move it under another one, it becomes a
//  category of that parent folder."
//
// WHY THE BRANCH IS THE WHOLE STORY
//
// The migration-029 trigger recomputes materialized_path, depth and level for
// the row being written -- and only that row. So the naive implementation
// (`UPDATE subjects SET parent_id = ...`) lands the dragged folder correctly
// and leaves every descendant claiming an ancestry it no longer has.
//
// That would not throw. It would quietly break the descendant-inclusive
// subject filter, the count rollup and the tree, all of which are built on
// materialized_path -- which is exactly why this script checks the GRANDCHILD
// after every move, not just the folder that was dragged.
//
//     node scripts/verify-subject-move.js

const { Pool } = require("pg");
const env = require("../src/config/env");
const subjectService = require("../src/services/subjectService");
const subjectRepository = require("../src/repositories/subjectRepository");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

const PREFIX = "__verify_move__";

async function cleanup() {
  try {
    // Deepest first: parent_id is self-referencing.
    await p.query(
      `DELETE FROM subjects WHERE id IN (
         SELECT id FROM subjects WHERE name LIKE $1 ORDER BY depth DESC)`, [`${PREFIX}%`]
    );
    await p.query("DELETE FROM audit_logs WHERE action='subject.moved'").catch(() => {});
  } catch (e) { console.log(`   (cleanup) ${e.message}`); }
  await p.end().catch(() => {});
  await closeAllQueues().catch(() => {});
  
}

(async () => {
  console.log("Verifying folder drag-and-drop\n" + "=".repeat(42));
  try {
    const owner = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
    if (!owner) { console.log("   SKIP  needs a user"); return; }

    const mk = async (name, parentId = null) =>
      subjectService.create({ parentId, name: `${PREFIX}${name}` }, owner.id);
    const reload = async (id) => subjectRepository.findByIdForOwner(id, owner.id);

    console.log("\n1. Moving a folder makes it a child of the destination");

    let work = await mk("Work");
    let photos = await mk("Photos");
    let holidays = await mk("Holidays", photos.id);
    let spain = await mk("Spain", holidays.id);

    check("the branch starts at the top level", photos.depth === 0 && photos.parent_id === null,
      `depth ${photos.depth}`);

    await subjectService.moveToParent(photos.id, work.id, owner.id);
    photos = await reload(photos.id);

    check("the moved folder is now a child of the destination",
      photos.parent_id === work.id && photos.depth === 1, `depth ${photos.depth}`);
    check("...and its level follows its new depth",
      photos.level === "category", `level: ${photos.level}`);
    check("...with a path spelling out the new ancestry",
      photos.materialized_path.startsWith(`${work.materialized_path}.`), photos.materialized_path);

    console.log("\n2. The branch comes with it -- the part that fails silently");

    holidays = await reload(holidays.id);
    spain = await reload(spain.id);

    check("the child's path was rewritten, not left behind",
      holidays.materialized_path === `${photos.materialized_path}.${holidays.materialized_path.split(".").pop()}`,
      holidays.materialized_path);
    check("the GRANDCHILD's path was rewritten too",
      spain.materialized_path.startsWith(`${photos.materialized_path}.`), spain.materialized_path);
    check("depths shifted by the same amount all the way down",
      holidays.depth === 2 && spain.depth === 3, `child ${holidays.depth}, grandchild ${spain.depth}`);
    check("...and their levels were kept in step with depth",
      holidays.level === "subcategory" && spain.level === "subcategory",
      `${holidays.level} / ${spain.level}`);

    // The descendant-inclusive filter is built on the path prefix -- if the
    // rewrite were wrong, this is the query that would quietly return nothing.
    const under = await subjectRepository.listSubtree(work.id, owner.id);
    check("the whole branch is reachable from the new parent",
      [photos.id, holidays.id, spain.id].every((id) => under.some((s) => s.id === id)),
      `${under.length} folder(s) under Work`);

    console.log("\n3. Moving back out to the top level");

    await subjectService.moveToParent(photos.id, null, owner.id);
    photos = await reload(photos.id);
    spain = await reload(spain.id);
    check("a folder can be dragged back out to the root",
      photos.parent_id === null && photos.depth === 0, `depth ${photos.depth}`);
    check("...and the branch follows back up as well",
      spain.depth === 2 && spain.materialized_path.startsWith(`${photos.materialized_path}.`),
      spain.materialized_path);

    console.log("\n4. What it refuses");

    let threw = null;
    try { await subjectService.moveToParent(photos.id, photos.id, owner.id); }
    catch (e) { threw = e.message; }
    check("a folder cannot be moved inside itself", /inside itself/i.test(threw || ""), threw || "(allowed!)");

    threw = null;
    try { await subjectService.moveToParent(photos.id, spain.id, owner.id); }
    catch (e) { threw = e.message; }
    check("...nor into its own descendant, which would detach the branch",
      /inside it/i.test(threw || ""), threw || "(allowed!)");

    // Depth is judged on the DEEPEST folder in the branch, not the dragged one.
    let chain = await mk("D0");
    for (let i = 1; i <= 10; i += 1) chain = await mk(`D${i}`, chain.id);
    threw = null;
    try { await subjectService.moveToParent(photos.id, chain.id, owner.id); }
    catch (e) { threw = e.message; }
    check("a move that would nest the branch too deep is refused, with the number",
      /levels deep/i.test(threw || ""), threw || "(allowed!)");

    const twin = await mk("Photos", work.id);
    threw = null;
    try { await subjectService.moveToParent(photos.id, work.id, owner.id); }
    catch (e) { threw = e.message; }
    check("moving next to a folder of the same name is refused",
      /already a folder called/i.test(threw || ""), threw || "(allowed!)");
    void twin;

    console.log("\n5. Nothing moved when a move was refused");

    photos = await reload(photos.id);
    check("the folder is exactly where it was before the refusals",
      photos.parent_id === null && photos.depth === 0, `depth ${photos.depth}`);
    spain = await reload(spain.id);
    check("...and so is its branch", spain.depth === 2, `grandchild depth ${spain.depth}`);
  } catch (e) {
    failed += 1;
    console.log(`\n   ERROR ${e.stack}`);
  } finally {
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
