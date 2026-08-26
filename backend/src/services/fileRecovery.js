// File-level recovery: the consumer `failed_retryable` never had.
//
// WHAT WAS WRONG
//
// There were two kinds of "stuck" in this system and only one of them was
// ever swept up.
//
//   JOB-LEVEL   a worker dies mid-job and its row sits at 'running' forever.
//               pgQueue.recoverStale() finds those and requeues them.
//   FILE-LEVEL  a stage fails, the file is moved to 'failed_retryable', and
//               *nothing at all* looks at it again.
//
// The second had no equivalent. `failed_retryable` is documented in
// services/pipelineState.js as "a stage failed and retrying is still worth
// doing" -- a promise about future behaviour that no code kept. Grepping the
// whole of src/ for the state returned exactly one hit outside the state
// machine itself: the enum that defines it.
//
// That is not a theoretical gap. On 2026-08-26 a since-removed daily AI cap
// failed the `describe` stage for 5,730 files in four minutes. Each one was
// correctly marked `failed_retryable` with one attempt spent of a budget of
// three. The cap was then removed, the worker restarted with the fix, and the
// pipeline went on to touch those same rows for another thirteen hours --
// leaving every single one exactly where it was, because re-running a failed
// stage was nobody's job. 72% of the library, waiting on a retry that did not
// exist, while /api/health reported "ok".
//
// WHY THE EXISTING RESCAN DID NOT CATCH IT
//
// fileRepository.listUnprocessed is the self-healing pass, and it selects on
// `sha256_hash IS NULL OR no file_content row`. All 5,730 had both -- they
// failed at `describe`, which runs *after* those stages. The one safety net
// in the system is scoped to the early pipeline only, so a late-stage failure
// falls through it silently.
//
// THE DESIGN
//
// Deliberately the same shape as pgQueue.recoverStale(), one level up:
// periodic, idempotent, batch-limited, and it either makes progress or gives
// up honestly. It invents no new retry policy -- the per-stage budget in
// pipelineState (MAX_RETRIES_PER_STAGE) is the same one the processors count
// against, so a file cannot get a different number of chances depending on
// which mechanism happened to pick it up.
const db = require("../config/database");
const pipelineState = require("./pipelineState");
const { enqueueJob } = require("../queues");
const { JobType } = require("../models/enums");

/**
 * Which job re-runs a given stage.
 *
 * Every pipeline stage name is also a job type, so this is mostly identity --
 * but it is written out rather than assumed, because the two vocabularies are
 * allowed to diverge and a silent `undefined` job type would be a file that
 * looks recovered and never runs.
 *
 * `user` is deliberately absent: it is the marker for "a person dealt with
 * this", not a stage a worker can redo.
 */
const STAGE_JOB = Object.freeze({
  hash: JobType.HASH,
  extract_metadata: JobType.EXTRACT_METADATA,
  extract_text: JobType.EXTRACT_TEXT,
  classify: JobType.CLASSIFY,
  detect_duplicates: JobType.DETECT_DUPLICATES,
  detect_versions: JobType.DETECT_VERSIONS,
  generate_names: JobType.GENERATE_NAMES,
  describe: JobType.DESCRIBE,
  ocr: JobType.OCR,
});

/**
 * How many files one sweep will requeue.
 *
 * A batch rather than everything, for the same reason the pilot script does
 * not enqueue 9,000 jobs at once: a recovery backlog and live ingestion share
 * one worker, and a recovery that starves new files is its own outage. At the
 * default sweep interval this drains a five-figure backlog in minutes while
 * leaving room for whatever is arriving now.
 */
const DEFAULT_BATCH = parseInt(process.env.FILE_RECOVERY_BATCH || "500", 10);

/**
 * A file with a live job is not stranded, it is waiting its turn -- but only
 * if that job is plausibly still alive. Same reasoning, and the same 24h
 * bound, as fileRepository.listUnprocessed: taking a stale row's word for it
 * is what excludes a file from the mechanism meant to rescue it.
 */
const LIVE_JOB_WINDOW = "24 hours";

/**
 * Files that a stage failed on and that nothing is currently doing anything
 * about.
 *
 * The anti-join is the primary duplicate guard. The secondary one is that
 * recovering a file moves it out of `failed_retryable` (to `processing`), so
 * it cannot be selected twice even if two sweeps overlap.
 */
async function listStranded(limit, storageLocationId = null) {
  const { rows } = await db.query(
    `SELECT f.id, f.filename_current, f.failure_stage, f.failure_reason,
            f.retry_counts, f.owner_user_id, f.storage_location_id
       FROM files f
      WHERE f.pipeline_state = 'failed_retryable'
        AND f.status = 'active'
        AND f.deleted_at IS NULL
        AND ($2::uuid IS NULL OR f.storage_location_id = $2::uuid)
        AND NOT EXISTS (
              SELECT 1 FROM processing_jobs pj
               WHERE pj.status IN ('queued', 'running')
                 AND pj.payload->>'fileId' = f.id::text
                 AND pj.created_at > now() - interval '${LIVE_JOB_WINDOW}'
            )
      -- Oldest first: a file that has been stuck longest is the one whose
      -- owner has been waiting longest, and it makes the sweep's progress
      -- monotonic rather than arbitrary.
      ORDER BY f.state_changed_at
      LIMIT $1`,
    [limit, storageLocationId]
  );
  return rows;
}

