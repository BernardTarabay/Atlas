// The queue engine, on Postgres. Replaces BullMQ + Redis (migration 040).
//
// This file owns exactly three things: claiming a job, deciding what happens
// when one fails, and waking a worker up when new work arrives. Everything
// else -- what a job means, who owns it, what it does -- lives where it did
// before.
//
// THE ONE IDEA
//
// `processing_jobs` is both the record and the queue. There is no second store
// to keep in step, so a job cannot exist in one and not the other. That was the
// failure mode under BullMQ: the row was written first and the Redis enqueue
// second, and a blip between the two left a row marked 'queued' that nothing
// would ever run.
//
// CLAIMING
//
// One statement moves a row from 'queued' to 'running' and returns it. The
// inner SELECT takes `FOR UPDATE SKIP LOCKED`, which is what makes several
// workers safe without any coordination between them: two workers racing for
// the same row do not block each other, the second simply skips to the next
// row. This is the standard Postgres queue pattern and the reason a queue does
// not need a dedicated broker.
const db = require("../config/database");

// Matches the BullMQ configuration this replaced: `attempts: 3` with
// exponential backoff from 5s. Kept identical so retry behaviour does not
// silently change along with the transport.
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 5000;

// How long a job may sit in 'running' before it is assumed abandoned.
//
// This is the replacement for BullMQ's stalled-job detection, and it needs to
// be comfortably longer than the slowest thing a processor legitimately does.
// The slowest observed stage is `describe` at 67s (a video actually being
// watched), so ten minutes leaves a wide margin. Too low is far worse than too
// high: it would run a still-running job a second time.
const STALE_RUNNING_MS = 10 * 60 * 1000;

const NOTIFY_CHANNEL = "processing_jobs_available";

