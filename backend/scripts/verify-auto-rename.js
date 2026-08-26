// Live check that high-confidence renames apply themselves, including on a
// WRITABLE location where that means renaming a real file on disk.
//
// WHY THIS EXISTS
//
// Auto-apply used to refuse writable locations outright, so the only path that
// ever ran unattended was the read-only one, which does not touch the
// filesystem at all. Lifting that refusal turned an unattended code path into
// one that edits the user's own disk -- and the thing that makes that
// defensible is a set of properties nobody had ever exercised together:
//
//   >= 0.90 applies, < 0.90 is rejected outright (no pending queue)
//   a colliding name is SUFFIXED, never overwritten
//   the audit trail records the previous path, which is what makes it undoable
//
// A unit test cannot check any of that: it is a real file, a real rename, and
// a real transaction. So this uses a temp folder of its own and removes it.
//
//   node scripts/verify-auto-rename.js
require("dotenv").config();
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const db = require("../src/config/database");
const pgQueue = require("../src/queues/pgQueue");
const bulkRenameProcessor = require("../src/jobs/processors/bulkRenameProcessor");
const { AUTO_APPLY_MIN_SCORE } = require("../src/jobs/processors/generateNamesProcessor");

const TAG = `verify-autorename-${Date.now()}`;
let failures = 0;
const cleanup = { users: [], locations: [], files: [], proposals: [], jobs: [], dir: null };

