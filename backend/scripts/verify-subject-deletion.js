// Proves a folder you no longer want can actually be deleted.
//
// THE REPORT THIS COMES FROM
//
//   "I'm trying to delete an old folder. It says Photos can't be deleted,
//    files have been filed under it in the past and that history is kept for
//    audit purposes. No. If I don't want it, I don't want it."
//
// The refusal came from classification_results.classified_subject_id being
// NO ACTION, so a folder that had EVER held a file was permanently
// undeletable -- even one whose files had long since moved elsewhere. The
// suggested workaround was to rename it, which leaves the clutter in place
// under a different name. On a library whose premise is that the tree belongs
// to the user, a folder that cannot be removed is a folder the software owns.
//
// WHAT MUST BE TRUE NOW
//
//   past history never blocks         migration 036: ON DELETE SET NULL
//   history is not destroyed          the row survives with its method,
//                                     confidence and timestamps; only the
//                                     pointer to a dead folder is dropped
//   documents are never deleted       they become unfiled and stay findable
//   consequences are named, not       a branch or filed documents require
//   silently applied                  force, and the message says how many
//
//     node scripts/verify-subject-deletion.js

const { Pool } = require("pg");
const env = require("../src/config/env");
const subjectService = require("../src/services/subjectService");
const subjectRepository = require("../src/repositories/subjectRepository");
const classificationResultRepository = require("../src/repositories/classificationResultRepository");
const fileRepository = require("../src/repositories/fileRepository");
const { parseFileFilters } = require("../src/repositories/fileFilters");
const { ConfidenceLevel, ClassificationMethod } = require("../src/models/enums");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

const PREFIX = "__verify_del__";
const fixtureIds = [];
const subjectIds = [];
let locationId = null;

async function cleanup() {
  try {
    if (fixtureIds.length) {
      await p.query("DELETE FROM classification_results WHERE file_id = ANY($1::uuid[])", [fixtureIds]);
      await p.query("DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])", [fixtureIds]);
      await p.query("DELETE FROM files WHERE id = ANY($1::uuid[])", [fixtureIds]);
    }
    for (const id of subjectIds) {
      await p.query("DELETE FROM audit_logs WHERE entity_id=$1", [id]).catch(() => {});
    }
    await p.query("DELETE FROM subjects WHERE name LIKE $1", [`${PREFIX}%`]).catch(() => {});
    if (locationId) await p.query("DELETE FROM storage_locations WHERE id=$1", [locationId]).catch(() => {});
  } catch (e) { console.log(`   (cleanup) ${e.message}`); }
  await p.end().catch(() => {});
  await closeAllQueues().catch(() => {});
  
}

async function makeFolder(ownerUserId, name, parentId = null) {
  const s = await subjectService.create({ parentId, name: `${PREFIX}${name}` }, ownerUserId);
  subjectIds.push(s.id);
  return s;
}

async function makeFile(ownerUserId, name) {
  const { rows } = await p.query(
    `INSERT INTO files (storage_location_id, filename_original, filename_current, size_bytes,
                        original_path, current_path, status, owner_user_id)
     VALUES ($1,$2,$2,1,$3,$3,'active',$4) RETURNING id`,
    [locationId, name, `${PREFIX}/${name}`, ownerUserId]
  );
  fixtureIds.push(rows[0].id);
  return rows[0].id;
}

const fileInto = (fileId, subjectId) =>
  classificationResultRepository.createPartial({
    fileId, classifiedSubjectId: subjectId,
    confidenceLevel: ConfidenceLevel.HIGH, confidenceScore: 1,
    method: ClassificationMethod.MANUAL, rawOutput: { fixture: true },
  });

