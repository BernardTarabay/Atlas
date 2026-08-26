// Live check that the Trash is a round trip: in, and back out again.
//
// WHY THIS EXISTS
//
// Restoring was implemented and reachable only as a BULK action that appeared
// once something was ticked, so a Trash with a restore in it looked like a
// Trash without one. Adding a per-row Restore button is a UI change, but the
// thing it now calls on every row had never been exercised on its own -- and
// it depends on a column that was, until very recently, never set:
//
//   trashing   must stamp deleted_at, or the purge can never see the file
//   restoring  must CLEAR deleted_at, or a restored file still looks deleted
//              to findExpired and gets purged out from under the user
//
// That second one is the dangerous half and it is invisible from the UI: a
// restored file looks perfectly fine in the library right up until the nightly
// purge removes it. So the round trip is asserted here against real Postgres.
//
//   node scripts/verify-trash-restore.js
require("dotenv").config();
const db = require("../src/config/database");
const lifecycleService = require("../src/services/lifecycleService");
const fileService = require("../src/services/fileService");

const TAG = `verify-restore-${Date.now()}`;
let failures = 0;
const cleanup = { users: [], locations: [], files: [] };

function check(ok, label, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const row = async (id) =>
  (await db.query("SELECT status, deleted_at FROM files WHERE id = $1", [id])).rows[0];

async function main() {
  const { rows: u } = await db.query(
    "INSERT INTO users (email, password_hash, full_name) VALUES ($1,'x',$2) RETURNING id",
    [`${TAG}@example.invalid`, TAG]
  );
  const owner = u[0].id;
  cleanup.users.push(owner);

  const { rows: loc } = await db.query(
    `INSERT INTO storage_locations (name, type, root_path, access_mode, owner_user_id)
     VALUES ($1,'local',$2,'direct',$3) RETURNING id`,
    [`${TAG}-loc`, `C:\\${TAG}`, owner]
  );
  cleanup.locations.push(loc[0].id);

  const { rows: f } = await db.query(
    `INSERT INTO files (storage_location_id, filename_current, filename_original,
                        original_path, current_path, size_bytes, status, owner_user_id)
     VALUES ($1,$2,$2,$3,$3,10,'active',$4) RETURNING id`,
    [loc[0].id, `${TAG}.txt`, `${TAG}.txt`, owner]
  );
  const fileId = f[0].id;
  cleanup.files.push(fileId);

  console.log("\n1. a fresh file is active with no deletion date");
  let r = await row(fileId);
  check(r.status === "active" && r.deleted_at === null, "active, deleted_at null", r.status);

  console.log("\n2. trashing stamps the deletion date");
  await fileService.removeFile(fileId, owner);
  r = await row(fileId);
  check(r.status === "deleted", "status is deleted", r.status);
  check(r.deleted_at !== null, "deleted_at was stamped -- this is what the purge counts from");

  console.log("\n3. a trashed file is visible in the Trash, with a countdown");
  const listed = await lifecycleService.listDestination("trash", {}, owner);
  const mine = (listed.files || []).find((x) => x.id === fileId);
  check(Boolean(mine), "the file appears in the Trash listing");
  check(typeof mine?.days_left === "number", "it carries days_left", String(mine?.days_left));

  console.log("\n4. restoring puts it back AND clears the deletion date");
  const restored = await lifecycleService.restoreFiles([fileId], owner);
  check(restored.restored.includes(fileId), "restore reported success");
  r = await row(fileId);
  check(r.status === "active", "status is active again", r.status);
  check(
    r.deleted_at === null,
    "deleted_at was CLEARED -- otherwise the purge would delete it again later"
  );

  console.log("\n5. and the purge no longer considers it expired");
  const expired = await lifecycleService.findExpired({ retentionDays: 0, ownerUserId: owner });
  check(
    !expired.some((x) => x.id === fileId),
    "a restored file is not in the purge's expired set"
  );

  console.log("\n6. it is out of the Trash listing too");
  const after = await lifecycleService.listDestination("trash", {}, owner);
  check(!(after.files || []).some((x) => x.id === fileId), "gone from the Trash listing");
}

main()
  .catch((err) => {
    console.error("\nverify-trash-restore crashed:", err);
    failures += 1;
  })
  .finally(async () => {
    const q = (sql, p) => db.query(sql, p).catch(() => {});
    if (cleanup.files.length) {
      await q("DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])", [cleanup.files]);
      await q("DELETE FROM files WHERE id = ANY($1::uuid[])", [cleanup.files]);
    }
    if (cleanup.locations.length) await q("DELETE FROM storage_locations WHERE id = ANY($1::uuid[])", [cleanup.locations]);
    if (cleanup.users.length) await q("DELETE FROM users WHERE id = ANY($1::uuid[])", [cleanup.users]);
    await db.pool.end().catch(() => {});
    console.log(failures === 0 ? "\nAll checks passed. Test data removed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
