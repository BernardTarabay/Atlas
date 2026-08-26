// Reproduces the "four files became eight" scenario end to end against the
// real database, and asserts it no longer happens.
//
//   add folder (4 files) -> scan -> remove -> re-add -> scan
//
// Before the fix, `remove()` only deactivated the location and `create()`
// happily made a SECOND row for the same directory, so the second scan
// found no existing files under the new location id and re-ingested all
// four. Cleans up everything it creates.
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const env = require("../src/config/env");
const { Pool } = require("pg");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const { closeAllQueues } = require("../src/queues");

const pool = new Pool({ connectionString: env.databaseUrl });
const log = (...a) => console.log(...a);

let root;
const createdLocationIds = new Set();

async function countFiles(locationIds) {
  if (locationIds.length === 0) return 0;
  const { rows } = await pool.query(
    "SELECT count(*)::int n FROM files WHERE storage_location_id = ANY($1::uuid[])",
    [locationIds]
  );
  return rows[0].n;
}

async function cleanup() {
  try {
    const ids = [...createdLocationIds];
    if (ids.length) {
      await pool.query("DELETE FROM files WHERE storage_location_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM filesystem_scans WHERE storage_location_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM storage_locations WHERE id = ANY($1::uuid[])", [ids]);
    }
    if (root) await fsp.rm(root, { recursive: true, force: true });
    log("\ncleaned up temp folder and all locations/files created by this script.");
  } catch (e) {
    log("cleanup warning:", e.message);
  }
  await pool.end();
  // The scan enqueues real BullMQ jobs, which opens queue + Redis handles
  // that would otherwise keep this process alive after it has finished.
  await closeAllQueues();
 
}

async function run() {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-rescan-"));
  for (const name of ["alpha.txt", "beta.txt", "gamma.txt", "delta.txt"]) {
    await fsp.writeFile(path.join(root, name), `contents of ${name}`);
  }
  log("temp folder with 4 files:", root);

  const admin = await pool.query("SELECT id FROM users ORDER BY created_at LIMIT 1");
  const actor = admin.rows[0].id;

  log("\n--- 1. add the folder and scan ---");
  const first = await storageLocationService.create(
    { name: "Rescan Test", type: "local", rootPath: root, accessMode: "direct" },
    actor
  );
  createdLocationIds.add(first.id);
  // Call the processor directly so this needs no running worker.
  const scan1 = await scanProcessor.handle({ storageLocationId: first.id });
  log("   location:", first.id);
  log("   scan:", JSON.stringify({ discovered: scan1.discovered, new: scan1.new }));
  log("   files now:", await countFiles([...createdLocationIds]));

  log("\n--- 2. remove the folder from the app ---");
  await storageLocationService.remove(first.id, actor);
  log("   removed (deactivated).");

  log("\n--- 3. add the SAME folder again ---");
  const second = await storageLocationService.create(
    { name: "Rescan Test Again", type: "local", rootPath: root, accessMode: "direct" },
    actor
  );
  createdLocationIds.add(second.id);
  const reused = second.id === first.id;
  log("   returned location:", second.id);
  log("   reused the original location:", reused ? "YES" : "NO - a second row was created");

  log("\n--- 4. scan again ---");
  const scan2 = await scanProcessor.handle({ storageLocationId: second.id });
  log("   scan:", JSON.stringify({ discovered: scan2.discovered, new: scan2.new }));

  const total = await countFiles([...createdLocationIds]);
  const locationCount = createdLocationIds.size;
  log("\n--- result ---");
  log("   storage_locations created:", locationCount, "(expected 1)");
  log("   file rows total:", total, "(expected 4)");
  log("   new files on the second scan:", scan2.new, "(expected 0)");

  const ok = reused && locationCount === 1 && total === 4 && scan2.new === 0;
  if (!ok) failed = true;
  log(`\n================ ${ok ? "PASS - no duplicate ingestion" : "FAIL - files were re-ingested"} ================`);

  log("\n--- trying to add the same folder while it is ACTIVE ---");
  try {
    await storageLocationService.create(
      { name: "Third Attempt", type: "local", rootPath: root, accessMode: "direct" },
      actor
    );
    failed = true;
    log("   FAIL: a duplicate active location was allowed.");
  } catch (err) {
    log("   correctly refused:", err.message);
  }

  log("\n--- path spellings that must resolve to the same folder ---");
  for (const spelling of [`${root}${path.sep}`, `  ${root}  `, `"${root}"`]) {
    try {
      await storageLocationService.create(
        { name: "Spelling Attempt", type: "local", rootPath: spelling, accessMode: "direct" },
        actor
      );
      failed = true;
      log(`   FAIL: ${JSON.stringify(spelling)} created another location.`);
    } catch (err) {
      log(`   ${JSON.stringify(spelling)} -> refused as already registered`);
    }
  }
}

// Every "FAIL:" this script printed was previously informational only -- it
// said the wrong thing had happened and then exited 0 anyway.
let failed = false;

run()
  .catch((e) => { console.error("\nFAILED:", e); failed = true; })
  .finally(async () => {
    await cleanup();
    process.exitCode = failed ? 1 : 0;
  });
