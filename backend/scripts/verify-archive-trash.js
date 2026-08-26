// Proves Archive and Trash behave like destinations and not like folders.
//
// WHAT WAS ASKED FOR
//
//   "an archive and trash section which act like folders but are undeletable
//    and you can't rename them, so like absolute paths, you can move any file
//    there, and the trash acts like a recycle bin and deletes files permanently
//    after a specific amount of time, while archive is just a way to hide
//    files/folders"
//
// WHY THEY ARE STATUSES, NOT SUBJECTS
//
// A subject says what a document is ABOUT; these say where it is in its LIFE.
// If they were folders, every listing, count and search in the application
// would need "...and not filed under Trash" bolted on, and the first query that
// forgot would show deleted documents as live ones. Being statuses makes
// "undeletable" and "unrenameable" free -- there is no row to delete or rename
// -- and makes disappearing from listings the default rather than a rule each
// query has to remember.
//
// The checks below are therefore mostly about ABSENCE: a file put away has to
// vanish from the listing, the count, the id sweep behind "select all" and the
// search, all four of which are separate queries that have drifted apart before.
//
//     node scripts/verify-archive-trash.js

const { Pool } = require("pg");
const env = require("../src/config/env");
const lifecycleService = require("../src/services/lifecycleService");
const subjectService = require("../src/services/subjectService");
const fileService = require("../src/services/fileService");
const fileRepository = require("../src/repositories/fileRepository");
const classificationResultRepository = require("../src/repositories/classificationResultRepository");
const purgeTrashProcessor = require("../src/jobs/processors/purgeTrashProcessor");
const { parseFileFilters } = require("../src/repositories/fileFilters");
const { ConfidenceLevel, ClassificationMethod } = require("../src/models/enums");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

const PREFIX = "__verify_lifecycle__";
const fixtureIds = [];
let locationId = null;

async function cleanup() {
  try {
    if (fixtureIds.length) {
      await p.query("DELETE FROM classification_results WHERE file_id = ANY($1::uuid[])", [fixtureIds]);
      await p.query("DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])", [fixtureIds]);
      await p.query("DELETE FROM files WHERE id = ANY($1::uuid[])", [fixtureIds]);
    }
    await p.query("DELETE FROM subjects WHERE id IN (SELECT id FROM subjects WHERE name LIKE $1 ORDER BY depth DESC)", [`${PREFIX}%`]);
    if (locationId) await p.query("DELETE FROM storage_locations WHERE id=$1", [locationId]);
  } catch (e) { console.log(`   (cleanup) ${e.message}`); }
  await p.end().catch(() => {});
  await closeAllQueues().catch(() => {});
  
}

async function makeFile(ownerUserId, name) {
  const { rows } = await p.query(
    `INSERT INTO files (storage_location_id, filename_original, filename_current, size_bytes,
                        original_path, current_path, status, owner_user_id, extension)
     VALUES ($1,$2,$2,1,$3,$3,'active',$4,'pdf') RETURNING id`,
    [locationId, name, `${PREFIX}/${name}`, ownerUserId]
  );
  fixtureIds.push(rows[0].id);
  return rows[0].id;
}

const scoped = { pathPrefix: PREFIX };

