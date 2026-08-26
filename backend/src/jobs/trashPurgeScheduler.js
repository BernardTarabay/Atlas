// Asks, once a day, whether anything in the Trash has run out its retention.
//
// Modelled on emailSyncScheduler and for the same reason: a plain interval in
// the API process that calls the ordinary enqueueJob, rather than a BullMQ
// repeatable job. This application's invariant is that a job is always a
// processing_jobs row created through enqueueJob (queues/index.js), and a
// scheduler-fired job that skipped that would be invisible on the Processing
// Jobs page and absent from the audit trail. For the one operation that removes
// rows permanently, "no record that it ran" is not an acceptable trade.
//
// The interval is deliberately coarse. Retention is measured in days, so
// checking hourly would buy nothing except a busier job list -- a document
// whose window closes at 3am being removed at noon is exactly as deleted.
const { enqueueJob } = require("../queues");
const lifecycleService = require("../services/lifecycleService");
const { JobType } = require("../models/enums");
const env = require("../config/env");

const INTERVAL_MS = 24 * 60 * 60 * 1000;
// A short delay after boot rather than firing immediately: a server that
// restarts repeatedly should not enqueue a purge on every start.
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

let intervalHandle = null;
let firstRunHandle = null;

async function tick() {
  // ONE JOB PER OWNER, not one job for everybody.
  //
  // This used to enqueue a single ownerless purge, and it never once ran. Every
  // job is a processing_jobs row and every such row must name an owner
  // (migration 028), so processingJobs.create refused it -- correctly -- and
  // the rejection went to a console log nobody was reading. The Trash was never
  // emptied, silently, for as long as the feature has existed.
  //
  // Exempting this job from ownership was the tempting fix and the wrong one:
  // the purge would then be the one operation reading and deleting across every
  // account at once, and it would be invisible on the Jobs page of the person
  // whose files it removed. Scoping it instead keeps the invariant and makes
  // each purge answerable to somebody.
  const retentionDays = env.trash.retentionDays;
  let owners;
  try {
    owners = await lifecycleService.findOwnersWithExpired({ retentionDays });
  } catch (err) {
    console.error("[trash-purge-scheduler] Could not list owners with expired Trash:", err.message);
    return;
  }

  if (owners.length === 0) return;

  let queued = 0;
  for (const ownerUserId of owners) {
    try {
      await enqueueJob(JobType.PURGE_TRASH, { retentionDays, ownerUserId }, { ownerUserId });
      queued += 1;
    } catch (err) {
      // One owner failing must not stop the others -- a purge skipped this
      // cycle is retried tomorrow, but only if the loop survives.
      console.error(`[trash-purge-scheduler] Failed to enqueue a purge for owner ${ownerUserId}:`, err.message);
    }
  }
  console.log(`[trash-purge-scheduler] Queued ${queued} purge job(s) for ${owners.length} owner(s).`);
}

function startTrashPurgeScheduler() {
  if (intervalHandle) return; // idempotent
  firstRunHandle = setTimeout(tick, FIRST_RUN_DELAY_MS);
  firstRunHandle.unref?.();
  intervalHandle = setInterval(tick, INTERVAL_MS);
  // unref so a graceful shutdown is not held open waiting on a day-long timer.
  intervalHandle.unref();
  console.log(
    `[trash-purge-scheduler] Started -- Trash is emptied after ${env.trash.retentionDays} day(s).`
  );
}

function stopTrashPurgeScheduler() {
  if (firstRunHandle) clearTimeout(firstRunHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  firstRunHandle = null;
  intervalHandle = null;
}

module.exports = { startTrashPurgeScheduler, stopTrashPurgeScheduler };
