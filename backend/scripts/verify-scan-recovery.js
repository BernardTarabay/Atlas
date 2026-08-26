// Proves the scan recovers files whose processing work was lost, and -- just
// as important -- that it does NOT re-queue files that are simply waiting
// their turn.
//
// The failure this guards against is silent by nature: a file row exists, so
// the file shows up in the list, but it has no hash and no extracted text, so
// it is invisible to search. Before the fix, every later scan looked at that
// file, saw its size and mtime were unchanged, and skipped it forever.
//
// Four cases, because a recovery that over-fires is its own bug -- re-queueing
// everything on every scan would multiply the backlog an import is already
// stuck behind.
//
//   1. healthy      fully processed          -> must NOT be re-queued
//   2. lost         no hash, no job in flight -> MUST be re-queued
//   3. in flight    no hash, job queued       -> must NOT be re-queued
//   4. half done    hashed but no content     -> MUST be re-queued
//
//   node scripts/verify-scan-recovery.js

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const env = require("../src/config/env");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const hashProcessor = require("../src/jobs/processors/hashProcessor");
const extractTextProcessor = require("../src/jobs/processors/extractTextProcessor");
const fileRepository = require("../src/repositories/fileRepository");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
const log = (...a) => console.log(...a);
let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed += 1; log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
}

let root, locId;

async function cleanup() {
  try {
    if (locId) {
      const ids = `(SELECT id FROM files WHERE storage_location_id='${locId}')`;
      await p.query(`DELETE FROM duplicate_group_members WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM classification_results  WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM rename_proposals        WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_content            WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_metadata           WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_hashes             WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM audit_logs WHERE entity_type='file' AND entity_id IN ${ids}`);
      await p.query(`DELETE FROM processing_jobs  WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM filesystem_scans WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM files            WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM storage_locations WHERE id=$1`, [locId]);
    }
    if (root) await fsp.rm(root, { recursive: true, force: true });
    log("\ncleaned up.");
  } catch (e) { log("cleanup warning:", e.message); }
  await p.end(); await closeAllQueues();
}

const jobsFor = async (fileId, statuses = ["queued", "running"]) =>
  (await p.query(
    `SELECT id, job_type, status FROM processing_jobs
      WHERE payload->>'fileId' = $1 AND status = ANY($2)`, [fileId, statuses])).rows;

