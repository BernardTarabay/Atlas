// Background job tracking (spec §18/§22). Jobs are always rows, never bare
// in-memory tasks, so the frontend can poll/observe status regardless of
// which worker process picked the job up.
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");
const { requireOwner } = require("./ownership");

const base = createBaseRepository("processing_jobs");

/**
 * `owner_user_id` is distinct from `created_by`, and both are kept.
 *
 *   created_by     the human who pressed the button, NULL for anything a
 *                  timer started (the watcher's periodic rescan)
 *   owner_user_id  whose archive this work is being done to, never NULL
 *
 * They differ exactly when the system acts on its own: a scheduled rescan of
 * your folder has no creator but is unambiguously your job, and the Jobs page
 * must show it to you and to nobody else. Scoping that page on created_by
 * would have hidden every automatic job from its own owner while leaving
 * manual ones visible -- worse than either extreme, because it looks like the
 * background work simply is not happening.
 */
async function create({
  jobType, storageLocationId = null, payload = {},
  createdBy = null, ownerUserId, progressTotal = 0,
}) {
  requireOwner(ownerUserId, `processingJobs.create(${jobType})`);
  const { rows } = await db.query(
    `INSERT INTO processing_jobs
       (job_type, storage_location_id, payload, created_by, owner_user_id, progress_total)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [jobType, storageLocationId, payload, createdBy, ownerUserId, progressTotal]
  );
  return rows[0];
}

async function markStarted(id) {
  const { rows } = await db.query(
    "UPDATE processing_jobs SET status = 'running', started_at = now() WHERE id = $1 RETURNING *",
    [id]
  );
  return rows[0] || null;
}

async function updateProgress(id, progressCurrent) {
  await db.query("UPDATE processing_jobs SET progress_current = $2 WHERE id = $1", [id, progressCurrent]);
}

/**
 * Set the denominator after the fact, for jobs that can only count their own
 * work once they start (reindex has to resolve which files it covers before
 * it knows the total; enqueueJob's `progressTotal` option is set at enqueue
 * time, which is too early for that).
 */
async function updateProgressTotal(id, progressTotal) {
  await db.query("UPDATE processing_jobs SET progress_total = $2 WHERE id = $1", [id, progressTotal]);
}

async function markCompleted(id, result = null) {
  const { rows } = await db.query(
    `UPDATE processing_jobs SET status = 'completed', result = $2, finished_at = now() WHERE id = $1 RETURNING *`,
    [id, result]
  );
  return rows[0] || null;
}

async function markFailed(id, errorMessage) {
  const { rows } = await db.query(
    `UPDATE processing_jobs SET status = 'failed', error_message = $2, finished_at = now() WHERE id = $1 RETURNING *`,
    [id, errorMessage]
  );
  return rows[0] || null;
}

async function markCancelled(id) {
  const { rows } = await db.query(
    `UPDATE processing_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

async function listActive(ownerUserId, { limit = 50, offset = 0 } = {}) {
  requireOwner(ownerUserId, "processingJobs.listActive");
  const { rows } = await db.query(
    `SELECT * FROM processing_jobs
      WHERE status IN ('queued','running','retrying') AND owner_user_id = $3
      ORDER BY created_at ASC LIMIT $1 OFFSET $2`,
    [limit, offset, ownerUserId]
  );
  return rows;
}

async function listForOwner(ownerUserId, { limit = 50, offset = 0, status = null, jobType = null } = {}) {
  requireOwner(ownerUserId, "processingJobs.listForOwner");
  const { rows } = await db.query(
    `SELECT * FROM processing_jobs
      WHERE owner_user_id = $1
        AND ($4::text IS NULL OR status::text   = $4)
        AND ($5::text IS NULL OR job_type::text = $5)
      ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [ownerUserId, limit, offset, status, jobType]
  );
  return rows;
}

async function countForOwner(ownerUserId, { status = null, jobType = null } = {}) {
  requireOwner(ownerUserId, "processingJobs.countForOwner");
  const { rows } = await db.query(
    `SELECT count(*)::int AS count FROM processing_jobs
      WHERE owner_user_id = $1
        AND ($2::text IS NULL OR status::text   = $2)
        AND ($3::text IS NULL OR job_type::text = $3)`,
    [ownerUserId, status, jobType]
  );
  return rows[0].count;
}

async function findByIdForOwner(id, ownerUserId) {
  requireOwner(ownerUserId, "processingJobs.findByIdForOwner");
  const { rows } = await db.query(
    "SELECT * FROM processing_jobs WHERE id = $1 AND owner_user_id = $2",
    [id, ownerUserId]
  );
  return rows[0] || null;
}

module.exports = {
  ...base, create, markStarted, updateProgress, updateProgressTotal,
  markCompleted, markFailed, markCancelled, listActive, listForOwner, countForOwner,
  findByIdForOwner,
};
