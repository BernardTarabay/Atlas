// Proves a file you already have is recognised WITHOUT being read.
//
// THE QUESTION THIS ANSWERS
//
//   "If I know they're duplicates, why compute them in the first place? A scan
//    still happens, we hash all seven files, and only then deduce they're
//    duplicates."
//
// Correct, and the hash was the expensive half: sha256Stream reads every byte.
// knownContentService already made everything DOWNSTREAM of the hash free for
// an identical file; this moves the recognition earlier, to before the file is
// opened in full -- size and mtime from an index, then 64 KB from each end.
//
// WHAT MAKES THIS SCRIPT WORTH ANYTHING
//
// It MEASURES THE BYTES READ. Asserting "the shortcut fired" would pass just as
// happily if the shortcut fired and then something read the file anyway, which
// is the only failure that matters here -- the feature would look like it
// worked while saving nothing. So the storage layer is instrumented and the
// numbers below are actual I/O.
//
//     node scripts/verify-quick-identity.js

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const env = require("../src/config/env");
const { LocalStorageService } = require("../src/services/storage/localStorageService");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const hashProcessor = require("../src/jobs/processors/hashProcessor");
const quickIdentityService = require("../src/services/quickIdentityService");
const { closeAllQueues } = require("../src/queues");
const { dequeueFixtureJobs, pauseQueues, resumeQueues } = require("./_fixtureQueue");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

// --- instrument the storage layer -----------------------------------------
//
// Every byte the pipeline reads through a local storage location passes
// through here, so this is the honest measure of what the shortcut saved.
let bytesRead = 0;
const originalReadStream = LocalStorageService.prototype.readStream;
LocalStorageService.prototype.readStream = function instrumented(targetPath, options) {
  const stream = originalReadStream.call(this, targetPath, options);
  stream.on("data", (chunk) => { bytesRead += chunk.length; });
  return stream;
};
const measure = async (fn) => {
  bytesRead = 0;
  await fn();
  return bytesRead;
};

let rootA, rootB, locA, locB;

async function cleanup() {
  LocalStorageService.prototype.readStream = originalReadStream;
  try {
    for (const id of [locA, locB].filter(Boolean)) {
      const ids = `(SELECT id FROM files WHERE storage_location_id='${id}')`;
      await p.query(`DELETE FROM classification_results WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_content  WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_metadata WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_hashes   WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM duplicate_group_members WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM audit_logs WHERE entity_type='file' AND entity_id IN ${ids}`);
      await p.query(`DELETE FROM processing_jobs WHERE storage_location_id=$1`, [id]);
      await p.query(`DELETE FROM filesystem_scans WHERE storage_location_id=$1`, [id]);
      await p.query(`DELETE FROM files WHERE storage_location_id=$1`, [id]);
      await p.query(`DELETE FROM storage_locations WHERE id=$1`, [id]);
    }
    for (const r of [rootA, rootB].filter(Boolean)) await fsp.rm(r, { recursive: true, force: true });
    console.log("\ncleaned up.");
  } catch (e) { console.log("cleanup warning:", e.message); }
  await resumeQueues().catch(() => {});
  await p.end(); await closeAllQueues();
}

/** A file big enough that reading it whole is meaningfully dearer than sampling it. */
const BIG = 4 * 1024 * 1024; // 4 MB
function bigBuffer(seed, size = BIG) {
  // Deterministic, and not compressible into a coincidence: distinct seeds
  // produce different bytes throughout, not just at the front.
  const out = Buffer.alloc(size);
  let block = crypto.createHash("sha256").update(seed).digest();
  for (let i = 0; i < size; i += 32) {
    block = crypto.createHash("sha256").update(block).digest();
    block.copy(out, i, 0, Math.min(32, size - i));
  }
  return out;
}

const fileRow = async (locId, name) =>
  (await p.query("SELECT * FROM files WHERE storage_location_id=$1 AND filename_current=$2", [locId, name])).rows[0];

