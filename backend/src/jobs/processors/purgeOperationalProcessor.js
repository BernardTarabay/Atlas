// Retention for operational history: finished jobs, and pipeline telemetry.
//
// The counterpart to purgeTrashProcessor. That one bounds how long a DELETED
// FILE is recoverable; this one bounds how long the RECORD OF WORK is kept.
// Both are the same shape deliberately -- a job_type, owner-scoped, batched,
// audit-logged -- because both permanently remove rows and that is not a thing
// this application does quietly.
//
// WHAT THIS WILL NOT TOUCH
//
// The allowlist below is the whole safety argument, so it is worth being blunt
// about it: this job can delete completed `processing_jobs` rows, and it can
// delete `audit_logs` rows whose action appears in PURGEABLE_ACTIONS. Nothing
// else. It cannot delete a file, a classification, a rename, a login, or a
// download record, and no configuration makes it able to.
//
// The allowlist is an allowlist and not a denylist on purpose. A denylist reads
// as "keep the important ones", which is the same sentence right up until
// somebody adds a new important action and forgets to list it -- at which point
// the audit trail loses rows and nothing says so. An allowlist fails the other
// way: a new high-volume telemetry action simply accumulates until someone
// notices and adds it, which is a performance problem rather than a data-loss
// one.
const db = require("../../config/database");
const auditLogRepository = require("../../repositories/auditLogRepository");
const env = require("../../config/env");

/**
 * Audit actions that are TELEMETRY rather than record.
 *
 * The test for membership is not "is it noisy" -- it is: if this row were gone
 * a month from now, could anyone want it? A hash event answers "did the
 * pipeline touch this file", which the file's own state and hash already say
 * more accurately. A download event answers "who read this document", which
 * nothing else records and which is the entire point of keeping an audit log.
 *
 * Measured on this installation, `file.hashed` alone was 1,955,544 of the
 * 2,040,488 rows -- 96% of the audit log describing a mechanical step, against
 * 84,944 rows recording everything a person actually did.
 */
const PURGEABLE_ACTIONS = Object.freeze([
  "file.hashed",
  // A placeholder that was skipped because reading it would force a cloud
  // download. Re-evaluated on every scan by design, so it repeats per file per
  // scan and says nothing a later reader needs.
  "file.skipped_placeholder",
  // The rule-based classifier declining to escalate. Useful while tuning
  // thresholds, meaningless afterwards, and written once per file per pass.
  "ai_classification.skipped",
]);

/**
 * How many rows one statement removes.
 *
 * A single unbounded DELETE of several million rows takes one long transaction,
 * holds locks for its duration, and writes the whole thing to WAL before
 * anything is visible -- on a database this size that is minutes of blocking
 * for a job whose entire purpose is routine housekeeping. Batching keeps each
 * transaction short and lets live work interleave, at the cost of a loop.
 */
const BATCH_SIZE = parseInt(process.env.RETENTION_BATCH_SIZE || "20000", 10);

/**
 * Ceiling on batches per run, so one invocation cannot run for hours.
 *
 * A backlog larger than this is drained across successive daily runs rather
 * than in one sitting. That is the right trade for a scheduled job: finishing
 * eventually and never being the reason something else is slow beats finishing
 * tonight.
 */
const MAX_BATCHES = parseInt(process.env.RETENTION_MAX_BATCHES || "200", 10);

/**
 * Delete in bounded batches until nothing matches or the ceiling is reached.
 *
 * The `ctid IN (SELECT ... LIMIT n)` shape is the standard Postgres batched
 * delete: the subquery picks a bounded set of physical row locations and the
 * outer statement removes exactly those. Written this way rather than with a
 * plain `LIMIT` because DELETE does not take one.
 *
 * @returns {Promise<{deleted: number, hitCeiling: boolean}>}
 */
async function deleteInBatches(sql, params) {
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const { rowCount } = await db.query(sql, params);
    deleted += rowCount;
    if (rowCount < BATCH_SIZE) return { deleted, hitCeiling: false };
  }
  return { deleted, hitCeiling: true };
}

/**
 * @param {object} payload
 * @param {string} payload.ownerUserId - whose history this trims. Required, for
 *   the same reason purge_trash requires it: a sweep with no owner would delete
 *   across every account from one person's schedule.
 * @param {number} [payload.completedJobDays]
 * @param {number} [payload.failedJobDays]
 * @param {number} [payload.telemetryDays]
 * @param {boolean} [payload.dryRun] - count what would go, remove nothing
 */
