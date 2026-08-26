// Worker process entrypoint (spec architecture diagram: "Processing Workers"
// is a separate box from the API). Run with `npm run worker` -- this is
// intentionally never imported by src/server.js; the API process enqueues
// jobs, this process (one or more instances, possibly on different machines)
// executes them.
//
// As of migration 040 the work is claimed out of Postgres rather than Redis.
// What that changes here, and what it deliberately does not:
//
//   - a "worker" is now a LANE: a loop that claims one job, runs it, and asks
//     for the next. Concurrency is the number of lanes.
//   - lanes are split into two POOLS, which is the one piece of BullMQ
//     behaviour that had to be rebuilt rather than dropped. See below.
//   - processors are untouched. They still receive (payload, job) where job
//     exposes `.data.processingJobId` and `.updateProgress()`.
const db = require("../config/database");
const pgQueue = require("../queues/pgQueue");
const { runProcessingJob } = require("../jobs/runProcessingJob");
const { PROCESSORS } = require("../jobs");
const processingJobRepository = require("../repositories/processingJobRepository");
const { JobType } = require("../models/enums");
const fileRecovery = require("../services/fileRecovery");

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "4", 10);

// WHY TWO POOLS AND NOT ONE QUEUE OF EVERYTHING
//
// BullMQ ran a separate worker per job_type, each with its own concurrency, so
// a slow stage could never hold up a fast one. A single FIFO pool would lose
// that: measured against this database, `describe` averages 0.41s but peaks at
// 67s (a video actually being watched) and `ocr` averages 5.7s, while `hash`,
// `extract_metadata` and `detect_duplicates` are 0.01-0.14s. A scan enqueues
// tens of thousands of the fast ones and thousands of the slow ones, so in one
// FIFO pool every fast job would queue behind whatever slow job was ahead of
// it, and a scan that used to saturate on I/O would serialise on video.
//
// Rebuilding one pool per type would mean 18 poll loops mostly asking an empty
// table. Two pools is the smallest split that removes the actual problem:
// slow work cannot starve fast work, and the fast pool keeps draining.
const SLOW_JOB_TYPES = [JobType.DESCRIBE, JobType.OCR];

const IMPLEMENTED_TYPES = Object.keys(PROCESSORS);
const slowTypes = IMPLEMENTED_TYPES.filter((t) => SLOW_JOB_TYPES.includes(t));
const fastTypes = IMPLEMENTED_TYPES.filter((t) => !SLOW_JOB_TYPES.includes(t));

// Idle poll interval. NOTIFY normally wakes a lane the instant work is
// enqueued, so this is the fallback that makes the system correct when a hint
// is missed -- not the primary path. One second is cheap against a partial
// index and keeps latency invisible if a notification is ever lost.
const IDLE_POLL_MS = 1000;
const STALE_SWEEP_MS = 60 * 1000;

// How often stranded FILES are swept back into the pipeline.
//
// The job-level sweep above (STALE_SWEEP_MS) rescues abandoned jobs; this one
// rescues files whose stage failed and were then left in `failed_retryable`
// with nothing to re-run them -- see services/fileRecovery.js for the incident
// that made this necessary. Slower than the job sweep on purpose: a stranded
// file has already failed once, so it is not urgent, and a batch every couple
// of minutes drains a five-figure backlog without competing with live work.
const FILE_RECOVERY_SWEEP_MS = parseInt(process.env.FILE_RECOVERY_SWEEP_MS || String(2 * 60 * 1000), 10);

let running = true;
const idleWakeups = new Set();

/** Resolve every lane that is currently sleeping, so they re-check the queue. */
function wakeIdleLanes() {
  for (const wake of idleWakeups) wake();
  idleWakeups.clear();
}

function sleepUntilWorkOrTimeout(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      idleWakeups.delete(wake);
      resolve();
    }, ms);
    function wake() {
      clearTimeout(timer);
      resolve();
    }
    idleWakeups.add(wake);
  });
}

/**
 * The BullMQ-shaped job object the processors already expect.
 *
 * Kept deliberately identical so not one of the 18 processors had to change
 * when the transport did. `updateProgress` took a percentage under BullMQ and
 * still does -- bulkMoveProcessor is the only caller.
 */
function toJobHandle(row) {
  return {
    id: row.id,
    name: row.job_type,
    attemptsMade: row.attempts,
    data: { processingJobId: row.id, ...(row.payload || {}) },
    updateProgress: (value) => processingJobRepository.updateProgress(row.id, Math.round(value)),
  };
}