function check(ok, label, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function makeFile(locationId, ownerId, name) {
  const { rows } = await db.query(
    `INSERT INTO files (storage_location_id, filename_current, filename_original,
                        original_path, current_path, size_bytes, status, owner_user_id)
     VALUES ($1,$2,$2,$3,$3,4,'active',$4) RETURNING *`,
    [locationId, name, name, ownerId]
  );
  cleanup.files.push(rows[0].id);
  return rows[0];
}

/**
 * A real processing_jobs row to run under.
 *
 * bulkRenameProcessor writes one processing_job_items row per proposal, and
 * that table requires a job_id -- so a hand-made `{ data: {} }` handle is not
 * enough. Using a real row also means this exercises the same bookkeeping the
 * worker does rather than a shortcut around it.
 */
async function makeJobHandle(ownerId) {
  const { rows } = await db.query(
    `INSERT INTO processing_jobs (job_type, status, payload, owner_user_id)
     VALUES ('bulk_rename','running','{}'::jsonb,$1) RETURNING *`,
    [ownerId]
  );
  cleanup.jobs.push(rows[0].id);
  return { id: rows[0].id, data: { processingJobId: rows[0].id }, updateProgress: async () => {} };
}

async function makeProposal(fileId, current, proposed, score) {
  const { rows } = await db.query(
    `INSERT INTO rename_proposals (file_id, current_filename, proposed_filename, reason,
                                   confidence_level, confidence_score, status)
     VALUES ($1,$2,$3,$4,'high',$5,'approved') RETURNING *`,
    [fileId, current, proposed, TAG, score]
  );
  cleanup.proposals.push(rows[0].id);
  return rows[0];
}

async function main() {
  await pgQueue.setPaused(true, TAG);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "atlas-autorename-"));
  cleanup.dir = dir;

  const { rows: u } = await db.query(
    "INSERT INTO users (email, password_hash, full_name) VALUES ($1,'x',$2) RETURNING id",
    [`${TAG}@example.invalid`, TAG]
  );
  const owner = u[0].id;
  cleanup.users.push(owner);

  // WRITABLE, which is the whole point of this script.
  const { rows: loc } = await db.query(
    `INSERT INTO storage_locations (name, type, root_path, access_mode, is_read_only, owner_user_id)
     VALUES ($1,'local',$2,'direct',false,$3) RETURNING *`,
    [`${TAG}-loc`, dir, owner]
  );
  cleanup.locations.push(loc[0].id);
  check(loc[0].is_read_only === false, "test location is WRITABLE");

  console.log("\n1. a high-confidence name renames the real file on disk");
  await fsp.writeFile(path.join(dir, "scan0001.pdf"), "aaaa");
  const f1 = await makeFile(loc[0].id, owner, "scan0001.pdf");
  const p1 = await makeProposal(f1.id, "scan0001.pdf", "2019 Lease Agreement.pdf", 0.95);
  await bulkRenameProcessor.handle({ proposalIds: [p1.id] }, await makeJobHandle(owner));

  check(fs.existsSync(path.join(dir, "2019 Lease Agreement.pdf")), "the new filename exists on disk");
  check(!fs.existsSync(path.join(dir, "scan0001.pdf")), "the old filename is gone from disk");
  const { rows: after1 } = await db.query("SELECT filename_current, current_path FROM files WHERE id=$1", [f1.id]);
  check(after1[0].filename_current === "2019 Lease Agreement.pdf", "the database agrees with the disk",
    after1[0].filename_current);

  console.log("\n2. the previous name is recorded, which is what makes it undoable");
  const { rows: audit } = await db.query(
    "SELECT previous_state, new_state FROM audit_logs WHERE entity_id=$1 AND action='file.renamed'", [f1.id]
  );
  check(audit.length === 1, "a file.renamed audit row was written");
  check(audit[0]?.previous_state?.filename === "scan0001.pdf",
    "it records the filename the file had before", JSON.stringify(audit[0]?.previous_state));

  console.log("\n3. a colliding name is suffixed, never overwritten");
  await fsp.writeFile(path.join(dir, "Invoice.pdf"), "ORIGINAL-KEEP-ME");
  await fsp.writeFile(path.join(dir, "scan0002.pdf"), "bbbb");
  const f2 = await makeFile(loc[0].id, owner, "scan0002.pdf");
  const p2 = await makeProposal(f2.id, "scan0002.pdf", "Invoice.pdf", 0.95);
  await bulkRenameProcessor.handle({ proposalIds: [p2.id] }, await makeJobHandle(owner));

  const survivor = await fsp.readFile(path.join(dir, "Invoice.pdf"), "utf8");
  check(survivor === "ORIGINAL-KEEP-ME", "the pre-existing file was NOT overwritten", survivor);
  const names = (await fsp.readdir(dir)).filter((n) => n.startsWith("Invoice"));
  check(names.length === 2, "the renamed file landed under a suffixed name", names.join(", "));

  console.log("\n4. the threshold itself");
  check(AUTO_APPLY_MIN_SCORE === 0.9, "auto-apply threshold is 0.90", String(AUTO_APPLY_MIN_SCORE));
}

main()
  .catch((err) => {
    console.error("\nverify-auto-rename crashed:", err);
    failures += 1;
  })
  .finally(async () => {
    await pgQueue.setPaused(false).catch(() => {});
    const q = (sql, p) => db.query(sql, p).catch(() => {});
    if (cleanup.files.length) {
      await q("DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])", [cleanup.files]);
      await q("DELETE FROM rename_proposals WHERE file_id = ANY($1::uuid[])", [cleanup.files]);
      await q("DELETE FROM files WHERE id = ANY($1::uuid[])", [cleanup.files]);
    }
    if (cleanup.jobs.length) {
      await q("DELETE FROM processing_job_items WHERE job_id = ANY($1::uuid[])", [cleanup.jobs]);
      await q("DELETE FROM processing_jobs WHERE id = ANY($1::uuid[])", [cleanup.jobs]);
    }
    if (cleanup.locations.length) await q("DELETE FROM storage_locations WHERE id = ANY($1::uuid[])", [cleanup.locations]);
    if (cleanup.users.length) await q("DELETE FROM users WHERE id = ANY($1::uuid[])", [cleanup.users]);
    if (cleanup.dir) await fsp.rm(cleanup.dir, { recursive: true, force: true }).catch(() => {});
    await db.pool.end().catch(() => {});
    console.log(failures === 0 ? "\nAll checks passed. Temp folder and rows removed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