(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-recovery-"));
  const NAMES = ["healthy.txt", "lost.txt", "inflight.txt", "halfdone.txt"];
  for (const n of NAMES) {
    // Long enough that extraction has something to do; .txt has no extractor,
    // so the content row is written with an empty body -- which is exactly
    // what "has been processed" looks like for an unsupported format, and the
    // recovery query must treat that as done, not as missing.
    await fsp.writeFile(path.join(root, n), `contents of ${n}\n`.repeat(50));
  }
  log("source folder:", root);

  const admin = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
  const loc = await storageLocationService.create(
    { name: "Recovery Test", type: "local", rootPath: root, accessMode: "direct" }, admin.id);
  locId = loc.id;

  // --- first scan: discover everything, then process it for real ----------
  const scan1 = await scanProcessor.handle({ storageLocationId: locId });
  log(`\nscan 1: discovered ${scan1.discovered}, new ${scan1.new}, recovered ${scan1.recovered}`);
  check("first scan recovers nothing", scan1.recovered === 0, `recovered=${scan1.recovered}`);

  const files = {};
  for (const row of (await p.query("SELECT * FROM files WHERE storage_location_id=$1", [locId])).rows) {
    files[row.filename_current] = row;
  }
  check("all four files discovered", Object.keys(files).length === 4, Object.keys(files).join(", "));

  // Run the real processors so these files are genuinely complete.
  for (const n of NAMES) {
    await hashProcessor.handle({ fileId: files[n].id });
    await extractTextProcessor.handle({ fileId: files[n].id });
  }
  // Clear the jobs those stages fanned out, so "in flight" below means only
  // what this test deliberately puts there.
  await p.query(`UPDATE processing_jobs SET status='completed'
                  WHERE storage_location_id=$1 AND status IN ('queued','running')`, [locId]);

  // --- now break things in four different ways ----------------------------
  log("\nsimulating lost work:");

  // 2. lost: hash and content gone, nothing queued (a crash mid-import).
  await p.query("UPDATE files SET sha256_hash=NULL WHERE id=$1", [files["lost.txt"].id]);
  await p.query("DELETE FROM file_content WHERE file_id=$1", [files["lost.txt"].id]);
  log("   lost.txt      hash + content removed, no job queued");

  // 3. in flight: same damage, but a job IS waiting for it.
  await p.query("UPDATE files SET sha256_hash=NULL WHERE id=$1", [files["inflight.txt"].id]);
  await p.query("DELETE FROM file_content WHERE file_id=$1", [files["inflight.txt"].id]);
  await p.query(
    `INSERT INTO processing_jobs (job_type, status, storage_location_id, payload)
     VALUES ('hash','queued',$1,$2)`,
    [locId, JSON.stringify({ fileId: files["inflight.txt"].id })]);
  log("   inflight.txt  hash + content removed, hash job left queued");

  // 4. half done: hashed, but extraction never landed.
  await p.query("DELETE FROM file_content WHERE file_id=$1", [files["halfdone.txt"].id]);
  log("   halfdone.txt  content removed, hash intact");
  log("   healthy.txt   untouched");

  // --- second scan: the one that has to heal ------------------------------
  const before = Object.fromEntries(await Promise.all(
    NAMES.map(async (n) => [n, (await jobsFor(files[n].id)).length])));

  const scan2 = await scanProcessor.handle({ storageLocationId: locId });
  log(`\nscan 2: discovered ${scan2.discovered}, new ${scan2.new}, recovered ${scan2.recovered}`);

  const after = Object.fromEntries(await Promise.all(
    NAMES.map(async (n) => [n, (await jobsFor(files[n].id)).length])));
  const requeued = (n) => after[n] > before[n];

  check("scan reports 2 recovered", scan2.recovered === 2, `recovered=${scan2.recovered}`);
  check("scan created no duplicate file rows", scan2.new === 0, `new=${scan2.new}`);
  check("lost.txt was re-queued", requeued("lost.txt"), `${before["lost.txt"]} -> ${after["lost.txt"]}`);
  check("halfdone.txt was re-queued", requeued("halfdone.txt"), `${before["halfdone.txt"]} -> ${after["halfdone.txt"]}`);
  check("healthy.txt was NOT re-queued", !requeued("healthy.txt"), `${before["healthy.txt"]} -> ${after["healthy.txt"]}`);
  check("inflight.txt was NOT re-queued", !requeued("inflight.txt"), `${before["inflight.txt"]} -> ${after["inflight.txt"]}`);

  // --- the recovery must actually repair the file, not just enqueue --------
  await hashProcessor.handle({ fileId: files["lost.txt"].id });
  await extractTextProcessor.handle({ fileId: files["lost.txt"].id });
  const repaired = await fileRepository.findById(files["lost.txt"].id);
  const content = (await p.query("SELECT 1 FROM file_content WHERE file_id=$1", [files["lost.txt"].id])).rowCount;
  check("lost.txt has a hash again", Boolean(repaired.sha256_hash), repaired.sha256_hash?.slice(0, 16));
  check("lost.txt has a content row again", content === 1);

  // --- and a third scan must go quiet ------------------------------------
  await p.query(`UPDATE processing_jobs SET status='completed'
                  WHERE storage_location_id=$1 AND status IN ('queued','running')`, [locId]);
  // halfdone/inflight are still incomplete by design; only lost.txt is fixed.
  await p.query("DELETE FROM files WHERE id = ANY($1)",
    [[files["halfdone.txt"].id, files["inflight.txt"].id]]);
  const scan3 = await scanProcessor.handle({ storageLocationId: locId });
  check("a scan over healthy files recovers nothing", scan3.recovered === 0, `recovered=${scan3.recovered}`);

  // --- the count the UI renders -------------------------------------------
  // Owner-scoped since migration 028. storageLocationService.js:49 -- the
  // production caller -- has always passed it; this script called the
  // repository directly and so never did, which threw once requireOwner
  // started refusing a missing owner instead of quietly returning everything.
  const backlog = await fileRepository.countBacklogByLocation(admin.id);
  log(`\nbacklog reported for this location: ${JSON.stringify(backlog[locId] || { inFlight: 0, stalled: 0 })}`);

  log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
  if (failed > 0) process.exitCode = 1;
})().catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; }).finally(cleanup);
