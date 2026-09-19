// ONE-TIME REPAIR: collapse the redundant operational history a scan loop left
// behind.
//
// WHY THE SCHEDULED RETENTION JOB CANNOT DO THIS
//
// jobs/processors/purgeOperationalProcessor.js is the ongoing policy and it is
// age-based, which is the right rule for history that accumulates normally. It
// is the wrong rule for this backlog, because the backlog is not old:
//
//     completed jobs older than 7 days        2,646
//     completed jobs NEWER than 7 days    7,882,529
//
// A scan-recovery loop (see fileRepository.listUnprocessed for the predicate
// that caused it) re-queued the same 1,426 files roughly 1,370 times over two
// days. Age retention would eventually catch all of it, a week late, having
// carried 4.6 GB in the meantime -- and it would say nothing about the fact
// that 7.8 million of those rows are the same handful of events repeated.
//
// So this removes the REPEATS rather than the OLD, which is a different and
// narrower claim: for each (job_type, file) it keeps the most recent completed
// job and drops the earlier identical ones. Every distinct thing that ever
// happened to every file is still on record. What goes is the 268th copy of
// "this PNG was hashed".
//
// WHAT IT WILL NOT TOUCH
//
//   queued / running jobs      live work
//   failed jobs                the only job rows anyone reads on purpose
//   jobs with no fileId        scan, bulk_rename, bulk_move, bulk_delete,
//                              auto_resolve_duplicates, organize_unfiled --
//                              user-initiated work, kept whole
//   processing_job_items       all 9,789 belong to bulk jobs, which are in the
//                              untouched set above, so the CASCADE never fires
//   every audit action except  the explicit telemetry list below
//
// Run it dry first. It prints exactly what it would remove and changes nothing:
//
//   node scripts/compact-operational-history.js
//   node scripts/compact-operational-history.js --apply
//   node scripts/compact-operational-history.js --apply --vacuum
//
// --vacuum runs VACUUM FULL afterwards, which is what actually returns the disk
// space to the operating system. A plain autovacuum only marks the pages
// reusable by this table, so the database file stays 5.4 GB until something
// grows back into it. VACUUM FULL takes an ACCESS EXCLUSIVE lock and rewrites
// the table, so run it while the API and worker are stopped.
const { Pool } = require("pg");
const env = require("../src/config/env");

const APPLY = process.argv.includes("--apply");
const VACUUM = process.argv.includes("--vacuum");

// Big enough that 7.8M rows do not take thousands of round trips, small enough
// that each transaction is short and a Ctrl-C loses at most one batch.
const BATCH = 25000;

// The audit actions this collapses, and the column that identifies "the same
// thing happening again" for each. Deliberately the same conservative set the
// retention processor allows, and deliberately explicit -- a repair script that
// guessed which audit rows were disposable would be a worse idea than the loop
// it is repairing.
const TELEMETRY_ACTIONS = ["file.hashed", "file.skipped_placeholder", "ai_classification.skipped"];

const pool = new Pool({ connectionString: env.databaseUrl, statement_timeout: 0 });
const n = (v) => Number(v).toLocaleString();