(async () => {
  console.log("Verifying quick identity\n" + "=".repeat(48));
  try {
    await pauseQueues();
    rootA = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-qid-a-"));
    rootB = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-qid-b-"));

    const admin = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
    if (!admin) { console.log("   SKIP  needs a user"); return; }

    // Folder A: the original.
    const bigDoc = bigBuffer("report");
    await fsp.writeFile(path.join(rootA, "big-report.bin"), bigDoc);
    await fsp.writeFile(path.join(rootA, "small-note.txt"), "just a short note");

    // Folder B: a copy of the big file (byte-identical, mtime preserved the way
    // a real copy tool preserves it), the same small file, one genuinely new
    // file, and one TRAP -- same size and mtime, different contents.
    await fsp.writeFile(path.join(rootB, "big-report.bin"), bigDoc);
    await fsp.writeFile(path.join(rootB, "small-note.txt"), "just a short note");
    await fsp.writeFile(path.join(rootB, "brand-new.bin"), bigBuffer("brand-new"));
    await fsp.writeFile(path.join(rootB, "impostor.bin"), bigBuffer("impostor"));

    const stampA = await fsp.stat(path.join(rootA, "big-report.bin"));
    for (const n of ["big-report.bin", "impostor.bin"]) {
      await fsp.utimes(path.join(rootB, n), stampA.atime, stampA.mtime);
    }

    const a = await storageLocationService.create(
      { name: "QID A", type: "local", rootPath: rootA, accessMode: "direct" }, admin.id);
    locA = a.id;
    await scanProcessor.handle({ storageLocationId: locA });
    await dequeueFixtureJobs(p, locA);

    console.log("\n1. The first folder pays full price, as it must");

    const filesA = (await p.query("SELECT * FROM files WHERE storage_location_id=$1", [locA])).rows;
    const readA = await measure(async () => {
      for (const f of filesA) await hashProcessor.handle({ fileId: f.id });
    });
    check("nothing is inferred on a first scan -- there is nothing to match",
      readA >= BIG, `read ${(readA / 1024 / 1024).toFixed(1)} MB for ${filesA.length} file(s)`);

    const originalBig = await fileRow(locA, "big-report.bin");
    check("...and the original stored a fingerprint for next time",
      Boolean(originalBig.quick_fingerprint), originalBig.quick_fingerprint ? "stored" : "MISSING");
    check("...marked as a real, computed hash",
      originalBig.hash_source === "computed", originalBig.hash_source);

    console.log("\n2. The overlapping folder is recognised without being read");

    const b = await storageLocationService.create(
      { name: "QID B", type: "local", rootPath: rootB, accessMode: "direct" }, admin.id);
    locB = b.id;
    await scanProcessor.handle({ storageLocationId: locB });
    await dequeueFixtureJobs(p, locB);

    const copyBig = await fileRow(locB, "big-report.bin");
    const readCopy = await measure(async () => { await hashProcessor.handle({ fileId: copyBig.id }); });

    const sampled = quickIdentityService.CHUNK_BYTES * 2;
    check("the 4 MB duplicate was identified from a sample, not a full read",
      readCopy <= sampled * 1.1,
      `read ${(readCopy / 1024).toFixed(0)} KB instead of ${(BIG / 1024).toFixed(0)} KB` +
      ` (${Math.round(BIG / Math.max(1, readCopy))}x less)`);

    const copyRow = await fileRow(locB, "big-report.bin");
    check("...and it carries the right hash",
      copyRow.sha256_hash === originalBig.sha256_hash, "matches the original");
    check("...recorded honestly as inferred, not passed off as computed",
      copyRow.hash_source === "inferred", copyRow.hash_source);

    const audit = (await p.query(
      "SELECT count(*)::int n FROM audit_logs WHERE action='file.hash_inferred' AND entity_id=$1",
      [copyBig.id])).rows[0].n;
    check("...and the shortcut is written to the audit log, not silent", audit === 1, `${audit} entry`);

    console.log("\n3. What it refuses to shortcut");

    // THE SAFETY CASE. Same byte size, same mtime -- everything the cheap
    // filter looks at -- but different contents. If the fingerprint were not
    // consulted, this file would adopt another document's text and subject.
    const impostor = await fileRow(locB, "impostor.bin");
    const readImpostor = await measure(async () => { await hashProcessor.handle({ fileId: impostor.id }); });
    const impostorRow = await fileRow(locB, "impostor.bin");
    check("a file with the same size AND mtime but different bytes is NOT adopted",
      impostorRow.sha256_hash !== originalBig.sha256_hash, "got its own hash");
    check("...it was read in full, because the fingerprint disagreed",
      readImpostor >= BIG, `read ${(readImpostor / 1024 / 1024).toFixed(1)} MB`);
    check("...and is marked computed, not inferred",
      impostorRow.hash_source === "computed", impostorRow.hash_source);

    const brandNew = await fileRow(locB, "brand-new.bin");
    const readNew = await measure(async () => { await hashProcessor.handle({ fileId: brandNew.id }); });
    check("a genuinely new file is read in full, as before",
      readNew >= BIG, `read ${(readNew / 1024 / 1024).toFixed(1)} MB`);

    // Small files are never inferred: reading them whole costs the same as
    // sampling them, so they get certainty for free.
    const smallCopy = await fileRow(locB, "small-note.txt");
    await hashProcessor.handle({ fileId: smallCopy.id });
    const smallRow = await fileRow(locB, "small-note.txt");
    check("a small file is hashed properly rather than inferred",
      smallRow.hash_source === "computed", `${smallRow.size_bytes} bytes -- below the sampling floor`);

    console.log("\n4. The inference can be settled later");

    const inferred = (await p.query(
      "SELECT count(*)::int n FROM files WHERE hash_source='inferred' AND storage_location_id=$1", [locB]
    )).rows[0].n;
    check("inferred rows are findable, so they can be confirmed on demand",
      inferred === 1, `${inferred} row(s) -- scripts/verify-inferred-hashes.js re-reads these`);

    // And forcing a full hash produces the same answer the inference claimed.
    const readForced = await measure(async () => {
      await hashProcessor.handle({ fileId: copyBig.id, forceFullHash: true });
    });
    const afterForce = await fileRow(locB, "big-report.bin");
    check("forcing a real hash confirms what the shortcut inferred",
      afterForce.sha256_hash === originalBig.sha256_hash,
      `re-read ${(readForced / 1024 / 1024).toFixed(1)} MB and got the same hash`);
  } catch (e) {
    failed += 1;
    console.log(`\n   ERROR ${e.stack}`);
  } finally {
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
