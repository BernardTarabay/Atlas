// Turns believed hashes into proven ones.
//
// WHY THERE IS ANYTHING TO VERIFY
//
// quickIdentityService recognises an already-indexed file from 128 KB -- its
// size, its mtime, and 64 KB from each end -- instead of streaming the whole
// thing. That is what makes registering an overlapping folder cheap: the
// import stops being dominated by reading gigabytes to confirm what the
// filesystem already implied.
//
// It is an inference. Two different files CAN share a size, a head and a tail;
// it is vanishingly unlikely and it is not impossible. So those rows carry
// `hash_source = 'inferred'`, and this script is the way to settle them: it
// re-runs the real hash, compares, and reports.
//
// Deliberately opt-in and not scheduled. The entire point of the shortcut is
// not to read those bytes; a background job that read them anyway would give
// the cost back and call it safety. Run this when you want certainty -- before
// an archive is retired, or if a duplicate group looks wrong.
//
//   node scripts/verify-inferred-hashes.js            report only
//   node scripts/verify-inferred-hashes.js --apply    fix any that disagree
//   node scripts/verify-inferred-hashes.js --limit 50

const { Pool } = require("pg");
const env = require("../src/config/env");
const storageLocationRepository = require("../src/repositories/storageLocationRepository");
const { getStorageServiceFor } = require("../src/services/storage/storageService");
const { sha256Stream } = require("../src/services/hashingService");
const { closeAllQueues } = require("../src/queues");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : 500;
})();

const p = new Pool({ connectionString: env.databaseUrl });

(async () => {
  console.log(`Verifying inferred hashes${APPLY ? " (--apply: mismatches will be corrected)" : " (report only)"}\n` + "=".repeat(60));

  const { rows } = await p.query(
    `SELECT f.id, f.current_path, f.size_bytes, f.sha256_hash, f.storage_location_id
       FROM files f
      WHERE f.hash_source = 'inferred' AND f.status <> 'deleted'
      ORDER BY f.size_bytes DESC
      LIMIT $1`,
    [LIMIT]
  );

  if (rows.length === 0) {
    console.log("\nNothing to check -- no hash on this database was inferred.");
    console.log("(Every sha256 here was computed from the whole file.)");
    return;
  }

  console.log(`\n${rows.length} file(s) carry an inferred hash. Re-reading them in full...\n`);

  let confirmed = 0, mismatched = 0, unreadable = 0, bytes = 0;
  const locations = new Map();

  for (const file of rows) {
    let location = locations.get(file.storage_location_id);
    if (!location) {
      location = await storageLocationRepository.findById(file.storage_location_id);
      locations.set(file.storage_location_id, location);
    }
    if (!location) { unreadable += 1; continue; }

    try {
      const storageService = getStorageServiceFor(location);
      const real = await sha256Stream(storageService.readStream(file.current_path));
      bytes += Number(file.size_bytes || 0);

      if (real === file.sha256_hash) {
        confirmed += 1;
        if (APPLY) {
          await p.query("UPDATE files SET hash_source = 'computed' WHERE id = $1", [file.id]);
        }
      } else {
        mismatched += 1;
        console.log(`   MISMATCH  ${file.current_path}`);
        console.log(`             inferred ${file.sha256_hash}`);
        console.log(`             actual   ${real}`);
        if (APPLY) {
          // The row is corrected and demoted to 'computed'. Its adopted text,
          // classification and AI enrichment came from the wrong twin, so the
          // file is put back at the start of the pipeline rather than left
          // carrying another document's conclusions.
          await p.query(
            `UPDATE files SET sha256_hash = $2, hash_source = 'computed',
                              processing_status = 'pending', pipeline_state = 'discovered'
              WHERE id = $1`,
            [file.id, real]
          );
          console.log("             corrected, and re-queued for processing");
        }
      }
    } catch (err) {
      unreadable += 1;
      console.log(`   SKIPPED   ${file.current_path} -- ${err.message}`);
    }
  }

  console.log("\n" + "-".repeat(60));
  console.log(`  confirmed   ${confirmed}`);
  console.log(`  mismatched  ${mismatched}`);
  console.log(`  unreadable  ${unreadable}`);
  console.log(`  read        ${(bytes / 1024 / 1024).toFixed(1)} MB to check them`);
  if (mismatched > 0 && !APPLY) {
    console.log("\n  Re-run with --apply to correct the mismatched rows and re-queue them.");
  }
  if (mismatched === 0 && rows.length > 0) {
    console.log("\n  Every inferred hash was right." +
      (APPLY ? " They are now marked 'computed'." : " Re-run with --apply to mark them 'computed'."));
  }
})()
  .catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; })
  .finally(async () => {
    await p.end().catch(() => {});
    await closeAllQueues().catch(() => {});
    
  });
