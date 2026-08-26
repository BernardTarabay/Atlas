// Queue a scan for one or more storage locations, matched by name.
//
// Scanning is normally triggered from the UI or by the watcher. This exists
// for the cases where neither is convenient: after a code change that alters
// how files are processed, or to force the self-healing pass (see
// fileRepository.listUnprocessed) to pick up files whose work was lost.
//
//   node scripts/queue-scan.js Backup      -- every location matching "Backup"
//   node scripts/queue-scan.js             -- every active location

const { Pool } = require("pg");
const env = require("../src/config/env");
const { enqueueJob, closeAllQueues } = require("../src/queues");
const { JobType } = require("../src/models/enums");

const fragment = process.argv[2] || "";
const pool = new Pool({ connectionString: env.databaseUrl });

(async () => {
  const { rows } = await pool.query(
    "SELECT id, name, root_path FROM storage_locations WHERE name ILIKE $1 ORDER BY name",
    [`%${fragment}%`]
  );
  if (!rows.length) throw new Error(`No storage location matching "${fragment}".`);

  for (const loc of rows) {
    const job = await enqueueJob(JobType.SCAN, { storageLocationId: loc.id }, { storageLocationId: loc.id });
    console.log(`queued scan  ${loc.name}`);
    console.log(`             ${loc.root_path}`);
    console.log(`             job ${job.id}`);
  }
  console.log(`\n${rows.length} scan(s) queued. Watch progress on the Storage Locations page.`);
})()
  .catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await closeAllQueues(); });
