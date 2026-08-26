// Live check that the Trash actually empties, against real Postgres.
//
// WHY THIS EXISTS
//
// The nightly purge had never run once. `trashPurgeScheduler` enqueued an
// ownerless `purge_trash` job, `processingJobs.create` refused it because every
// job must name an owner (migration 028), and the rejection went to a console
// log nobody was reading. The feature was fully implemented, fully documented,
// and completely inert -- and nothing in the application would ever have said
// so, because "the Trash still has things in it" looks exactly like "nothing is
// old enough to remove yet".
//
// That is the specific shape of bug a unit test cannot catch: every piece
// worked, and the wiring between them did not. So this exercises the real
// scheduler tick against the real database.
//
// It creates its own user and its own expired file, and removes both.
//
//   node scripts/verify-trash-purge.js
require("dotenv").config();
const db = require("../src/config/database");
const lifecycleService = require("../src/services/lifecycleService");
const purgeTrashProcessor = require("../src/jobs/processors/purgeTrashProcessor");
const pgQueue = require("../src/queues/pgQueue");

const TAG = `verify-trash-${Date.now()}`;
let failures = 0;
const cleanup = { users: [], files: [], locations: [], jobs: [] };

function check(ok, label, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  // Paused so a live worker cannot run the purge before the assertions do.
  await pgQueue.setPaused(true, TAG);

  console.log("\n1. set up two owners, each with one long-expired file");
  const owners = [];
  for (const n of [1, 2]) {
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', $2) RETURNING id`,
      [`${TAG}-${n}@example.invalid`, `${TAG} owner ${n}`]
    );
    owners.push(rows[0].id);
    cleanup.users.push(rows[0].id);
  }

  // ONE STORAGE LOCATION PER OWNER, which is not optional.
  //
  // The first version of this script created one location and inserted both
  // files against it with different owner_user_id values. Both came back owned
  // by the same person, and the purge then looked like a cross-account delete.
  // It was not: `trg_files_inherit_owner` (migration 028) forces a file's owner
  // to the owner of its storage location on INSERT, so the column simply cannot
  // be set independently. The fixture was wrong, not the scoping -- and the
  // trigger is the reason the ownership model actually holds rather than merely
  // being written down.
  const locationIds = [];
  for (let i = 0; i < owners.length; i += 1) {
    const { rows } = await db.query(
      `INSERT INTO storage_locations (name, type, root_path, access_mode, owner_user_id)
       VALUES ($1, 'local', $2, 'direct', $3) RETURNING id`,
      [`${TAG}-loc-${i}`, `C:\${TAG}-${i}`, owners[i]]
    );
    locationIds.push(rows[0].id);
    cleanup.locations.push(rows[0].id);
  }

  const fileIds = [];
  for (let i = 0; i < owners.length; i += 1) {
    const { rows } = await db.query(
      `INSERT INTO files (storage_location_id, filename_current, filename_original,
                          original_path, current_path, size_bytes,
                          status, deleted_at, owner_user_id)
       VALUES ($1,$2,$2,$3,$3,1,'deleted', now() - interval '400 days', $4)
       RETURNING id, owner_user_id`,
      [locationIds[i], `${TAG}-${i}.txt`, `C:\${TAG}-${i}\${TAG}-${i}.txt`, owners[i]]
    );
    fileIds.push(rows[0].id);
    cleanup.files.push(rows[0].id);
    check(rows[0].owner_user_id === owners[i], `file ${i} is owned by owner ${i + 1}`);
  }
  check(fileIds.length === 2, "two expired files created, one per owner");

  console.log("\n2. the scheduler finds both owners, and only via ids");
  const found = await lifecycleService.findOwnersWithExpired({ retentionDays: 30 });
  check(found.includes(owners[0]) && found.includes(owners[1]), "both owners are listed");
  check(
    found.every((o) => typeof o === "string"),
    "the cross-account query returns ids only, no file data"
  );

  console.log("\n3. findExpired refuses to run unscoped");
  let refused = false;
  try {
    await lifecycleService.findExpired({ retentionDays: 30 });
  } catch (err) {
    refused = /Ownership scope missing/.test(err.message);
  }
  check(refused, "an ownerless findExpired throws rather than reading every account");

  console.log("\n4. a purge deletes ONLY its own owner's files");
  const beforeOther = await db.query("SELECT id FROM files WHERE id = $1", [fileIds[1]]);
  const result = await purgeTrashProcessor.handle({ retentionDays: 30, ownerUserId: owners[0] });
  check(result.purged === 1, "owner 1's purge removed exactly one file", `purged=${result.purged}`);

  const { rows: gone } = await db.query("SELECT id FROM files WHERE id = $1", [fileIds[0]]);
  check(gone.length === 0, "owner 1's expired file is gone");
  const { rows: survived } = await db.query("SELECT id FROM files WHERE id = $1", [fileIds[1]]);
  check(beforeOther.rows.length === 1 && survived.length === 1, "owner 2's file was NOT touched");

  console.log("\n5. an audit entry survives the file it describes");
  const { rows: audit } = await db.query(
    "SELECT action, reason FROM audit_logs WHERE entity_id = $1 AND action = 'file.purged'",
    [fileIds[0]]
  );
  check(audit.length === 1, "a file.purged audit row was written");
  check(/was not touched/.test(audit[0]?.reason || ""), "the audit reason records that the original is untouched");

  console.log("\n6. the scheduler enqueues one owned job per owner");
  const { enqueueJob } = require("../src/queues");
  const { JobType } = require("../src/models/enums");
  const job = await enqueueJob(JobType.PURGE_TRASH, { retentionDays: 30, ownerUserId: owners[1] }, { ownerUserId: owners[1] });
  cleanup.jobs.push(job.id);
  check(!!job.id, "purge_trash now enqueues at all (it never used to)");
  check(job.owner_user_id === owners[1], "the job row names its owner", job.owner_user_id);
  check(job.status === "queued", "and is queued for the worker", job.status);
}

main()
  .catch((err) => {
    console.error("\nverify-trash-purge crashed:", err);
    failures += 1;
  })
  .finally(async () => {
    await pgQueue.setPaused(false).catch(() => {});
    // Order matters: jobs and files reference the location and the users.
    if (cleanup.jobs.length) await db.query("DELETE FROM processing_jobs WHERE id = ANY($1::uuid[])", [cleanup.jobs]).catch(() => {});
    if (cleanup.files.length) await db.query("DELETE FROM files WHERE id = ANY($1::uuid[])", [cleanup.files]).catch(() => {});
    await db.query("DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])", [cleanup.files]).catch(() => {});
    if (cleanup.locations.length) await db.query("DELETE FROM storage_locations WHERE id = ANY($1::uuid[])", [cleanup.locations]).catch(() => {});
    if (cleanup.users.length) await db.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [cleanup.users]).catch(() => {});
    await db.pool.end().catch(() => {});
    console.log(failures === 0 ? "\nAll checks passed. Test data removed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
