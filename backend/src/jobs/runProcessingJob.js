// Generic wrapper every job processor is run through. Owns the
// processing_jobs row lifecycle (queued -> running -> completed/failed) so
// individual processors only implement their domain logic and never
// duplicate this bookkeeping (see docs/06-processing-pipeline.md §6.3/§6.6).
//
// WHAT MIGRATION 040 MOVED OUT OF HERE
//
// Two of the three writes this used to make are now done by the queue itself,
// and doing them here as well was not merely redundant -- it was wrong:
//
//   markStarted  the claim in pgQueue.claimNext already flips the row to
//                'running' and stamps started_at, in the same statement that
//                takes the row. Re-stamping it here would move started_at
//                after the fact, which is the field the stale-job sweep uses
//                to decide a worker died.
//
//   markFailed   whether a failure is terminal is the QUEUE's decision, not
//                this wrapper's -- it depends on the retry budget. Writing
//                'failed' here and then having the lane immediately correct it
//                back to 'queued' for a retry meant every retried job briefly
//                appeared as failed on the Jobs page, and cost two writes to
//                land on one state.
//
// So this now owns exactly the success path, and rethrows on failure for the
// lane in workers/runner.js to classify.
const processingJobRepository = require("../repositories/processingJobRepository");

/**
 * @param {{id: string, data: object, updateProgress: (n: number) => Promise<void>}} job
 *   The claimed job. Shaped by workers/runner.js `toJobHandle` to match what
 *   processors have always received.
 * @param {(payload: object, job: object) => Promise<object>} handler
 */
async function runProcessingJob(job, handler) {
  const { processingJobId, ...payload } = job.data;

  const result = await handler(payload, job);
  await processingJobRepository.markCompleted(processingJobId, result || null);
  return result;
}

module.exports = { runProcessingJob };
