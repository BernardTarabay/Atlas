// Asks, periodically, whether anyone's unfiled pile has grown enough to be
// worth organizing -- and builds the folders it needs.
//
// WHY THIS EXISTS AT ALL
//
// services/unfiledOrganizer.js could already file the unfiled pile and invent
// the folders the archive was missing. It just had exactly one trigger: a
// button. That is fine for the person who built it and useless for the person
// it was built for -- point Atlas at a folder, and a large fraction of the
// documents land in Unfiled and stay there, because the folder each one needs
// does not exist and the classifier is structurally incapable of creating one.
// A client would have had to KNOW to go and press something.
//
// So the product promise -- point it at a folder and come back to an organized
// archive -- was true only if you already knew the trick. This closes that.
//
// WHY A SCHEDULER AND NOT A STEP IN THE PIPELINE
//
// The tempting version is to chain organizing onto the end of a scan. Two
// things break it. A scan finishes long before the files it discovered have
// been classified -- it enqueues hash jobs and returns, and classification is
// several stages downstream -- so a scan-chained pass would run against a pile
// that has not formed yet. And organizing is a CLUSTERING operation: it wants
// to see a few hundred unfiled documents at once so it can tell what they have
// in common. Firing it per scan, or worse per file, is the surest way to get
// folders holding one document each.
//
// A timer that asks "is there enough here to be worth a look?" matches the
// shape of the work. It is also the pattern this codebase already uses for
// periodic work (emailSyncScheduler, trashPurgeScheduler) -- a plain interval
// in the API process that calls the ordinary enqueueJob, so the resulting job
// is a processing_jobs row like every other: visible on the Processing Jobs
// page, audit-logged, claimed and retried by the same queue.
//
// SPENDING SOMEONE ELSE'S MONEY WHILE THEY ARE NOT LOOKING
//
// This is the only scheduled thing here that costs per run, so the limits are
// the design rather than an afterthought:
//
//   a threshold      below it, nothing happens. A handful of unfiled files is
//                    the normal residue of an import -- the planner is allowed
//                    to leave things alone -- and paying to re-examine six
//                    documents it already declined is waste.
//   a per-run cap    each run organizes a bounded number of batches, so one
//                    tick can never turn into an unbounded job.
//   a daily cap      and the runs themselves are capped per owner per day, so
//                    a 50,000-file import cannot run up an open-ended bill
//                    overnight. The backlog simply takes a few days, which is
//                    the correct trade for unattended spend.
//   never concurrent a run takes minutes; without this a slow pass gets another
//                    queued on top, and two passes planning against different
//                    snapshots of the tree is how the same folder gets invented
//                    twice.
//
// And a kill switch: ORGANIZE_UNFILED_AUTO=false turns the whole thing off
// without removing the button.
const { enqueueJob } = require("../queues");
const unfiledOrganizer = require("../services/unfiledOrganizer");
const { JobType } = require("../models/enums");
const env = require("../config/env");

let intervalHandle = null;
let firstRunHandle = null;

// A delay after boot rather than firing immediately: a server that restarts
// repeatedly must not enqueue a paid job on every start, and an import that is
// still running should be left to finish forming the pile first.
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;

async function tick() {
  const cfg = env.organizeUnfiled;
  if (!cfg.enabled) return;
  if (!env.ai.apiKey) return; // nothing can be proposed without a key

  let owners;
  try {
    owners = await unfiledOrganizer.findOwnersWithUnfiled(cfg.threshold);
  } catch (err) {
    console.error("[organize-unfiled-scheduler] Could not list owners:", err.message);
    return;
  }
  if (!owners.length) return;

  let queued = 0;
  for (const { owner_user_id: ownerUserId, unfiled } of owners) {
    try {
      const { inFlight, last24h } = await unfiledOrganizer.organizeRunsToday(ownerUserId);
      if (inFlight > 0) continue;
      if (last24h >= cfg.maxRunsPerDay) {
        console.log(
          `[organize-unfiled-scheduler] Owner ${ownerUserId} has ${unfiled} unfiled but has used ` +
            `today's ${cfg.maxRunsPerDay} run(s); leaving the rest for tomorrow.`
        );
        continue;
      }

      await enqueueJob(
        JobType.ORGANIZE_UNFILED,
        { ownerUserId, actorUserId: ownerUserId, maxBatches: cfg.batchesPerRun },
        { ownerUserId }
      );
      queued += 1;
      console.log(
        `[organize-unfiled-scheduler] Queued a pass for owner ${ownerUserId} ` +
          `(${unfiled} unfiled, up to ${cfg.batchesPerRun} batch(es)).`
      );
    } catch (err) {
      // One owner failing must not stop the others -- a pass skipped this cycle
      // runs next cycle, but only if the loop survives.
      console.error(`[organize-unfiled-scheduler] Failed for owner ${ownerUserId}:`, err.message);
    }
  }

  if (queued) console.log(`[organize-unfiled-scheduler] Queued ${queued} pass(es).`);
}

function startOrganizeUnfiledScheduler() {
  if (intervalHandle) return; // idempotent
  const cfg = env.organizeUnfiled;

  if (!cfg.enabled) {
    console.log("[organize-unfiled-scheduler] Disabled (ORGANIZE_UNFILED_AUTO=false).");
    return;
  }
  if (!env.ai.apiKey) {
    console.log("[organize-unfiled-scheduler] Not started: no GEMINI_API_KEY, so no folders can be proposed.");
    return;
  }

  firstRunHandle = setTimeout(tick, FIRST_RUN_DELAY_MS);
  firstRunHandle.unref?.();
  intervalHandle = setInterval(tick, cfg.intervalMinutes * 60 * 1000);
  intervalHandle.unref();

  console.log(
    `[organize-unfiled-scheduler] Started -- checking every ${cfg.intervalMinutes}m; ` +
      `organizes when ${cfg.threshold}+ files are unfiled, ` +
      `up to ${cfg.batchesPerRun} batch(es) per run and ${cfg.maxRunsPerDay} run(s) per day.`
  );
}

function stopOrganizeUnfiledScheduler() {
  if (firstRunHandle) clearTimeout(firstRunHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  firstRunHandle = null;
  intervalHandle = null;
}

module.exports = { startOrganizeUnfiledScheduler, stopOrganizeUnfiledScheduler, tick };