async function sizes(client) {
  const { rows } = await client.query(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS db,
            pg_size_pretty(pg_total_relation_size('processing_jobs')) AS jobs,
            pg_size_pretty(pg_total_relation_size('audit_logs')) AS audit`
  );
  return rows[0];
}

/**
 * Delete the rows listed in a temp table, in batches, draining it as it goes.
 *
 * The CTE deletes a bounded slice of the id list and feeds those ids straight
 * into the real delete, so the list shrinks with the work and the loop needs no
 * offset -- an OFFSET over a table being deleted from is a well-known way to
 * skip rows.
 */
async function drain(client, idTable, targetTable, expected) {
  let removed = 0;
  for (;;) {
    const { rowCount } = await client.query(
      `WITH batch AS (
         DELETE FROM ${idTable}
          WHERE id IN (SELECT id FROM ${idTable} LIMIT ${BATCH})
          RETURNING id
       )
       DELETE FROM ${targetTable} WHERE id IN (SELECT id FROM batch)`
    );
    if (rowCount === 0) break;
    removed += rowCount;
    process.stdout.write(
      `\r   ${targetTable}: ${n(removed)} / ${n(expected)} (${Math.round((removed / expected) * 100)}%)   `
    );
  }
  process.stdout.write("\n");
  return removed;
}

(async () => {
  const client = await pool.connect();
  try {
    console.log(APPLY ? "MODE: APPLY (rows will be deleted)" : "MODE: DRY RUN (nothing will change)");
    const before = await sizes(client);
    console.log(`\nbefore:  database ${before.db}   processing_jobs ${before.jobs}   audit_logs ${before.audit}`);

    // --- identify the redundant job rows ---------------------------------
    //
    // row_number() over (job_type, fileId) ordered newest-first: rank 1 is the
    // survivor, everything above it is a repeat. (created_at, id) rather than
    // created_at alone so the ordering is total -- thousands of these rows share
    // a timestamp to the millisecond, and without the tiebreak "the newest" is
    // ambiguous and the survivor is chosen arbitrarily on each run.
    console.log("\nidentifying redundant per-file stage jobs (this takes a minute or two)...");
    await client.query("DROP TABLE IF EXISTS _compact_job_ids");
    await client.query(`
      CREATE TEMP TABLE _compact_job_ids AS
      SELECT id FROM (
        SELECT id, row_number() OVER (
                 PARTITION BY job_type, payload->>'fileId'
                 ORDER BY created_at DESC, id DESC) AS rn
          FROM processing_jobs
         WHERE status = 'completed'
           AND payload ? 'fileId'
      ) ranked
      WHERE rn > 1`);
    await client.query("CREATE INDEX ON _compact_job_ids (id)");
    const jobCount = Number((await client.query("SELECT count(*)::bigint c FROM _compact_job_ids")).rows[0].c);

    // --- identify the redundant telemetry rows ---------------------------
    console.log("identifying redundant telemetry audit rows...");
    await client.query("DROP TABLE IF EXISTS _compact_audit_ids");
    await client.query(`
      CREATE TEMP TABLE _compact_audit_ids AS
      SELECT id FROM (
        SELECT id, row_number() OVER (
                 PARTITION BY action, entity_id
                 ORDER BY created_at DESC, id DESC) AS rn
          FROM audit_logs
         WHERE action = ANY($1::text[])
      ) ranked
      WHERE rn > 1`, [TELEMETRY_ACTIONS]);
    await client.query("CREATE INDEX ON _compact_audit_ids (id)");
    const auditCount = Number((await client.query("SELECT count(*)::bigint c FROM _compact_audit_ids")).rows[0].c);

    // --- what survives ---------------------------------------------------
    const survivors = await client.query(`
      SELECT (SELECT count(*)::bigint FROM processing_jobs) AS jobs_now,
             (SELECT count(*)::bigint FROM audit_logs)      AS audit_now,
             (SELECT count(*)::bigint FROM processing_job_items) AS items_now`);
    const s = survivors.rows[0];

    console.log(`\n   redundant job rows       ${n(jobCount).padStart(12)}   of ${n(s.jobs_now)}`);
    console.log(`   redundant telemetry rows ${n(auditCount).padStart(12)}   of ${n(s.audit_now)}`);
    console.log(`   job rows surviving       ${n(Number(s.jobs_now) - jobCount).padStart(12)}`);
    console.log(`   audit rows surviving     ${n(Number(s.audit_now) - auditCount).padStart(12)}`);
    console.log(`   processing_job_items     ${n(s.items_now).padStart(12)}   (untouched -- all belong to bulk jobs)`);

    if (!APPLY) {
      console.log("\nDry run only. Re-run with --apply to delete, and --vacuum to reclaim the disk space.");
      return;
    }

    console.log("\ndeleting...");
    const jobsRemoved = jobCount ? await drain(client, "_compact_job_ids", "processing_jobs", jobCount) : 0;
    const auditRemoved = auditCount ? await drain(client, "_compact_audit_ids", "audit_logs", auditCount) : 0;

    if (VACUUM) {
      // Cannot run inside a transaction, and takes ACCESS EXCLUSIVE. This is
      // the step that actually shrinks the files on disk.
      console.log("\nVACUUM FULL processing_jobs (rewriting; the table is locked meanwhile)...");
      await client.query("VACUUM (FULL, ANALYZE) processing_jobs");
      console.log("VACUUM FULL audit_logs...");
      await client.query("VACUUM (FULL, ANALYZE) audit_logs");
    } else {
      // Still worth doing: it updates the planner statistics that every query
      // above just invalidated by removing 99% of two tables.
      console.log("\nANALYZE (no --vacuum, so disk space is marked reusable but not returned)...");
      await client.query("ANALYZE processing_jobs");
      await client.query("ANALYZE audit_logs");
    }

    const after = await sizes(client);
    console.log(`\nremoved: ${n(jobsRemoved)} job row(s), ${n(auditRemoved)} telemetry row(s)`);
    console.log(`after:   database ${after.db}   processing_jobs ${after.jobs}   audit_logs ${after.audit}`);
    if (!VACUUM) console.log("\nRun again with --vacuum to return the freed pages to the operating system.");
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exitCode = 1;
});