/**
 * Give up on a file, in the open.
 *
 * A stage that cannot be re-run, or a budget that is spent, is a real answer
 * and belongs in a terminal state where the triage queue will show it to a
 * person. Leaving it at `failed_retryable` would mean this sweep reconsiders
 * it every minute forever and the user is never told the machine is done
 * trying -- which is the failure mode this whole file exists to remove, just
 * with a faster loop.
 */
async function giveUp(file, stage, why) {
  await pipelineState.transition(file.id, pipelineState.State.FAILED_TERMINAL, {
    stage,
    reason: `${file.failure_reason || "The stage failed."} (${why})`,
  });
}

/**
 * One recovery pass.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit] - ceiling on files touched by this sweep
 * @param {string} [opts.storageLocationId] - only this location's files.
 *   The periodic sweep passes nothing and covers everything; this exists so a
 *   recovery can be aimed at one location -- and so a test can assert against
 *   its own fixtures without the live backlog filling the batch first.
 * @param {boolean} [opts.dryRun] - report what would happen, change nothing
 * @returns {Promise<{requeued: number, exhausted: number, unrecoverable: number, scanned: number, byStage: object}>}
 */
async function recoverStranded({ limit = DEFAULT_BATCH, storageLocationId = null, dryRun = false } = {}) {
  const files = await listStranded(limit, storageLocationId);
  const result = { scanned: files.length, requeued: 0, exhausted: 0, unrecoverable: 0, byStage: {} };
  if (!files.length) return result;

  for (const file of files) {
    const stage = file.failure_stage || file.pipeline_stage;

    // A failure that never recorded which stage it was cannot be re-run as
    // anything in particular. Guessing would re-run the wrong stage.
    if (!stage) {
      result.unrecoverable += 1;
      if (!dryRun) await giveUp(file, null, "the failed stage was never recorded, so there is nothing specific to re-run");
      continue;
    }

    const jobType = STAGE_JOB[stage];
    if (!jobType) {
      result.unrecoverable += 1;
      if (!dryRun) await giveUp(file, stage, `no job re-runs the "${stage}" stage`);
      continue;
    }

    // The SAME budget the processors count against -- not a second opinion.
    if (!pipelineState.canRetry(file, stage)) {
      result.exhausted += 1;
      if (!dryRun) {
        await giveUp(file, stage, `gave up after ${pipelineState.retriesFor(file, stage)} attempts at ${stage}`);
      }
      continue;
    }

    if (dryRun) {
      result.requeued += 1;
      result.byStage[stage] = (result.byStage[stage] || 0) + 1;
      continue;
    }

    // ENQUEUE FIRST, then move the file.
    //
    // The other order has a hole: transitioning to 'processing' and then
    // failing to enqueue leaves a file that looks in-flight with nothing
    // running it -- stranded again, and now invisible to this sweep because
    // it is no longer `failed_retryable`. Enqueueing first means the worst
    // case is a job that runs against a file still marked failed, and the
    // processor's own markProcessing() corrects that on the way in.
    try {
      await enqueueJob(
        jobType,
        { fileId: file.id },
        { ownerUserId: file.owner_user_id, storageLocationId: file.storage_location_id }
      );
      await pipelineState.markRetrying(file.id, stage);
      result.requeued += 1;
      result.byStage[stage] = (result.byStage[stage] || 0) + 1;
    } catch (err) {
      // Leave it `failed_retryable`. The next sweep tries again, and the
      // per-stage budget is untouched because nothing actually ran.
      console.error(`[recovery] could not requeue ${file.id} (${stage}): ${err.message}`);
    }
  }

  return result;
}

/**
 * How much of the library is stuck, and how far past retrying it is.
 *
 * Exists to be reported. The incident that prompted all of this was not that
 * files failed -- it was that 5,730 of them could fail and every health
 * signal the system had still said "ok", so nobody looked for thirteen hours.
 * A number that only appears when someone thinks to run a query is not a
 * health signal.
 */
async function strandedSummary() {
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE pipeline_state = 'failed_retryable')::int AS retryable,
       count(*) FILTER (WHERE pipeline_state = 'failed_terminal')::int  AS terminal,
       COALESCE(EXTRACT(EPOCH FROM (
         now() - min(state_changed_at) FILTER (WHERE pipeline_state = 'failed_retryable')
       ))::int, 0) AS oldest_retryable_seconds
     FROM files
    WHERE status = 'active' AND deleted_at IS NULL`
  );
  const row = rows[0] || {};
  return {
    retryable: row.retryable || 0,
    terminal: row.terminal || 0,
    oldestRetryableSeconds: row.oldest_retryable_seconds || 0,
  };
}

module.exports = {
  recoverStranded,
  strandedSummary,
  listStranded,
  STAGE_JOB,
  DEFAULT_BATCH,
};
