// Ratios: the health signals that catch a pipeline doing the WRONG work.
//
// WHY THE EXISTING SIGNALS COULD NOT SEE THE INCIDENT THIS EXISTS TO PREVENT
//
// /api/health already reports queue depth, oldest queued age, worker count, and
// files awaiting recovery. Every one of those measures a RATE or a DEPTH, and
// all of them are answers to the same question: has the system stopped?
//
// That question has a blind spot the size of the last outage. For thirty-seven
// hours a scan-recovery loop re-queued the same 1,426 files roughly 1,379 times
// each, writing 7.8 million job rows and 4.6 GB of queue table behind a 48 MB
// library. Every signal above stayed green throughout, and correctly:
//
//   queue depth        near zero -- the loop drained as fast as it filled
//   oldest queued age  seconds
//   workers            1, healthy
//   awaiting recovery  0
//
// The system was not stopped. It was extremely busy achieving nothing, and
// nothing it measured could tell those apart. A health check that only reports
// the things that happen to be working is worse than none, because it is
// actively reassuring -- the same lesson the queue-health comment records from
// the Redis outage, arriving from the opposite direction.
//
// WHAT A RATIO ADDS
//
// A ratio compares work done against work that should be needed. A file needs
// roughly nine job rows in its life; a location needs one scan per configured
// interval. When the measured number is two orders of magnitude above the
// expected one, the pipeline is looping -- whatever the queue depth says.
//
// These are deliberately CHEAP and deliberately BOUNDED to a 24-hour window.
// They run on every /api/health call, which restart-atlas.bat polls, so they
// must not be a table scan of a table whose size is the thing they are
// watching.
const db = require("../config/database");
const env = require("../config/env");

/**
 * How many times one stage may legitimately run for one file in a day.
 *
 * The queue's own retry budget is 3 (pgQueue.MAX_ATTEMPTS) and the per-stage
 * pipeline budget is 3 (pipelineState.MAX_RETRIES_PER_STAGE), so a genuinely
 * troubled file might reach 9 in a day. A person re-running something by hand
 * adds a few more. Ten is comfortably above every legitimate case and three
 * orders of magnitude below a loop, which reached 1,379.
 *
 * The gap between "legitimate worst case" and "the bug" is enormous, which is
 * what makes this threshold easy to set and hard to trip by accident.
 */
const MAX_RUNS_PER_FILE_PER_DAY = parseInt(process.env.HEALTH_MAX_RUNS_PER_FILE || "10", 10);

/**
 * How far above the configured cadence a location's scan count may drift.
 *
 * Scans are driven by a timer AND by filesystem events, so exceeding the timer
 * count is normal -- saving a file should ingest it promptly. What is not
 * normal is exceeding it by a large multiple, which is what a self-triggering
 * watcher looks like: the observed rate was 1,549 scans in a day against a
 * 60-minute interval, or 64x.
 *
 * 8x leaves generous room for a busy day of real edits while catching a
 * runaway an order of magnitude before it fills a disk.
 */
const SCAN_RATE_MULTIPLIER = parseInt(process.env.HEALTH_SCAN_RATE_MULTIPLIER || "8", 10);

/**
 * The ratios, as one round trip.
 *
 * Written as a single query with independent subqueries rather than three
 * calls: this runs on every health check, and three round trips to answer one
 * question is three chances to be the reason the health check is slow.
 */