(async () => {
  console.log("Verifying Archive and Trash\n" + "=".repeat(40));
  try {
    const owner = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
    if (!owner) { console.log("   SKIP  needs a user"); return; }

    const { rows: [loc] } = await p.query(
      `INSERT INTO storage_locations (owner_user_id, name, type, root_path, access_mode)
       VALUES ($1,$2,'local',$3,'direct') RETURNING id`,
      [owner.id, `${PREFIX}loc`, `C:\\\\${PREFIX}`]
    );
    locationId = loc.id;

    const keep = await makeFile(owner.id, "keep.pdf");
    const toArchive = await makeFile(owner.id, "archive-me.pdf");
    const toTrash = await makeFile(owner.id, "trash-me.pdf");

    const listed = async () =>
      (await fileRepository.listNotDeleted({ limit: 500, filters: parseFileFilters(scoped, owner.id) }))
        .map((r) => r.id);
    const counted = async () =>
      fileRepository.countMatching({ filters: parseFileFilters(scoped, owner.id) });
    const swept = async () => (await fileService.matchingIds(scoped, owner.id)).ids;

    check("all three start out visible", (await listed()).length === 3, `${(await listed()).length}`);

    console.log("\n1. Putting a file away removes it from every view");

    await lifecycleService.moveFiles([toArchive], "archive", owner.id);
    await lifecycleService.moveFiles([toTrash], "trash", owner.id);

    const after = await listed();
    check("the listing shows only what is left", after.length === 1 && after[0] === keep, `${after.length} row(s)`);
    check("...the count agrees with the listing", (await counted()) === 1, `count ${await counted()}`);
    // These three drifted apart before -- "select all N" once selected fewer
    // than N because each query had its own idea of which statuses count.
    check("...and 'select all' agrees with both",
      JSON.stringify(await swept()) === JSON.stringify([keep]), `${(await swept()).length} id(s)`);

    console.log("\n2. Each destination knows what is in it");

    const archive = await lifecycleService.listDestination("archive", {}, owner.id);
    const trash = await lifecycleService.listDestination("trash", {}, owner.id);
    check("the archived file is in the Archive",
      archive.files.some((f) => f.id === toArchive), `${archive.total} archived`);
    check("the trashed file is in the Trash",
      trash.files.some((f) => f.id === toTrash), `${trash.total} in trash`);
    check("...and Trash says how long it has left",
      trash.files[0]?.days_left === env.trash.retentionDays,
      `${trash.files[0]?.days_left} of ${env.trash.retentionDays} days`);

    let threw = null;
    try { await lifecycleService.moveFiles([keep], "somewhere-else", owner.id); }
    catch (e) { threw = e.message; }
    check("there is no third destination to invent", /archive.*trash/i.test(threw || ""), threw || "(accepted!)");

    console.log("\n3. Both are reversible");

    await lifecycleService.restoreFiles([toArchive, toTrash], owner.id);
    check("restoring brings them back into the listing", (await listed()).length === 3, `${(await listed()).length}`);
    const restored = (await p.query(
      "SELECT status, deleted_at, archived_at FROM files WHERE id=$1", [toTrash])).rows[0];
    check("...as active, with the timestamps cleared",
      restored.status === "active" && !restored.deleted_at && !restored.archived_at,
      `status ${restored.status}`);

    console.log("\n4. Permanent deletion is the only one-way door, and it is guarded");

    threw = null;
    try { await lifecycleService.purgeFiles([keep], owner.id); }
    catch (e) { threw = e.message; }
    check("a live file cannot be purged -- Trash is the only route",
      /not in the Trash/i.test(threw || ""), threw || "(purged a live file!)");

    await lifecycleService.moveFiles([toTrash], "trash", owner.id);
    const purge = await lifecycleService.purgeFiles([toTrash], owner.id);
    check("a trashed file can be purged", purge.purged === 1, `${purge.purged} removed`);
    const goneRow = await p.query("SELECT id FROM files WHERE id=$1", [toTrash]);
    check("...and the row is really gone", goneRow.rowCount === 0, "no row");
    const audit = await p.query(
      "SELECT count(*)::int n FROM audit_logs WHERE action='file.purged' AND entity_id=$1", [toTrash]);
    check("...but the audit entry survives it, written before the delete",
      audit.rows[0].n === 1, `${audit.rows[0].n} entry`);

    console.log("\n5. The Trash empties itself on time, and not before");

    const fresh = await makeFile(owner.id, "fresh.pdf");
    const old = await makeFile(owner.id, "old.pdf");
    await lifecycleService.moveFiles([fresh, old], "trash", owner.id);
    // Backdate one past the window; the sweep selects on elapsed time alone.
    await p.query(
      `UPDATE files SET deleted_at = now() - ($2 || ' days')::interval WHERE id = $1`,
      [old, String(env.trash.retentionDays + 1)]
    );

    const result = await purgeTrashProcessor.handle({});
    check("the expired file was removed", result.purged >= 1, `${result.purged} purged`);
    check("...and the one still within its window was not",
      (await p.query("SELECT id FROM files WHERE id=$1", [fresh])).rowCount === 1,
      "the fresh one is still recoverable");

    console.log("\n6. Deleting a folder can send its documents to the Trash");

    const folder = await subjectService.create({ parentId: null, name: `${PREFIX}Old Project` }, owner.id);
    const inside = await makeFile(owner.id, "inside.pdf");
    await classificationResultRepository.createPartial({
      fileId: inside, classifiedSubjectId: folder.id,
      confidenceLevel: ConfidenceLevel.HIGH, confidenceScore: 1,
      method: ClassificationMethod.MANUAL, rawOutput: { fixture: true },
    });

    await subjectService.remove(folder.id, owner.id, { force: true, contents: "trash" });

    const insideRow = (await p.query("SELECT status FROM files WHERE id=$1", [inside])).rows[0];
    check("the document went to the Trash with its folder",
      insideRow.status === "deleted", `status ${insideRow.status}`);
    check("...so it is still recoverable, not destroyed",
      (await lifecycleService.listDestination("trash", {}, owner.id)).files.some((f) => f.id === inside),
      "listed in Trash");
  } catch (e) {
    failed += 1;
    console.log(`\n   ERROR ${e.stack}`);
  } finally {
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
