// Asks, once a day, whether any operational history has outlived its window.
//
// Modelled on trashPurgeScheduler, and for the same reasons -- a plain interval
// in the API process that goes through the ordinary enqueueJob, so the purge is
// a processing_jobs row like everything else: visible on the Processing Jobs
// page, claimed by the normal queue, and audit-logged. For an operation that
// removes rows permanently, "no record that it ran" is not an acceptable trade.
//
// WHY THIS IS SEPARATE FROM THE TRASH PURGE
//
// They look alike and answer different questions. The trash purge bounds how
// long a DELETED FILE stays recoverable, which is a promise to the user about
// their documents. This bounds how long the RECORD OF WORK is kept, which is a
// promise to the operator about the database. Merging them would put a
// user-facing retention window and an infrastructure one behind a single
// setting, and the first time someone wanted a 90-day Trash they would get 90
// days of hash telemetry with it.
const { enqueueJob } = require("../queues");
const db = require("../config/database");
const { JobType } = require("../models/enums");
const env = require("../config/env");

const INTERVAL_MS = 24 * 60 * 60 * 1000;

// Longer than the trash purge's five minutes. Both fire at boot, and there is
// no reason for the one that may delete millions of rows to start while the
// worker is still picking up the backlog a restart left behind.
const FIRST_RUN_DELAY_MS = 15 * 60 * 1000;

let intervalHandle = null;
let firstRunHandle = null;

/**
 * Whose history to trim.
 *
 * Read from `users` rather than `SELECT DISTINCT owner_user_id FROM
 * processing_jobs`: the distinct scan is over the largest table in the database
 * and is asked once a day to produce an answer the users table already has, in
 * a handful of rows. The purge itself is a no-op for an owner with nothing
 * expired, so listing an idle account costs one cheap indexed query.
 */
async function ownersToSweep() {
  const { rows } = await db.query("SELECT id FROM users WHERE status = 'active'");
  return rows.map((r) => r.id);
}

async function tick() {
  let owners;
  try {
    owners = await ownersToSweep();
  } catch (err) {
    console.error("[retention-scheduler] Could not list owners:", err.message);
    return;
  }

  if (owners.length === 0) return;

  let queued = 0;
  for (const ownerUserId of owners) {
    try {
      await enqueueJob(JobType.PURGE_OPERATIONAL, { ownerUserId }, { ownerUserId });
      queued += 1;
    } catch (err) {
      // One owner failing must not stop the others -- a sweep skipped tonight
      // is retried tomorrow, but only if the loop survives to get there.
      console.error(
        `[retention-scheduler] Failed to enqueue a sweep for owner ${ownerUserId}:`,
        err.message
      );
    }
  }
  console.log(`[retention-scheduler] Queued ${queued} operational-history sweep(s).`);
}

function startOperationalRetentionScheduler() {
  if (intervalHandle) return; // idempotent
  firstRunHandle = setTimeout(tick, FIRST_RUN_DELAY_MS);
  firstRunHandle.unref?.();
  intervalHandle = setInterval(tick, INTERVAL_MS);
  // unref so a graceful shutdown is not held open waiting on a day-long timer.
  intervalHandle.unref();
  console.log(
    `[retention-scheduler] Started -- completed jobs kept ${env.retention.completedJobDays} day(s), ` +
    `failed jobs ${env.retention.failedJobDays}, pipeline telemetry ${env.retention.telemetryDays}. ` +
    "Sign-ins, downloads, renames and every other audit record are never swept."
  );
}

function stopOperationalRetentionScheduler() {
  if (firstRunHandle) clearTimeout(firstRunHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  firstRunHandle = null;
  intervalHandle = null;
}

module.exports = { startOperationalRetentionScheduler, stopOperationalRetentionScheduler };
