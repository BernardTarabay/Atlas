// Proves the triage queue (task #42) tells the truth.
//
// The unit tests cover the retry PLAN, which is pure JS. What they cannot
// cover is the part that decides who is in the queue at all: one CASE over
// five joins, where every failure mode is "a file silently in the wrong
// bucket". The two ways that goes wrong are opposites and both are bad:
//
//   a healthy file listed as stuck -- during an import that is thousands of
//   files, and the queue becomes noise nobody reads.
//   a stuck file NOT listed -- which is the original bug, just with a page
//   in front of it now.
//
// So this builds one file per state, runs the real query, and checks each
// landed under exactly the reason it should have.
//
//   node scripts/verify-triage.js

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const env = require("../src/config/env");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const fileContentRepository = require("../src/repositories/fileContentRepository");
const triageRepository = require("../src/repositories/triageRepository");
const triageService = require("../src/services/triageService");
const { closeAllQueues } = require("../src/queues");
const { dequeueFixtureJobs, pauseQueues, resumeQueues } = require("./_fixtureQueue");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

let root, locId;

async function cleanup() {
  try {
    if (locId) {
      const ids = `(SELECT id FROM files WHERE storage_location_id='${locId}')`;
      await p.query(`DELETE FROM rename_proposals      WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM classification_results WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_content          WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_metadata         WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_hashes           WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM audit_logs WHERE entity_type='file' AND entity_id IN ${ids}`);
      // Per-file jobs are matched by payload, not by a foreign key, so they
      // have to be cleared the same way the query finds them.
      await p.query(
        `DELETE FROM processing_jobs WHERE storage_location_id=$1 OR payload->>'fileId' IN
           (SELECT id::text FROM files WHERE storage_location_id=$1)`, [locId]);
      await p.query(`DELETE FROM filesystem_scans WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM files            WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM storage_locations WHERE id=$1`, [locId]);
    }
    if (root) await fsp.rm(root, { recursive: true, force: true });
    console.log("\ncleaned up.");
  } catch (e) { console.log("cleanup warning:", e.message); }
  // Hand the queues back to whatever worker is running, even if the
  // script threw part-way through.
  await resumeQueues().catch(() => {});
  await p.end(); await closeAllQueues();
}

/** A processing_jobs row in a chosen state, without going through Redis. */
async function fakeJob(fileId, { jobType, status, finishedMinutesAgo = null, error = null, payload = null }) {
  const { rows } = await p.query(
    `INSERT INTO processing_jobs (job_type, status, payload, error_message, finished_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL
                                  ELSE now() - make_interval(mins => $5::int) END)
     RETURNING id`,
    [jobType, status, payload || { fileId }, error, finishedMinutesAgo]
  );
  return rows[0].id;
}