async function runOneLane(laneName, jobTypes) {
  while (running) {
    let row;
    try {
      row = await pgQueue.claimNext(jobTypes);
    } catch (err) {
      console.error(`[worker:${laneName}] claim failed: ${err.message}`);
      await sleepUntilWorkOrTimeout(IDLE_POLL_MS * 5);
      continue;
    }

    if (!row) {
      await sleepUntilWorkOrTimeout(IDLE_POLL_MS);
      continue;
    }

    const processor = PROCESSORS[row.job_type];
    const handle = toJobHandle(row);

    try {
      await runProcessingJob(handle, processor.handle);
      console.log(`[worker:${laneName}] completed ${row.job_type} ${row.id}`);
    } catch (err) {
      // runProcessingJob has already written the failure onto the row. What it
      // cannot decide is whether this was the last attempt -- that is the
      // queue's policy, so it is applied here.
      const willRetry = await pgQueue.releaseFailed(row, err.message).catch((e) => {
        console.error(`[worker:${laneName}] could not record failure for ${row.id}: ${e.message}`);
        return false;
      });
      console.error(
        `[worker:${laneName}] failed ${row.job_type} ${row.id}: ${err.message}` +
          (willRetry ? ` (retrying, attempt ${row.attempts}/${pgQueue.MAX_ATTEMPTS})` : " (giving up)")
      );
    }
  }
}

// THE LISTENER CONNECTION, AND WHY IT SUPERVISES ITSELF
//
// One dedicated connection does two jobs. It cannot come from the pool for the
// duration -- a pooled client is handed back between queries and would stop
// listening -- so it is checked out and held:
//
//   LISTEN               wakes a lane the moment work is enqueued.
//   the advisory lock    is what makes this worker VISIBLE. pgQueue counts
//                        holders of it in pg_locks to answer "is a worker
//                        alive", which /api/health reports.
//
// Those two have very different consequences when the connection drops, and
// treating them the same was a bug. Losing LISTEN is harmless: notification is
// only ever a latency hint and the 1s poll keeps the lanes correct, which is
// why the original comment said losing it was "the behaviour wanted". Losing
// the LOCK is not harmless at all -- Postgres releases it with the connection,
// so countActiveWorkers() drops to zero and /api/health starts reporting
//
//     "No worker is running; queued work will not be processed."
//
// while this process carries on claiming and completing jobs perfectly well.
// Permanently, because nothing reconnected. That is the same failure as the
// two-day Redis outage with the sign flipped: a health check that lies. A
// check that cries wolf gets ignored, and then it is not a check at all.
//
// So the connection is supervised. If it dies, this reconnects with backoff,
// re-registers the worker and re-acquires the lock, and the health signal
// becomes true again on its own. The fix is in the worker's lifecycle, not in
// making the health check more forgiving -- a health check that cannot tell
// the difference between a dead worker and a dropped socket is worth less
// than one that can.
const LISTENER_RETRY_MIN_MS = 1000;
const LISTENER_RETRY_MAX_MS = 30 * 1000;

