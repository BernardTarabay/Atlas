// Proves the scan recovers files whose processing work was lost, and -- just
// as important -- that it does NOT re-queue files that are simply waiting
// their turn.
//
// The failure this guards against is silent by nature: a file row exists, so
// the file shows up in the list, but it has no hash and no extracted text, so
// it is invisible to search. Before the fix, every later scan looked at that
// file, saw its size and mtime were unchanged, and skipped it forever.
//
// Five cases, because a recovery that OVER-fires is its own bug, and a worse
// one. Under-firing leaves a file unsearchable until the next scan; over-firing
// re-queues the same files on every scan forever, and that is not hypothetical
// -- it produced 7.8 million job rows and a 4.6 GB queue table on a 7,260-file
// library while every health signal read "ok".
//
//   1. healthy      fully processed              -> must NOT be re-queued
//   2. lost         'discovered', no job queued  -> MUST be re-queued
//   3. in flight    'discovered', job queued     -> must NOT be re-queued
//   4. half done    hashed, extraction never ran -> MUST be re-queued
//   5. photo        FINISHED with no content row -> must NOT be re-queued
//
// Case 5 is the regression test for the incident above. "Has no extracted-text
// row" is a permanent property of an image, not a sign of lost work, and a
// recovery pass that cannot tell those apart never stops running.
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
  // photo.txt is not a typo. It stands in for the case that broke this system:
  // a file the pipeline legitimately finishes WITHOUT ever writing a
  // file_content row. In production that is every image -- hashProcessor routes
  // them to needs_user with "A photo, have a look and file it", and a
  // photograph has no text layer to extract, ever.
  //
  // The recovery query used to select on "has no file_content row", which is a
  // permanent property of such a file rather than a statement about progress.
  // So every scan rediscovered every image and re-queued it from hashing:
  // 1,426 images x 1,370 scans = 1.94 million hash jobs and a 4.6 GB queue
  // table behind a 48 MB library, with every health signal reading "ok"
  // because the queue drained as fast as it filled.
  //
  // Kept as .txt so the fixture needs no real image bytes; what is being
  // asserted is the STATE, which is set explicitly below.
  const NAMES = ["healthy.txt", "lost.txt", "inflight.txt", "halfdone.txt", "photo.txt"];
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
  check("all five files discovered", Object.keys(files).length === NAMES.length, Object.keys(files).join(", "));

  // Run the real processors so these files are genuinely complete.
  for (const n of NAMES) {
    await hashProcessor.handle({ fileId: files[n].id });
    await extractTextProcessor.handle({ fileId: files[n].id });
  }
  // Clear the jobs those stages fanned out, so "in flight" below means only
  // what this test deliberately puts there.
  await p.query(`UPDATE processing_jobs SET status='completed'
                  WHERE storage_location_id=$1 AND status IN ('queued','running')`, [locId]);

  // FINISH THE PIPELINE THAT THIS FIXTURE ONLY RUNS HALF OF.
  //
  // Only two processors transition pipeline_state: hashProcessor (for images,
  // media and known content) and generateNamesProcessor (for everything else,
  // at the very end). extract_text, extract_metadata and classify deliberately
  // do not touch it. So a real .txt document sits at 'discovered' for its
  // ENTIRE journey and only becomes 'completed' at the last stage.
  //
  // Running just hash + extract_text above therefore leaves these files
  // genuinely mid-pipeline, and once their jobs are marked completed they are
  // indistinguishable from a file whose chain broke -- which is exactly what
  // the recovery pass is supposed to catch. The old fixture called that
  // "healthy" because a hash and a content row existed, and that is the
  // artifact-based reasoning this whole change removes.
  //
  // So the fixture says what it means: these files are finished.
  await p.query(
    `UPDATE files SET pipeline_state='completed' WHERE storage_location_id=$1`,
    [locId]);

  // --- now break things in several different ways -------------------------
  //
  // WHAT "LOST WORK" MEANS, AND WHY THE SIMULATION CHANGED
  //
  // These cases used to be simulated by removing ARTIFACTS -- nulling a hash,
  // deleting a file_content row -- because the recovery query selected on
  // whether those artifacts existed. That query now selects on pipeline_state,
  // so the artifacts are no longer what makes a file stranded and the fixture
  // has to say what it actually means.
  //
  // This is a strictly more faithful simulation, not a weaker one. In
  // production a file that finished extraction ALWAYS has a content row --
  // extractTextProcessor writes a 'skipped' row rather than leaving one absent,
  // precisely so a finished file cannot look unprocessed (see
  // fileContentRepository). A file with no row therefore never reached that
  // stage, which means its state is discovered/processing/failed_* -- and each
  // of those is covered, here or by services/fileRecovery.js. The old fixture
  // constructed a state ("extraction succeeded, then its row vanished") that
  // the application has no way to produce.
  log("\nsimulating lost work:");

  // 2. lost: a crash mid-import. Nothing ran, nothing is queued.
  await p.query(
    "UPDATE files SET sha256_hash=NULL, pipeline_state='discovered' WHERE id=$1",
    [files["lost.txt"].id]);
  await p.query("DELETE FROM file_content WHERE file_id=$1", [files["lost.txt"].id]);
  log("   lost.txt      reset to 'discovered', no job queued");

  // 3. in flight: the same damage, but a job IS waiting for it. Must not be
  //    re-queued -- it is behind in a backlog, not stranded.
  await p.query(
    "UPDATE files SET sha256_hash=NULL, pipeline_state='discovered' WHERE id=$1",
    [files["inflight.txt"].id]);
  await p.query("DELETE FROM file_content WHERE file_id=$1", [files["inflight.txt"].id]);
  await p.query(
    `INSERT INTO processing_jobs (job_type, status, storage_location_id, payload)
     VALUES ('hash','queued',$1,$2)`,
    [locId, JSON.stringify({ fileId: files["inflight.txt"].id })]);
  log("   inflight.txt  reset to 'discovered', hash job left queued");

  // 4. half done: hashing landed, extraction never did. Genuinely stranded,
  //    and the state is what says so.
  await p.query("DELETE FROM file_content WHERE file_id=$1", [files["halfdone.txt"].id]);
  await p.query("UPDATE files SET pipeline_state='discovered' WHERE id=$1", [files["halfdone.txt"].id]);
  log("   halfdone.txt  content removed, reset to 'discovered', hash intact");

  // 5. THE REGRESSION CASE. A file the pipeline has finished with that will
  //    never have a content row -- the shape of every image in the archive.
  //    Nothing here is broken and nothing must be re-queued. Under the old
  //    predicate this file was re-queued on every scan, forever.
  await p.query("DELETE FROM file_content WHERE file_id=$1", [files["photo.txt"].id]);
  await p.query("UPDATE files SET pipeline_state='needs_user' WHERE id=$1", [files["photo.txt"].id]);
  log("   photo.txt     content removed, state 'needs_user' -- FINISHED, not stranded");
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
  // The one that cost 1.94 million jobs. A finished file with no content row
  // is finished, and a scan must walk past it every single time.
  check("photo.txt was NOT re-queued", !requeued("photo.txt"), `${before["photo.txt"]} -> ${after["photo.txt"]}`);

  // Re-running the scan a further three times must recover nothing new. One
  // quiet scan proves the predicate; repeated quiet scans prove there is no
  // loop, which is the property that actually failed in production.
  let loopRecovered = 0;
  for (let i = 0; i < 3; i += 1) {
    loopRecovered += (await scanProcessor.handle({ storageLocationId: locId })).recovered;
  }
  check("three further scans recover nothing", loopRecovered === 0, `recovered=${loopRecovered}`);

  // --- the recovery must actually repair the file, not just enqueue --------
  await hashProcessor.handle({ fileId: files["lost.txt"].id });
  await extractTextProcessor.handle({ fileId: files["lost.txt"].id });
  // Same reasoning as the setup block: neither of those stages transitions
  // state, so standing in for the rest of the chain is the fixture's job.
  // Without this the repaired file is still 'discovered' with no live job --
  // correctly stranded again -- and the quiet-scan check below would fail for
  // a reason that has nothing to do with what it is testing.
  await p.query("UPDATE files SET pipeline_state='completed' WHERE id=$1", [files["lost.txt"].id]);
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