(async () => {
  // A live worker would otherwise process these fixtures out from under
  // the assertions -- see scripts/_fixtureQueue.js.
  await pauseQueues();
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-triage-"));

  // Named for the state each one is put into below, so a failure line reads
  // as a sentence.
  const NAMES = [
    "never-hashed.pdf", "hashed-no-content.pdf", "scan-no-text-layer.pdf",
    "gibberish.doc", "perfectly-fine.pdf", "job-failed-long-ago.pdf",
    "job-failed-just-now.pdf", "still-queued.pdf", "gone-from-disk.pdf",
    "unreadable-but-named.pdf", "text-never-stored.pdf",
  ];
  for (const n of NAMES) await fsp.writeFile(path.join(root, n), "x".repeat(2048));

  const admin = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
  // Every read below is owner-scoped (repositories/ownership.js): the owner is
  // a required argument, not an optional narrowing, so a fixture that omits it
  // throws rather than quietly reading the whole instance.
  const ownerId = admin.id;
  const loc = await storageLocationService.create(
    { name: "Triage Test", type: "local", rootPath: root, accessMode: "direct" }, admin.id);
  locId = loc.id;
  await scanProcessor.handle({ storageLocationId: locId });

  // The scan enqueues a hash job per file, which would make every fixture
  // "in flight" and correctly exclude the lot. Clear them so each file's
  // state is only what this script sets below.
  await dequeueFixtureJobs(p, locId);

  const f = {};
  for (const r of (await p.query("SELECT * FROM files WHERE storage_location_id=$1", [locId])).rows) {
    f[r.filename_current] = r;
  }
  const idOf = (n) => f[n].id;
  const setHash = (n) => p.query("UPDATE files SET sha256_hash=$2 WHERE id=$1", [idOf(n), `hash-${n}`]);

  // --- put each file into exactly one state -------------------------------

  // never-hashed.pdf: left exactly as the scan created it.

  await setHash("hashed-no-content.pdf");

  await setHash("scan-no-text-layer.pdf");
  await fileContentRepository.upsert(idOf("scan-no-text-layer.pdf"),
    { extractedText: "", textQuality: "no_text_layer", needsOcr: true });

  await setHash("gibberish.doc");
  await fileContentRepository.upsert(idOf("gibberish.doc"),
    { extractedText: "T h i s i s n o t t e x t", textQuality: "gibberish", needsOcr: false });

  await setHash("perfectly-fine.pdf");
  await fileContentRepository.upsert(idOf("perfectly-fine.pdf"),
    { extractedText: "A readable document with real sentences in it.", textQuality: "ok", needsOcr: false });

  await setHash("job-failed-long-ago.pdf");
  await fileContentRepository.upsert(idOf("job-failed-long-ago.pdf"),
    { extractedText: "Readable.", textQuality: "ok", needsOcr: false });
  await fakeJob(idOf("job-failed-long-ago.pdf"), {
    jobType: "classify", status: "failed", finishedMinutesAgo: 60, error: "Gemini request timed out",
  });

  // Inside BullMQ's retry ladder: still failed in the table, but about to be
  // attempted again. Listing it would be a false alarm.
  await setHash("job-failed-just-now.pdf");
  await fileContentRepository.upsert(idOf("job-failed-just-now.pdf"),
    { extractedText: "Readable.", textQuality: "ok", needsOcr: false });
  await fakeJob(idOf("job-failed-just-now.pdf"), {
    jobType: "classify", status: "failed", finishedMinutesAgo: 1, error: "transient",
  });

  // Unreadable AND queued: waiting its turn is not being stuck.
  await setHash("still-queued.pdf");
  await fileContentRepository.upsert(idOf("still-queued.pdf"),
    { extractedText: "", textQuality: "no_text_layer", needsOcr: true });
  await fakeJob(idOf("still-queued.pdf"), { jobType: "extract_text", status: "queued" });

  await setHash("gone-from-disk.pdf");
  await p.query("UPDATE files SET status='missing' WHERE id=$1", [idOf("gone-from-disk.pdf")]);

  // A human already gave this one a name, which is the whole thing triage
  // was asking for.
  await setHash("unreadable-but-named.pdf");
  await fileContentRepository.upsert(idOf("unreadable-but-named.pdf"),
    { extractedText: "", textQuality: "no_text_layer", needsOcr: true });
  await p.query(
    "UPDATE files SET canonical_filename='Convention de Bail 2024.pdf' WHERE id=$1",
    [idOf("unreadable-but-named.pdf")]);

  await setHash("text-never-stored.pdf");
  await p.query(
    `INSERT INTO file_content (file_id, extracted_text, extraction_status, extraction_error, extracted_at)
     VALUES ($1, '', 'failed', 'Could not store extracted text: invalid byte sequence', now())`,
    [idOf("text-never-stored.pdf")]);

  // --- what the queue says ------------------------------------------------

  console.log("\nreading the triage queue:\n");

  const rows = await triageRepository.list(ownerId, { limit: 200 });
  const mine = rows.filter((r) => r.storage_location_id === locId);
  const reasonOf = Object.fromEntries(mine.map((r) => [r.filename_current, r.reason]));

  const EXPECTED = {
    "never-hashed.pdf": "stalled",
    "hashed-no-content.pdf": "stalled",
    "scan-no-text-layer.pdf": "needs_ocr",
    "gibberish.doc": "unreadable",
    "job-failed-long-ago.pdf": "job_failed",
    "gone-from-disk.pdf": "missing",
    "text-never-stored.pdf": "extraction_failed",
  };
  for (const [name, expected] of Object.entries(EXPECTED)) {
    check(`"${name}" is listed as ${expected}`, reasonOf[name] === expected,
      reasonOf[name] ? `got "${reasonOf[name]}"` : "not listed at all");
  }

  const EXCLUDED = {
    "perfectly-fine.pdf": "nothing is wrong with it",
    "job-failed-just-now.pdf": "its job is still inside the retry window",
    "still-queued.pdf": "a job is queued for it",
    "unreadable-but-named.pdf": "a human has already named it",
  };
  for (const [name, why] of Object.entries(EXCLUDED)) {
    check(`"${name}" is NOT listed (${why})`, reasonOf[name] === undefined,
      reasonOf[name] ? `wrongly listed as "${reasonOf[name]}"` : "");
  }

  check("each file appears at most once, under its most serious reason",
    mine.length === new Set(mine.map((r) => r.id)).size, `${mine.length} rows`);

  // --- ordering, filtering, counting --------------------------------------

  const severity = mine.map((r) => r.reason);
  const rank = ["missing", "job_failed", "extraction_failed", "stalled", "needs_ocr", "unreadable"];
  check("rows come back most-serious-first",
    severity.every((r, i) => i === 0 || rank.indexOf(severity[i - 1]) <= rank.indexOf(r)),
    severity.join(" > "));

  const stalledOnly = (await triageRepository.list(ownerId, { reason: "stalled", limit: 200 }))
    .filter((r) => r.storage_location_id === locId);
  check("?reason=stalled returns only stalled files",
    stalledOnly.length === 2 && stalledOnly.every((r) => r.reason === "stalled"),
    `${stalledOnly.length} rows`);

  const counts = await triageRepository.countByReason(ownerId);
  check("the summary counts agree with the rows themselves",
    Object.entries(EXPECTED).every(([, reason]) =>
      (counts.byReason[reason] || 0) >= mine.filter((r) => r.reason === reason).length),
    JSON.stringify(counts.byReason));
  check("the in-flight count sees the queued file", counts.inFlight >= 1, `${counts.inFlight}`);

  let rejected = null;
  try { await triageService.list({ reason: "made_up" }, ownerId); }
  catch (err) { rejected = err.message; }
  check("an unknown ?reason= is rejected rather than silently ignored",
    Boolean(rejected) && /Unknown triage reason/.test(rejected || ""), rejected || "(accepted!)");

  // --- retry --------------------------------------------------------------

  console.log("\nretrying:\n");

  const stalledRetry = await triageService.retry(idOf("never-hashed.pdf"), admin.id);
  check("retrying a never-hashed file restarts at hashing", stalledRetry.jobType === "hash",
    stalledRetry.jobType);

  const failedRetry = await triageService.retry(idOf("job-failed-long-ago.pdf"), admin.id);
  check("retrying a failed job re-runs that same job", failedRetry.jobType === "classify",
    failedRetry.jobType);

  const enqueued = (await p.query(
    `SELECT job_type FROM processing_jobs
      WHERE payload->>'fileId' = $1 AND status = 'queued'`, [idOf("never-hashed.pdf")])).rows;
  check("the retry really created a queued job row", enqueued.length === 1,
    enqueued.map((r) => r.job_type).join(", ") || "(none)");

  let blocked = null;
  try { await triageService.retry(idOf("gone-from-disk.pdf"), admin.id); }
  catch (err) { blocked = err.message; }
  check("retrying a missing file is refused, with a reason", /rescan/i.test(blocked || ""),
    blocked || "(it was allowed!)");

  let notInQueue = null;
  try { await triageService.retry(idOf("perfectly-fine.pdf"), admin.id); }
  catch (err) { notInQueue = err.message; }
  check("retrying a healthy file is refused", /not in the triage queue/i.test(notInQueue || ""),
    notInQueue || "(it was allowed!)");

  // Retried files must LEAVE the queue -- otherwise pressing retry looks
  // like it did nothing, which is how you end up pressing it forty times.
  const after = (await triageRepository.list(ownerId, { limit: 200 }))
    .filter((r) => r.storage_location_id === locId)
    .map((r) => r.filename_current);
  check("a retried file drops out of the queue while its job is in flight",
    !after.includes("never-hashed.pdf"), after.join(", "));

  const audited = (await p.query(
    "SELECT count(*)::int n FROM audit_logs WHERE action='triage.retried' AND entity_id=$1",
    [idOf("never-hashed.pdf")])).rows[0].n;
  check("the retry is recorded in the audit log, not silent", audited === 1, `${audited} entries`);

  console.log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
  if (failed > 0) process.exitCode = 1;
})().catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; }).finally(cleanup);
