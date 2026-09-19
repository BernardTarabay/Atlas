// The whole point of the system, end to end, with nobody clicking anything:
//
//   drop a file into a watched folder
//     -> watcher notices and queues a scan
//     -> pipeline ingests, hashes, extracts, classifies
//     -> auto-apply names it (read-only, so the original is untouched)
//     -> mirror builds a shortcut under its subject folder
//
// Runs the processors directly rather than through the queue so it needs no
// worker; the watcher itself is real.
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const env = require("../src/config/env");
const { Pool } = require("pg");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const fileRepository = require("../src/repositories/fileRepository");
const renameProposalRepository = require("../src/repositories/renameProposalRepository");
const bulkRenameProcessor = require("../src/jobs/processors/bulkRenameProcessor");
const mirrorService = require("../src/services/mirror/mirrorService");
const { StorageWatcher, shouldIgnore, RECURSIVE_SUPPORTED } = require("../src/jobs/storageWatcher");
const cloudPlaceholder = require("../src/utils/cloudPlaceholder");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (l, ok, d = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${l}${d ? ` -- ${d}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${l}${d ? ` -- ${d}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let source, mirror, locId, watcher, savedMirror;

async function cleanup() {
  try {
    if (watcher) watcher.stop();
    if (locId) {
      await p.query("DELETE FROM rename_proposals WHERE file_id IN (SELECT id FROM files WHERE storage_location_id=$1)", [locId]);
      await p.query("DELETE FROM processing_jobs WHERE storage_location_id=$1", [locId]);
      await p.query("DELETE FROM files WHERE storage_location_id=$1", [locId]);
      await p.query("DELETE FROM filesystem_scans WHERE storage_location_id=$1", [locId]);
      await p.query("DELETE FROM storage_locations WHERE id=$1", [locId]);
    }
    for (const d of [source, mirror]) if (d) await fsp.rm(d, { recursive: true, force: true });
    console.log("\ncleaned up.");
  } catch (e) { console.log("cleanup warning:", e.message); }
  env.mirrorRoot = savedMirror;
  await p.end(); await closeAllQueues();
}

(async () => {
  source = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-rt-src-"));
  mirror = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-rt-mirror-"));
  savedMirror = env.mirrorRoot;
  env.mirrorRoot = mirror;
  env.watch.debounceMs = 500; // keep the test quick

  console.log("watched folder:", source);
  console.log("mirror root:   ", mirror);
  console.log("recursive watching supported here:", RECURSIVE_SUPPORTED);

  const admin = await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1");
  const actor = admin.rows[0].id;
  const loc = await storageLocationService.create(
    { name: "Realtime Test", type: "local", rootPath: source, accessMode: "direct" }, actor);
  locId = loc.id;
  check("location is read-only by default", loc.is_read_only === true);
  check("watching is on by default", loc.watch_enabled === true);
  check("auto-apply is OFF by default", loc.auto_apply_naming === false, "deliberate opt-in");

  // --- noise filtering -------------------------------------------------
  console.log("\n--- files the watcher must ignore ---");
  for (const noisy of ["~$report.docx", "draft.tmp", "big.crdownload", path.join("node_modules", "x.js"), ".~lock.a.odt#"]) {
    check(`ignores ${JSON.stringify(noisy)}`, shouldIgnore(noisy) === true);
  }
  check("does NOT ignore a real document", shouldIgnore(path.join("Finance", "invoice.pdf")) === false);

  // --- the watcher notices a new file ----------------------------------
  console.log("\n--- dropping a file into the watched folder ---");
  await p.query("UPDATE storage_locations SET auto_apply_naming = true WHERE id=$1", [locId]);

  watcher = new StorageWatcher();
  let queued = 0;
  const realEnqueue = require("../src/queues").enqueueJob;
  await watcher.refresh();
  watcher.scheduleScan = ((orig) => function (location) {
    queued += 1;
    return orig.call(this, location);
  })(watcher.scheduleScan);
  await watcher.refresh();

  await fsp.writeFile(path.join(source, "scan_0042.txt"), "Invoice from Couvent St Elie for the month of July 2026.");
  await sleep(1200);
  if (RECURSIVE_SUPPORTED) {
    check("watcher fired on the new file", queued > 0, `${queued} event(s) coalesced`);
  } else {
    console.log("   (skipped: recursive watching unavailable, periodic rescan covers this)");
  }

  // --- ingest ----------------------------------------------------------
  console.log("\n--- ingesting ---");
  const scan = await scanProcessor.handle({ storageLocationId: locId });
  // `new` may be 0 if a live worker already processed the watcher's queued
  // scan before this ran -- which means the real-time path worked. What
  // matters is that the file is indexed exactly once either way.
  check("file is indexed exactly once", scan.discovered === 1,
    JSON.stringify({ discovered: scan.discovered, new: scan.new, alreadyIngestedByWorker: scan.new === 0 }));

  const file = (await p.query("SELECT * FROM files WHERE storage_location_id=$1", [locId])).rows[0];

  // --- placeholder detection -------------------------------------------
  console.log("\n--- cloud placeholder check ---");
  const inspected = await cloudPlaceholder.inspect(path.join(source, "scan_0042.txt"));
  check("a normal local file is NOT flagged as a placeholder", inspected.isPlaceholder === false);
  check("a LARGE zero-block file is flagged",
    cloudPlaceholder.isPlaceholderStat({ blocks: 0, size: 5_000_000 }) === true);
  check("an offline-attribute file is flagged",
    cloudPlaceholder.isPlaceholderStat({ attributes: 0x400000, blocks: 8, size: 4096 }) === true);
  check("an empty file is not mistaken for a placeholder",
    cloudPlaceholder.isPlaceholderStat({ blocks: 0, size: 0 }) === false);
  // The regression that matters: on Windows every small file reports
  // blocks 0 because it lives resident in the MFT. Flagging those would
  // silently drop every short document from the index.
  check("a SMALL zero-block file is NOT flagged on Windows",
    cloudPlaceholder.isPlaceholderStat({ blocks: 0, size: 56 }) === !cloudPlaceholder.IS_WINDOWS,
    cloudPlaceholder.IS_WINDOWS ? "MFT-resident, must not be flagged" : "POSIX: genuinely a placeholder");

  // --- auto-apply + mirror ---------------------------------------------
  console.log("\n--- applying a canonical name (as auto-apply does) ---");
  const proposal = await renameProposalRepository.create({
    fileId: file.id,
    currentFilename: file.filename_current,
    proposedFilename: "Invoice Couvent St Elie July 2026.txt",
    proposedRelativeDir: "Finance/Invoices",
    confidenceLevel: "high",
    confidenceScore: 0.94,
    reason: "test",
  });
  await renameProposalRepository.review(proposal.id, { status: "approved", reviewedBy: null });

  const job = await p.query(
    `INSERT INTO processing_jobs (job_type, storage_location_id, payload, status)
     VALUES ('bulk_rename',$1,'{}'::jsonb,'running') RETURNING id`, [locId]);
  await bulkRenameProcessor.handle({ proposalIds: [proposal.id] }, { data: { processingJobId: job.rows[0].id } });

  const after = await fileRepository.findById(file.id);
  check("canonical name stored", after.canonical_filename === "Invoice Couvent St Elie July 2026.txt");
  check("ORIGINAL still on disk under its original name",
    fs.existsSync(path.join(source, "scan_0042.txt")));
  check("no subject folders created in the source",
    !fs.existsSync(path.join(source, "Finance")));

  console.log("\n--- building the mirror ---");
  // The mirror is built per account (syncMirrorProcessor refuses a sync with
  // no owner outright). This script predates that and called sync() bare.
  const summary = await mirrorService.sync({ ownerUserId: actor });
  // Under the owner's own subtree -- the mirror is per account.
  const expected = path.join(mirrorService.mirrorRoot(actor), "Finance", "Invoices", "Invoice Couvent St Elie July 2026.txt.lnk");
  check("shortcut created under its subject folder", fs.existsSync(expected),
    path.relative(mirror, expected));
  // NOT `summary.written === 1`. A sync covers everything the OWNER has, and
  // this script signs in as the first user in the table -- who also owns the
  // real repository. The moment that had canonical names of its own, the count
  // became large and this failed on a number that was correct. The assertion
  // above (this run's shortcut exists, at its subject path) says what this
  // test actually cares about and stays true whatever else is in the database.
  // Same reasoning, same wording, as verify-mirror.js.
  check("mirror wrote at least this run's shortcut", summary.written >= 1,
    `written=${summary.written}`);

  console.log("\n   source folder:", (await fsp.readdir(source)).join(", "));
  console.log("   mirror tree:  ", path.relative(mirror, expected));

  console.log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
})()
  .catch((e) => { console.error("\nFAILED:", e); failed += 1; })
  // Exit code, so a runner can tell a failing run from a passing one.
  .finally(async () => {
    await cleanup();
    process.exitCode = failed === 0 ? 0 : 1;
  });
