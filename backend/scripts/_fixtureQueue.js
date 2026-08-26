// Shared helper for the verify-* scripts: take the fixture files back out of
// the queue before asserting anything about them.
//
// WHY THIS EXISTS
//
// A verify script sets a file up in a specific state -- never hashed, text
// unreadable, last job failed -- and then checks what the app says about it.
// But creating those fixtures goes through scanProcessor, which enqueues real
// HASH jobs. If a worker is running, it picks them up and processes the
// fixtures out from under the assertions: the "never hashed" file gets hashed,
// the "nothing is queued for it" file acquires a queued job, and the script
// fails describing a state that was true when it was written and is not true a
// second later.
//
// WHAT MIGRATION 040 SIMPLIFIED
//
// This file used to have to remove each job TWICE -- once from Redis by uuid,
// once from `processing_jobs` -- because the job existed in both places and
// deleting one left the other. Now the row is the job, so a single DELETE is
// the whole operation, and the "already gone, already running, or Redis is
// down" catch that wrapped every removal has nothing left to guard.
//
// It still closes the window rather than sealing it: a job the worker has
// ALREADY started cannot be un-started. Running these scripts against an idle
// worker is still the reliable way, and this makes the common case work anyway.
const pgQueue = require("../src/queues/pgQueue");

// HOW LONG A FIXTURE PAUSE LIVES WITHOUT BEING RENEWED.
//
// This is the whole safety property. The pause is a LEASE (migration 041), not
// a flag: it expires unless something alive keeps pushing it forward. A script
// killed with SIGKILL cannot run cleanup -- that is the bug this replaced --
// but it also cannot renew a lease, so the queue comes back on its own within
// this window no matter how the script died.
//
// Short enough that a live queue is never halted for long by an accident;
// comfortably longer than the heartbeat interval so ordinary scheduling jitter
// or a slow query never lets a lease lapse under a script that is still
// running.
const PAUSE_LEASE_MS = 30_000;
const PAUSE_HEARTBEAT_MS = 10_000;

// Identifies the pause as a fixture's, and says which script. An operator who
// finds the queue paused should be able to read who did it off the row rather
// than guess -- see pgQueue.pauseState().
const PAUSE_OWNER = `verify-script:${require("path").basename(process.argv[1] || "unknown")}`;

let heartbeat = null;

/**
 * Stop any running worker from taking new jobs while a script sets up its
 * fixtures.
 *
 * Removing the jobs after the fact is not enough on its own: a live worker
 * claims one in the same millisecond scanProcessor enqueues it, so the fixture
 * is already being hashed before the script gets a chance to take it back.
 *
 * The pause is global -- it is a row in `queue_control` that the claim query
 * consults, so it stops the separate worker process too, not just this one.
 * That is what BullMQ's pause() did and what these scripts depend on, and it
 * is deliberately unchanged.
 *
 * WHAT CHANGED IS ITS LIFETIME.
 *
 * This used to set a plain boolean released by the caller's `finally`. That
 * made the pause outlive its owner: scripts/verify-all.js kills an overrunning
 * script with SIGKILL, `finally` never runs, and the LIVE document-processing
 * queue stayed globally paused with nothing to resume it. A verification tool
 * could take production down by timing out.
 *
 * Now the pause is leased and heartbeated for as long as this process is
 * alive. Cleanup is still called and still releases it immediately -- that is
 * the fast path -- but correctness no longer depends on cleanup running at
 * all, which is the only thing that survives SIGKILL.
 */
async function pauseQueues() {
  await pgQueue.setPaused(true, PAUSE_OWNER, { leaseMs: PAUSE_LEASE_MS });

  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    // Renew only our own lease. If someone else has since paused the queue, or
    // it has been resumed, this must not reach in and change their decision.
    pgQueue.renewPause(PAUSE_LEASE_MS, PAUSE_OWNER).catch(() => {});
  }, PAUSE_HEARTBEAT_MS);

  // The heartbeat must never be the reason the process stays alive. A script
  // that has finished its work should exit, and an unref'd timer lets it.
  if (heartbeat.unref) heartbeat.unref();
}

async function resumeQueues() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  await pgQueue.setPaused(false);
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} storageLocationId - remove jobs for this location's files
 */
async function dequeueFixtureJobs(pool, storageLocationId) {
  const SCOPE = `
    storage_location_id = $1
    OR payload->>'fileId' IN (SELECT id::text FROM files WHERE storage_location_id = $1)
  `;

  // One statement: deleting the row IS dequeuing the job.
  const { rows } = await pool.query(
    `DELETE FROM processing_jobs WHERE ${SCOPE} RETURNING id`,
    [storageLocationId]
  );
  return rows.length;
}

module.exports = { dequeueFixtureJobs, pauseQueues, resumeQueues, PAUSE_LEASE_MS, PAUSE_OWNER };