function createListenerSupervisor() {
  let client = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer = null;

  /** Drop the current connection, telling the pool not to reuse it. */
  function discard(err) {
    if (!client) return;
    const dying = client;
    client = null;
    try {
      dying.removeAllListeners();
      // release(err) destroys the client rather than returning a connection
      // that may be half-dead to the pool for someone else to trip over.
      dying.release(err || new Error("listener discarded"));
    } catch {
      /* already gone */
    }
  }

  function scheduleReconnect(why) {
    if (stopped || reconnectTimer) return;
    attempt += 1;
    const delay = Math.min(LISTENER_RETRY_MIN_MS * 2 ** (attempt - 1), LISTENER_RETRY_MAX_MS);
    console.warn(
      `[worker] listener/lock connection lost (${why}); ` +
        `reconnecting in ${Math.round(delay / 1000)}s. Jobs keep running on the poll interval.`
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    // An unref'd timer must not be the only thing holding the process open,
    // but it also must not stop a shutdown that is already in progress.
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  async function connect() {
    if (stopped) return;
    try {
      const next = await db.pool.connect();

      // Register BEFORE announcing success: a connection that cannot take the
      // lock is not doing the job this connection exists for.
      const registered = await pgQueue.registerWorker(next);
      if (!registered) throw new Error("could not acquire the worker advisory lock");

      next.on("notification", () => wakeIdleLanes());
      // Both of these mean the same thing here: this connection is finished.
      next.on("error", (err) => { discard(err); scheduleReconnect(err.message); });
      next.on("end", () => { if (!stopped && client === next) { discard(); scheduleReconnect("connection ended"); } });

      await next.query(`LISTEN ${pgQueue.NOTIFY_CHANNEL}`);
      client = next;

      if (attempt > 0) {
        console.log("[worker] listener reconnected and worker re-registered; health reporting is accurate again.");
      }
      attempt = 0;

      // A reconnect means this worker was invisible for a while and may have
      // missed notifications in that window. Re-check the queue immediately
      // rather than waiting out a poll.
      wakeIdleLanes();
    } catch (err) {
      discard();
      scheduleReconnect(err.message);
    }
  }

  return {
    start: connect,
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      discard();
    },
    /** For the startup log and for tests: is the lock currently held here? */
    isConnected: () => Boolean(client),
  };
}

/**
 * Sweep stranded FILES back into the pipeline.
 *
 * The file-level counterpart to sweepStaleJobs. Logs every pass that does
 * anything, because the whole point is that this work stops being invisible:
 * the 5,730-file incident lasted thirteen hours precisely because nothing
 * said a word about it.
 */
async function sweepStrandedFiles() {
  try {
    const { requeued, exhausted, unrecoverable, byStage } = await fileRecovery.recoverStranded();
    if (requeued) {
      const detail = Object.entries(byStage).map(([stage, n]) => `${stage}=${n}`).join(" ");
      console.log(`[recovery] requeued ${requeued} stranded file(s): ${detail}`);
    }
    if (exhausted || unrecoverable) {
      console.warn(
        `[recovery] moved ${exhausted + unrecoverable} file(s) to failed_terminal ` +
          `(${exhausted} out of retries, ${unrecoverable} with no re-runnable stage).`
      );
    }
    if (requeued) wakeIdleLanes();
  } catch (err) {
    console.error(`[recovery] stranded-file sweep failed: ${err.message}`);
  }
}

async function sweepStaleJobs() {
  try {
    const recovered = await pgQueue.recoverStale();
    if (recovered.length) {
      const requeued = recovered.filter((r) => r.status === "queued").length;
      console.warn(
        `[worker] recovered ${recovered.length} job(s) abandoned mid-run ` +
          `(${requeued} requeued, ${recovered.length - requeued} out of retries).`
      );
      wakeIdleLanes();
    }
  } catch (err) {
    console.error(`[worker] stale sweep failed: ${err.message}`);
  }
}

async function main() {
  console.log(
    `[worker] Started. ${fastTypes.length} fast type(s) and ${slowTypes.length} slow type(s), ` +
      `${CONCURRENCY} lane(s) each. Queue: postgres (migration 040).`
  );

  const listener = createListenerSupervisor();
  await listener.start();

  // Anything left 'running' by a previous process is abandoned by definition --
  // this process has just started, so nothing is executing it.
  await sweepStaleJobs();
  const sweep = setInterval(sweepStaleJobs, STALE_SWEEP_MS);

  // Files stranded by an earlier failure are recovered on their own timer.
  // Run once at startup as well: a worker coming back up is the most likely
  // moment for there to be a backlog waiting, and making the operator wait
  // out the first interval to find out is the wrong default.
  await sweepStrandedFiles();
  const recoverySweep = setInterval(sweepStrandedFiles, FILE_RECOVERY_SWEEP_MS);

  const lanes = [];
  for (let i = 0; i < CONCURRENCY; i += 1) {
    lanes.push(runOneLane(`fast${i}`, fastTypes));
    if (slowTypes.length) lanes.push(runOneLane(`slow${i}`, slowTypes));
  }

  const shutdown = async (signal) => {
    console.log(`[worker] Received ${signal}, finishing in-flight jobs...`);
    running = false;
    wakeIdleLanes();
    clearInterval(sweep);
    clearInterval(recoverySweep);
    await Promise.allSettled(lanes);
    listener.stop();
    await db.pool.end().catch(() => {});
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await Promise.allSettled(lanes);
}

main().catch((err) => {
  console.error(`[worker] fatal: ${err.message}`);
  process.exit(1);
});