/** Exponential backoff, matching BullMQ's `{ type: "exponential", delay: 5000 }`. */
function backoffMs(attempts) {
  return BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

/**
 * Claim the next runnable job of one of `jobTypes`, or null if there is none.
 *
 * The UPDATE and the SELECT are one statement on purpose. Selecting first and
 * updating second would leave a window in which another worker claims the same
 * row -- the classic double-processing bug that SKIP LOCKED exists to close.
 */
async function claimNext(jobTypes) {
  if (!jobTypes.length) return null;

  const { rows } = await db.query(
    `UPDATE processing_jobs
        SET status      = 'running',
            started_at  = now(),
            attempts    = attempts + 1,
            updated_at  = now()
      WHERE id = (
            SELECT id
              FROM processing_jobs
             WHERE status    = 'queued'
               AND run_after <= now()
               AND job_type  = ANY($1::job_type[])
               -- The global pause (queue_control, migrations 040 + 041).
               -- Checked inside the claim rather than in the worker loop so a
               -- pause takes effect for every worker at once, including ones
               -- in other processes -- which is what BullMQ's pause() did and
               -- what the verify-* fixtures rely on.
               --
               -- An EXPIRED lease is not a pause. paused_until is what stops
               -- a verify script that was SIGKILLed mid-run from leaving the
               -- live queue halted forever: it renews the lease while it is
               -- alive, and a dead process renews nothing. NULL still means
               -- indefinite, because a human pausing by hand should stay
               -- paused until they say otherwise.
               AND NOT COALESCE((
                     SELECT paused AND (paused_until IS NULL OR paused_until > now())
                       FROM queue_control
                   ), false)
             ORDER BY created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
      )
      RETURNING *`,
    [jobTypes]
  );

  return rows[0] || null;
}

/**
 * Put a failed job back for another attempt, or give up on it.
 *
 * Returns true when it will be retried. The caller does not decide the policy;
 * the budget lives here so every path through the system retries the same way.
 */
async function releaseFailed(job, errorMessage) {
  if (job.attempts < MAX_ATTEMPTS) {
    await db.query(
      `UPDATE processing_jobs
          SET status        = 'queued',
              run_after     = now() + ($2::int * interval '1 millisecond'),
              error_message = $3,
              started_at    = NULL,
              updated_at    = now()
        WHERE id = $1`,
      [job.id, backoffMs(job.attempts), errorMessage]
    );
    return true;
  }

  await db.query(
    `UPDATE processing_jobs
        SET status        = 'failed',
            error_message = $2,
            finished_at   = now(),
            updated_at    = now()
      WHERE id = $1`,
    [job.id, errorMessage]
  );
  return false;
}

/**
 * Return jobs abandoned mid-flight to the queue.
 *
 * A worker killed while running a job leaves its row at 'running' forever --
 * invisible to the claim query, which only looks at 'queued'. Without this the
 * job is lost silently, which is the worst of the available outcomes: the file
 * never finishes and nothing says so.
 *
 * Recovered jobs keep their attempts count, so a job that reliably kills its
 * worker exhausts its budget and fails honestly rather than looping forever.
 */
async function recoverStale() {
  const { rows } = await db.query(
    `UPDATE processing_jobs
        SET status     = CASE WHEN attempts >= $2 THEN 'failed'::job_status ELSE 'queued'::job_status END,
            run_after  = now(),
            started_at = NULL,
            finished_at   = CASE WHEN attempts >= $2 THEN now() ELSE NULL END,
            error_message = CASE
                              WHEN attempts >= $2
                              THEN 'Abandoned by a worker that stopped mid-job, and out of retries.'
                              ELSE 'Abandoned by a worker that stopped mid-job; requeued.'
                            END,
            updated_at = now()
      WHERE status = 'running'
        AND started_at < now() - ($1::int * interval '1 millisecond')
      RETURNING id, job_type, status`,
    [STALE_RUNNING_MS, MAX_ATTEMPTS]
  );
  return rows;
}

/**
 * Tell listening workers that a job is waiting.
 *
 * NOTIFY is an optimisation, never a guarantee: it is not delivered to a worker
 * that is not currently connected, and a payload is not queued for later. The
 * poll interval in the worker is what makes the system correct; this only makes
 * it fast. Treating NOTIFY as the delivery mechanism rather than a hint is how
 * Postgres queues lose jobs.
 */
async function notifyJobAvailable() {
  try {
    await db.query(`NOTIFY ${NOTIFY_CHANNEL}`);
  } catch {
    // A failed hint must never fail an enqueue -- the job is already committed
    // and the poll will find it.
  }
}

// WORKER LIVENESS, the replacement for BullMQ's consumer registry.
//
// BullMQ registered every worker in Redis, which let scripts/run-pilot.js see
// whether a normal worker was already running and would compete with it for
// jobs. There is no registry here, so a worker takes a SHARED advisory lock on
// this key and holds it on its listener connection for as long as it lives.
//
// Shared, not exclusive, because several workers are legitimate -- an exclusive
// lock would make the second one block instead of report. Counting holders in
// pg_locks is then the same question BullMQ's getWorkers() answered.
//
// The advantage over a registry row is that it needs no cleanup: Postgres drops
// the lock when the connection goes, so a worker killed with SIGKILL stops
// counting immediately rather than leaving a tombstone to be reaped.
const WORKER_LOCK_CLASS = 4070;
const WORKER_LOCK_OBJ = 40;

/** Hold for the lifetime of `client`. Returns false if the lock was refused. */
async function registerWorker(client) {
  try {
    await client.query("SELECT pg_advisory_lock_shared($1, $2)", [WORKER_LOCK_CLASS, WORKER_LOCK_OBJ]);
    return true;
  } catch {
    return false;
  }
}

async function countActiveWorkers() {
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n
         FROM pg_locks
        WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND granted`,
      [WORKER_LOCK_CLASS, WORKER_LOCK_OBJ]
    );
    return rows[0]?.n || 0;
  } catch {
    return 0;
  }
}

/**
 * A queue health summary, for /api/health.
 *
 * THE INCIDENT THIS ANSWERS
 *
 * Redis stopped on a Friday and nothing noticed for two days. The worker was
 * alive and shouting connection errors into a log file, the API was fine, and
 * /api/health reported `{"status":"ok","database":"connected"}` the entire
 * time -- because it checked Postgres and nothing else. The failure surfaced
 * as "I can't delete my files".
 *
 * A health check that only reports the things that happen to be working is
 * worse than none, because it is actively reassuring. So this reports the two
 * facts that would have caught it: is anything able to run jobs, and is work
 * actually draining.
 */
async function queueHealth() {
  const [{ rows: pending }, pause, workers] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS queued,
              COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at)))::int, 0) AS oldest_seconds
         FROM processing_jobs
        WHERE status = 'queued' AND run_after <= now()`
    ),
    pauseState(),
    countActiveWorkers(),
  ]);

  const queued = pending[0]?.queued || 0;
  const oldestSeconds = pending[0]?.oldest_seconds || 0;
  const paused = pause.effective;

  const warnings = [];
  // No worker at all is reported whether or not work is waiting.
  //
  // Gating this on `queued > 0` was the first version and it was too clever:
  // it would have stayed silent for the whole first stretch of the Redis
  // outage, saying nothing until enough work piled up, and then blamed the
  // backlog rather than the dead worker. A worker that should be running and
  // is not is degraded immediately -- the queue being empty at this instant is
  // luck, not health.
  if (workers === 0) {
    warnings.push(
      queued > 0
        ? `No worker is running, and ${queued} job(s) are waiting.`
        : "No worker is running; queued work will not be processed."
    );
  }
  // Work that is not moving despite a worker being up. Ten minutes is well
  // past any single stage (the slowest measured is 67s).
  if (queued > 0 && workers > 0 && oldestSeconds > 600) {
    warnings.push(`The oldest queued job has been waiting ${Math.round(oldestSeconds / 60)} minutes.`);
  }
  // A paused queue is reported with WHO paused it and whether it will release
  // itself. Finding a halted queue and not knowing whether a test died or a
  // person meant it is most of the time-to-diagnosis, and the two want
  // opposite responses.
  if (paused) {
    warnings.push(
      pause.kind === "lease"
        ? `The queue is paused by ${pause.by || "a fixture"}; the lease releases it in ${pause.leaseSecondsLeft}s if nothing renews it.`
        : `The queue is paused indefinitely${pause.by ? ` by ${pause.by}` : ""}; jobs will not be claimed until it is resumed.`
    );
  }

  return {
    workers,
    paused,
    queued,
    oldestQueuedSeconds: oldestSeconds,
    pause: { kind: pause.kind, by: pause.by, leaseSecondsLeft: pause.leaseSecondsLeft },
    warnings,
  };
}

