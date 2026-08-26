// Proves the guarantee the whole design rests on: a read-only storage
// location's files are NEVER renamed, moved or deleted on disk, no matter
// which code path asks.
//
// Both routes are exercised -- the bulk_rename processor (approving an AI
// proposal) and the manual rename in fileService.updateFile -- because a
// guarantee that only one of them honours is not a guarantee.
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const env = require("../src/config/env");
const { Pool } = require("pg");
const storageLocationService = require("../src/services/storageLocationService");
const fileService = require("../src/services/fileService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const bulkRenameProcessor = require("../src/jobs/processors/bulkRenameProcessor");
const fileRepository = require("../src/repositories/fileRepository");
const renameProposalRepository = require("../src/repositories/renameProposalRepository");
const processingJobRepository = require("../src/repositories/processingJobRepository");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
const log = (...a) => console.log(...a);
let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed += 1; log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
}

let root, locId, jobId;

async function cleanup() {
  try {
    if (locId) {
      await p.query("DELETE FROM rename_proposals WHERE file_id IN (SELECT id FROM files WHERE storage_location_id=$1)", [locId]);
      await p.query("DELETE FROM files WHERE storage_location_id=$1", [locId]);
      await p.query("DELETE FROM filesystem_scans WHERE storage_location_id=$1", [locId]);
      await p.query("DELETE FROM storage_locations WHERE id=$1", [locId]);
    }
    if (jobId) await p.query("DELETE FROM processing_jobs WHERE id=$1", [jobId]);
    if (root) await fsp.rm(root, { recursive: true, force: true });
    log("\ncleaned up.");
  } catch (e) { log("cleanup warning:", e.message); }
  await p.end(); await closeAllQueues();
}

(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-readonly-"));
  const ORIGINAL = "messy original name.txt";
  await fsp.writeFile(path.join(root, ORIGINAL), "the client's irreplaceable content");
  log("source folder:", root);
  log("original file:", ORIGINAL);

  const admin = await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1");
  const actor = admin.rows[0].id;

  const loc = await storageLocationService.create(
    { name: "Read-only Test", type: "local", rootPath: root, accessMode: "direct" }, actor);
  locId = loc.id;
  check("new locations default to read-only", loc.is_read_only === true);

  await scanProcessor.handle({ storageLocationId: locId });
  const files = await p.query("SELECT * FROM files WHERE storage_location_id=$1", [locId]);
  const file = files.rows[0];
  check("file was indexed", Boolean(file), file?.filename_current);

  // --- route 1: approving an AI rename proposal -------------------------
  log("\n--- approving a rename proposal ---");
  const proposal = await renameProposalRepository.create({
    fileId: file.id,
    currentFilename: file.filename_current,
    proposedFilename: "Clean_Canonical_Name_2026.txt",
    proposedRelativeDir: "Administrative/Legal",
    confidenceLevel: "high",
    confidenceScore: 0.95,
    reason: "test",
  });
  await p.query("UPDATE rename_proposals SET status='approved' WHERE id=$1", [proposal.id]);

  // ownerUserId is required since migration 028 -- enqueueJob resolves it for
  // every production caller (queues/index.js resolveOwner), but this script
  // builds the job row directly and so has to supply it itself.
  const job = await processingJobRepository.create({
    jobType: "bulk_rename", storageLocationId: locId, payload: {},
    createdBy: actor, ownerUserId: actor, progressTotal: 1,
  });
  jobId = job.id;
  const summary = await bulkRenameProcessor.handle(
    { proposalIds: [proposal.id] }, { data: { processingJobId: job.id } });
  log("   processor summary:", JSON.stringify(summary));

  const onDisk = await fsp.readdir(root);
  check("original file still on disk under its ORIGINAL name", onDisk.includes(ORIGINAL), onDisk.join(", "));
  check("no new subfolder was created", !fs.existsSync(path.join(root, "Administrative")));

  const after = await fileRepository.findById(file.id);
  check("canonical name recorded in the database", after.canonical_filename === "Clean_Canonical_Name_2026.txt",
    after.canonical_filename);
  check("canonical folder recorded", after.canonical_relative_dir === "Administrative/Legal",
    after.canonical_relative_dir);
  check("filename_current still describes what is on disk", after.filename_current === ORIGINAL,
    after.filename_current);

  // --- route 2: manual rename from the UI -------------------------------
  log("\n--- manual rename from the UI ---");
  await fileService.updateFile(file.id, { filename: "Human_Chosen_Name.txt" }, actor);
  const onDisk2 = await fsp.readdir(root);
  check("original STILL untouched after manual rename", onDisk2.includes(ORIGINAL), onDisk2.join(", "));
  const after2 = await fileRepository.findById(file.id);
  check("manual name recorded as canonical", after2.canonical_filename === "Human_Chosen_Name.txt",
    after2.canonical_filename);

  // --- writable locations must still rename for real --------------------
  log("\n--- same file, location flipped to writable ---");
  await storageLocationService.setReadOnly(locId, false, actor);
  await fileService.updateFile(file.id, { filename: "Actually_Renamed.txt" }, actor);
  const onDisk3 = await fsp.readdir(root);
  check("writable location DOES rename on disk", onDisk3.includes("Actually_Renamed.txt"), onDisk3.join(", "));
  check("old name gone from disk", !onDisk3.includes(ORIGINAL));

  log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
})()
  .catch((e) => { console.error("\nFAILED:", e); failed += 1; })
  // Exit code, so a runner can tell a failing run from a passing one.
  .finally(async () => {
    await cleanup();
    process.exitCode = failed === 0 ? 0 : 1;
  });
