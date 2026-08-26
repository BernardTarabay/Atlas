// Gives already-indexed files the fingerprint that lets a future copy be
// recognised without being read.
//
// WHY THIS IS NEEDED AT ALL
//
// quickIdentityService recognises a duplicate by comparing a 128 KB fingerprint
// against files already in the database. Files hashed BEFORE that existed have
// no fingerprint stored, and the matcher deliberately refuses to match against
// a candidate that has none -- guessing from size and mtime alone is the weaker
// claim the fingerprint exists to avoid.
//
// The consequence is easy to miss and was: with an un-fingerprinted corpus, the
// shortcut is correct, silent, and useless. Every new copy falls through to a
// full read because there is nothing it can legitimately match. Nothing errors.
//
// New files get their fingerprint for free, from the same pass that hashes them
// (hashingService.sha256AndFingerprint). This is the one-time catch-up for
// everything that predates it.
//
// COST: 128 KB per file, by range read -- not a full re-read. A corpus that
// took hours to hash backfills in seconds.
//
//   node scripts/backfill-fingerprints.js           report what is missing
//   node scripts/backfill-fingerprints.js --apply   compute and store them

const { Pool } = require("pg");
const env = require("../src/config/env");
const storageLocationRepository = require("../src/repositories/storageLocationRepository");
const { getStorageServiceFor } = require("../src/services/storage/storageService");
const quickIdentityService = require("../src/services/quickIdentityService");
const { closeAllQueues } = require("../src/queues");

const APPLY = process.argv.includes("--apply");
const p = new Pool({ connectionString: env.databaseUrl });

(async () => {
  console.log(`Backfilling quick fingerprints${APPLY ? "" : " (report only -- pass --apply to write)"}`);
  console.log("=".repeat(62));

  const { rows } = await p.query(
    `SELECT f.id, f.current_path, f.size_bytes, f.storage_location_id, l.access_mode
       FROM files f
       JOIN storage_locations l ON l.id = f.storage_location_id
      WHERE f.quick_fingerprint IS NULL
        AND f.status <> 'deleted'
        AND f.sha256_hash IS NOT NULL
        AND f.size_bytes >= $1
        AND l.access_mode = 'direct'
      ORDER BY f.size_bytes DESC`,
    [quickIdentityService.MIN_SIZE_FOR_INFERENCE]
  );

  if (rows.length === 0) {
    console.log("\nNothing to do -- every file large enough to benefit already has a fingerprint.");
    return;
  }

  const totalBytes = rows.reduce((sum, r) => sum + Number(r.size_bytes || 0), 0);
  console.log(
    `\n${rows.length} file(s) are missing one, covering ` +
    `${(totalBytes / 1024 / 1024).toFixed(1)} MB of content.`
  );
  console.log(
    `Reading ${((rows.length * quickIdentityService.CHUNK_BYTES * 2) / 1024 / 1024).toFixed(1)} MB ` +
    `to fingerprint them -- ${Math.round(totalBytes / Math.max(1, rows.length * quickIdentityService.CHUNK_BYTES * 2))}x ` +
    "less than re-hashing.\n"
  );

  if (!APPLY) {
    console.log("Re-run with --apply to write them.");
    return;
  }

  const locations = new Map();
  let done = 0, failed = 0, read = 0;

  for (const file of rows) {
    let location = locations.get(file.storage_location_id);
    if (!location) {
      location = await storageLocationRepository.findById(file.storage_location_id);
      locations.set(file.storage_location_id, location);
    }
    if (!location) { failed += 1; continue; }

    try {
      const storageService = getStorageServiceFor(location);
      const fp = await quickIdentityService.fingerprint(storageService, file.current_path, file.size_bytes);
      await quickIdentityService.setFingerprint(file.id, fp);
      read += quickIdentityService.CHUNK_BYTES * 2;
      done += 1;
    } catch (err) {
      failed += 1;
      console.log(`   SKIPPED  ${file.current_path} -- ${err.message}`);
    }
  }

  console.log(`\n  fingerprinted  ${done}`);
  console.log(`  unreadable     ${failed}`);
  console.log(`  read           ${(read / 1024 / 1024).toFixed(1)} MB`);
  console.log("\nFuture copies of these files will now be recognised without being read.");
})()
  .catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; })
  .finally(async () => {
    await p.end().catch(() => {});
    await closeAllQueues().catch(() => {});
    
  });