async function ratios() {
  const expectedScansPerDay = Math.max(
    1,
    Math.ceil((24 * 60) / Math.max(1, env.watch.rescanIntervalMinutes))
  );

  const { rows } = await db.query(
    `WITH recent AS (
       SELECT job_type, payload->>'fileId' AS file_id, storage_location_id
         FROM processing_jobs
        WHERE created_at > now() - interval '24 hours'
     ),
     worst_file AS (
       SELECT job_type, file_id, count(*)::int AS runs
         FROM recent
        WHERE file_id IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 3 DESC
        LIMIT 1
     ),
     worst_location AS (
       SELECT storage_location_id, count(*)::int AS scans
         FROM recent
        WHERE job_type = 'scan' AND storage_location_id IS NOT NULL
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT 1
     )
     SELECT
       (SELECT count(*)::int FROM recent)                                    AS jobs_24h,
       (SELECT count(*)::int FROM files
         WHERE status = 'active' AND deleted_at IS NULL)                     AS active_files,
       (SELECT runs      FROM worst_file)                                    AS worst_file_runs,
       (SELECT job_type  FROM worst_file)                                    AS worst_file_stage,
       (SELECT file_id   FROM worst_file)                                    AS worst_file_id,
       (SELECT scans     FROM worst_location)                                AS worst_location_scans,
       (SELECT storage_location_id::text FROM worst_location)                AS worst_location_id,
       pg_total_relation_size('processing_jobs')                             AS jobs_bytes,
       pg_total_relation_size('audit_logs')                                  AS audit_bytes`
  );

  const r = rows[0] || {};
  const activeFiles = r.active_files || 0;
  const operationalBytes = Number(r.jobs_bytes || 0) + Number(r.audit_bytes || 0);

  const result = {
    jobs24h: r.jobs_24h || 0,
    activeFiles,
    // Reported for context rather than alerted on: during a genuine first
    // ingest this is legitimately ~9, and after it settles to ~0. There is no
    // threshold that is meaningful in both phases, which is exactly why the
    // per-file repeat count below is the signal that actually works.
    jobsPerFile: activeFiles ? Number((r.jobs_24h / activeFiles).toFixed(2)) : 0,
    worstFile: r.worst_file_runs
      ? { fileId: r.worst_file_id, stage: r.worst_file_stage, runs: r.worst_file_runs }
      : null,
    worstLocation: r.worst_location_scans
      ? { storageLocationId: r.worst_location_id, scans: r.worst_location_scans }
      : null,
    expectedScansPerDay,
    operationalBytes,
    operationalBytesPerFile: activeFiles ? Math.round(operationalBytes / activeFiles) : 0,
    warnings: [],
  };

  // THE SIGNAL THAT WOULD HAVE CAUGHT IT. One file, one stage, run more times
  // in a day than any legitimate retry path allows.
  if (result.worstFile && result.worstFile.runs > MAX_RUNS_PER_FILE_PER_DAY) {
    result.warnings.push(
      `A single file has had its "${result.worstFile.stage}" stage run ${result.worstFile.runs} times ` +
      `in 24 hours (file ${result.worstFile.fileId}). Nothing legitimate re-runs one stage more than ` +
      `${MAX_RUNS_PER_FILE_PER_DAY} times -- the pipeline is almost certainly re-queueing work it has ` +
      "already done. Check what is selecting that file for reprocessing."
    );
  }

  // The other half of the same incident: a watcher triggering scans that cause
  // the writes that trigger the next scan.
  const scanCeiling = expectedScansPerDay * SCAN_RATE_MULTIPLIER;
  if (result.worstLocation && result.worstLocation.scans > scanCeiling) {
    result.warnings.push(
      `One storage location was scanned ${result.worstLocation.scans} times in 24 hours, against a ` +
      `configured cadence of about ${expectedScansPerDay}. That usually means something is writing ` +
      "into a watched folder -- check that no location overlaps MIRROR_ROOT or another location."
    );
  }

  // Slow-moving, and the one that says "this will become a problem" rather than
  // "this is one". 100 KB of queue and audit history per file is generous;
  // during the incident it reached 720 KB per file.
  if (activeFiles > 100 && result.operationalBytesPerFile > 100 * 1024) {
    result.warnings.push(
      `Operational history is ${Math.round(result.operationalBytesPerFile / 1024)} KB per file ` +
      `(${Math.round(operationalBytes / 1024 / 1024)} MB total). Retention should keep this well under ` +
      "100 KB; a number this high means job or audit rows are accumulating faster than they are removed."
    );
  }

  return result;
}

module.exports = { ratios, MAX_RUNS_PER_FILE_PER_DAY, SCAN_RATE_MULTIPLIER };
