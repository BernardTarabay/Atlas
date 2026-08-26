// Populates document_date for files indexed before migration 024.
//
// Re-queues the metadata stage rather than re-reading the files here: the
// worker already knows how to read every format, handles failures, and paces
// itself. A script doing it inline would read tens of gigabytes on one thread
// while the worker sat idle, and would lose its place if interrupted.
//
//   node scripts/backfill-document-dates.js          # report only
//   node scripts/backfill-document-dates.js --apply

const { Pool } = require("pg");
const env = require("../src/config/env");
const { enqueueJob, closeAllQueues } = require("../src/queues");
const { JobType } = require("../src/models/enums");

const APPLY = process.argv.includes("--apply");
const pool = new Pool({ connectionString: env.databaseUrl });

(async () => {
  const { rows } = await pool.query(
    `SELECT id, storage_location_id FROM files
      WHERE status <> 'deleted' AND document_date IS NULL
      ORDER BY imported_at DESC`
  );

  const done = (await pool.query(
    "SELECT count(*)::int n FROM files WHERE status <> 'deleted' AND document_date IS NOT NULL"
  )).rows[0].n;

  console.log(`files already dated : ${done}`);
  console.log(`files still to date : ${rows.length}`);

  if (rows.length === 0) {
    console.log("\nNothing to backfill.");
    return;
  }
  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to queue them.");
    return;
  }

  for (const f of rows) {
    await enqueueJob(JobType.EXTRACT_METADATA, { fileId: f.id }, { storageLocationId: f.storage_location_id });
  }
  console.log(`\nQueued ${rows.length} file(s). Watch the Processing Jobs dock; dates appear as they complete.`);
})()
  .catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await closeAllQueues(); });