/**
 * Global pause / resume, the replacement for BullMQ's queue.pause().
 *
 * Pausing stops jobs being CLAIMED; it never interrupts one already running,
 * exactly as before. scripts/_fixtureQueue.js documents why that distinction
 * matters: it closes the race window rather than sealing it.
 */
async function setPaused(paused, by = null, { leaseMs = null } = {}) {
  await db.query(
    `UPDATE queue_control
        SET paused = $1,
            paused_at    = CASE WHEN $1 THEN now() ELSE NULL END,
            paused_by    = CASE WHEN $1 THEN $2 ELSE NULL END,
            paused_until = CASE WHEN $1 AND $3::int IS NOT NULL
                                THEN now() + ($3::int * interval '1 millisecond')
                                ELSE NULL END,
            updated_at = now()
      WHERE id = true`,
    [paused, by, leaseMs]
  );
  if (!paused) await notifyJobAvailable();
}

/**
 * Extend an existing lease. The heartbeat behind a fixture pause.
 *
 * Only ever touches a row that is already paused WITH a lease: it must not be
 * able to convert an operator's indefinite pause into an expiring one, or
 * revive a pause somebody has just lifted.
 */
async function renewPause(leaseMs, by = null) {
  const { rowCount } = await db.query(
    `UPDATE queue_control
        SET paused_until = now() + ($1::int * interval '1 millisecond'),
            updated_at = now()
      WHERE id = true AND paused = true AND paused_until IS NOT NULL
        AND ($2::text IS NULL OR paused_by = $2)`,
    [leaseMs, by]
  );
  return rowCount > 0;
}

/**
 * The pause as it actually applies, not merely as it is recorded.
 *
 * `effective` is the only field the queue itself acts on; the rest is for
 * whoever has to work out why the queue is paused. `kind` answers the question
 * that matters when you find a paused queue -- a fixture whose owner may be
 * long dead, or a person who meant it.
 */
async function pauseState() {
  const { rows } = await db.query(
    `SELECT paused, paused_by, paused_at, paused_until,
            (paused AND (paused_until IS NULL OR paused_until > now())) AS effective,
            COALESCE(EXTRACT(EPOCH FROM (paused_until - now()))::int, 0) AS lease_seconds_left
       FROM queue_control WHERE id = true`
  );
  const row = rows[0] || {};
  return {
    effective: Boolean(row.effective),
    recorded: Boolean(row.paused),
    by: row.paused_by || null,
    at: row.paused_at || null,
    until: row.paused_until || null,
    leaseSecondsLeft: row.lease_seconds_left || 0,
    // A lease that exists puts this pause in the "will release itself" class.
    kind: !row.paused ? "none" : row.paused_until ? "lease" : "indefinite",
  };
}

async function isPaused() {
  return (await pauseState()).effective;
}

module.exports = {
  claimNext,
  releaseFailed,
  recoverStale,
  notifyJobAvailable,
  setPaused,
  renewPause,
  pauseState,
  isPaused,
  registerWorker,
  countActiveWorkers,
  queueHealth,
  backoffMs,
  MAX_ATTEMPTS,
  STALE_RUNNING_MS,
  NOTIFY_CHANNEL,
};