(async () => {
  console.log("Verifying folder deletion\n" + "=".repeat(40));
  try {
    const owner = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
    if (!owner) { console.log("   SKIP  needs a user"); return; }

    const { rows: [loc] } = await p.query(
      `INSERT INTO storage_locations (owner_user_id, name, type, root_path, access_mode)
       VALUES ($1,$2,'local',$3,'direct') RETURNING id`,
      [owner.id, `${PREFIX}loc`, `C:\\\\${PREFIX}`]
    );
    locationId = loc.id;

    console.log("\n1. The exact case that was refused: a folder with PAST history");

    const past = await makeFolder(owner.id, "Photos");
    const elsewhere = await makeFolder(owner.id, "Elsewhere");
    const moved = await makeFile(owner.id, "moved.jpg");
    await fileInto(moved, past.id);       // filed here...
    await fileInto(moved, elsewhere.id);  // ...then moved away, leaving history

    const stillHere = await fileRepository.countBySubject(past.id, owner.id);
    check("no file is CURRENTLY filed there, only history remains",
      stillHere === 0, `${stillHere} current`);

    const historyRows = (await p.query(
      "SELECT count(*)::int n FROM classification_results WHERE classified_subject_id=$1", [past.id]
    )).rows[0].n;
    check("...but a historical classification row still points at it",
      historyRows === 1, `${historyRows} row(s) -- this is what used to block deletion`);

    await subjectService.remove(past.id, owner.id);
    const gone = await subjectRepository.findByIdForOwner(past.id, owner.id);
    check("the folder deletes, with no force and no complaint", gone === null, "gone");

    console.log("\n2. History is kept, not destroyed");

    const survivor = (await p.query(
      "SELECT classified_subject_id, method, confidence_level FROM classification_results WHERE file_id=$1 ORDER BY created_at",
      [moved]
    )).rows[0];
    check("the historical row survives the folder it referenced",
      Boolean(survivor), "row still present");
    check("...with its method and confidence intact",
      survivor.method === "manual" && survivor.confidence_level === "high",
      `${survivor.method}/${survivor.confidence_level}`);
    check("...and only the dead folder pointer nulled",
      survivor.classified_subject_id === null, "classified_subject_id is null");

    const stillFiled = await fileRepository.countBySubject(elsewhere.id, owner.id);
    check("the file itself is untouched and still filed where it moved to",
      stillFiled === 1, `${stillFiled} in Elsewhere`);

    console.log("\n3. Real consequences are named, then allowed");

    const parent = await makeFolder(owner.id, "Parent");
    const child = await makeFolder(owner.id, "Child", parent.id);
    const held = await makeFile(owner.id, "held.pdf");
    await fileInto(held, child.id);

    const preview = await subjectService.previewRemoval(parent.id, owner.id);
    check("the preview counts the whole branch, not just the top folder",
      preview.subfolders === 1 && preview.filesAffected === 1,
      `${preview.subfolders} subfolder(s), ${preview.filesAffected} document(s)`);
    check("...and states plainly that no document is deleted",
      preview.documentsDeleted === 0, "documentsDeleted: 0");

    let threw = null;
    try { await subjectService.remove(parent.id, owner.id); }
    catch (e) { threw = e.message; }
    check("deleting a branch without confirming is refused, and says why",
      /folder.*inside it/i.test(threw || "") && /1 document/.test(threw || ""),
      threw || "(allowed!)");

    await subjectService.remove(parent.id, owner.id, { force: true });
    check("...and goes through once confirmed",
      (await subjectRepository.findByIdForOwner(parent.id, owner.id)) === null, "parent gone");
    check("...taking the branch beneath it",
      (await subjectRepository.findByIdForOwner(child.id, owner.id)) === null, "child gone too");

    console.log("\n4. The documents survive, unfiled");

    const fileRow = (await p.query("SELECT status FROM files WHERE id=$1", [held])).rows[0];
    check("the document that was in that branch still exists",
      fileRow?.status === "active", `status: ${fileRow?.status}`);

    const unfiled = await fileRepository.countMatching({
      filters: parseFileFilters({ unfiled: "true" }, owner.id),
    });
    check("...and has reappeared in the Unfiled pile rather than pointing at nothing",
      unfiled >= 1, `${unfiled} unfiled`);
  } catch (e) {
    failed += 1;
    console.log(`\n   ERROR ${e.stack}`);
  } finally {
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