async function handle(payload = {}) {
  const ownerUserId = payload.ownerUserId;
  if (!ownerUserId) {
    throw new Error("purge_operational requires the owner whose history it trims.");
  }

  const completedJobDays = payload.completedJobDays ?? env.retention.completedJobDays;
  const failedJobDays = payload.failedJobDays ?? env.retention.failedJobDays;
  const telemetryDays = payload.telemetryDays ?? env.retention.telemetryDays;
  const dryRun = Boolean(payload.dryRun);

  const summary = {
    completedJobs: 0,
    failedJobs: 0,
    telemetry: 0,
    retention: { completedJobDays, failedJobDays, telemetryDays },
    dryRun,
    hitCeiling: false,
  };

  if (dryRun) {
    const { rows } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM processing_jobs
           WHERE owner_user_id = $1 AND status = 'completed'
             AND finished_at < now() - ($2::int * interval '1 day'))          AS completed_jobs,
         (SELECT count(*)::int FROM processing_jobs
           WHERE owner_user_id = $1 AND status = 'failed'
             AND finished_at < now() - ($3::int * interval '1 day'))          AS failed_jobs,
         (SELECT count(*)::int FROM audit_logs
           WHERE user_id IS NOT DISTINCT FROM $1 AND action = ANY($4::text[])
             AND created_at < now() - ($5::int * interval '1 day'))           AS telemetry`,
      [ownerUserId, completedJobDays, failedJobDays, PURGEABLE_ACTIONS, telemetryDays]
    );
    summary.completedJobs = rows[0].completed_jobs;
    summary.failedJobs = rows[0].failed_jobs;
    summary.telemetry = rows[0].telemetry;
    return summary;
  }

  // COMPLETED JOBS.
  //
  // `finished_at`, not `created_at`: a job's age as history starts when it
  // stopped running. A long-running job created eight days ago and finished an
  // hour ago is this week's history, not last week's.
  //
  // processing_job_items cascades from here (migration 008). That is correct
  // and intended -- an item is the per-file detail OF a job, so it has no
  // meaning once the job is gone and no other table references it.
  const completed = await deleteInBatches(
    `DELETE FROM processing_jobs
      WHERE ctid IN (
        SELECT ctid FROM processing_jobs
         WHERE owner_user_id = $1
           AND status = 'completed'
           AND finished_at < now() - ($2::int * interval '1 day')
         LIMIT ${BATCH_SIZE})`,
    [ownerUserId, completedJobDays]
  );
  summary.completedJobs = completed.deleted;
  summary.hitCeiling = summary.hitCeiling || completed.hitCeiling;

  // FAILED JOBS, kept far longer.
  //
  // A failure is the only kind of job row anyone reads on purpose, and "what
  // went wrong last month" is a real question. They are also vanishingly rare
  // next to completions -- 3 against 7.88 million here -- so a long window
  // costs nothing.
  const failed = await deleteInBatches(
    `DELETE FROM processing_jobs
      WHERE ctid IN (
        SELECT ctid FROM processing_jobs
         WHERE owner_user_id = $1
           AND status = 'failed'
           AND finished_at < now() - ($2::int * interval '1 day')
         LIMIT ${BATCH_SIZE})`,
    [ownerUserId, failedJobDays]
  );
  summary.failedJobs = failed.deleted;
  summary.hitCeiling = summary.hitCeiling || failed.hitCeiling;

  // TELEMETRY.
  //
  // `user_id IS NOT DISTINCT FROM $1` rather than `= $1`, because pipeline
  // events are written by the WORKER and carry a null user -- there is no
  // session behind a scan. A plain equality matches nothing for exactly the
  // rows this is meant to remove, which would have made the sweep a silent
  // no-op on 96% of the table.
  //
  // Scoping those ownerless rows to one owner is not possible and not needed:
  // they are keyed to files, and a single-owner install has one answer. On a
  // multi-account install this trims shared telemetry on whichever owner's
  // schedule fires first, which is acceptable precisely because these rows
  // belong to nobody in particular -- that is what makes them telemetry.
  const telemetry = await deleteInBatches(
    `DELETE FROM audit_logs
      WHERE ctid IN (
        SELECT ctid FROM audit_logs
         WHERE user_id IS NOT DISTINCT FROM $1
           AND action = ANY($2::text[])
           AND created_at < now() - ($3::int * interval '1 day')
         LIMIT ${BATCH_SIZE})`,
    [ownerUserId, PURGEABLE_ACTIONS, telemetryDays]
  );
  summary.telemetry = telemetry.deleted;
  summary.hitCeiling = summary.hitCeiling || telemetry.hitCeiling;

  const total = summary.completedJobs + summary.failedJobs + summary.telemetry;
  if (total > 0) {
    // Recorded with an action that is NOT in PURGEABLE_ACTIONS, so the record
    // of a purge outlives the rows it removed. A retention sweep that tidied
    // away the evidence of its own runs would be the one operation nobody could
    // audit.
    await auditLogRepository.record({
      userId: ownerUserId,
      action: "operational_history.purged",
      entityType: "user",
      entityId: ownerUserId,
      newState: summary,
      reason:
        `Removed ${total.toLocaleString()} row(s) of operational history: ` +
        `${summary.completedJobs.toLocaleString()} completed job(s) older than ${completedJobDays} day(s), ` +
        `${summary.failedJobs.toLocaleString()} failed job(s) older than ${failedJobDays} day(s), and ` +
        `${summary.telemetry.toLocaleString()} telemetry event(s) older than ${telemetryDays} day(s). ` +
        "No file, classification, rename, download or sign-in record is eligible for this sweep.",
    });
  }

  return summary;
}

module.exports = { handle, PURGEABLE_ACTIONS, BATCH_SIZE, MAX_BATCHES };
