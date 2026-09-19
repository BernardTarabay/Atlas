// Work through the unfiled pile, batch by batch.
//
// Thin, like describeProcessor: every decision lives in
// services/unfiledOrganizer.js, which is also what the "Organize unfiled"
// button calls for a single batch. One implementation, two triggers.
//
// WHY IT LOOPS HERE RATHER THAN RE-ENQUEUEING ITSELF
//
// A job that ends by enqueueing its successor is the usual way to page through
// a backlog, and it is wrong for this one: each pass creates folders, and the
// NEXT pass has to see them or it proposes them again. Keeping the loop in one
// job means one worker holds the whole sequence, so batch N+1 is planned
// against the taxonomy batch N just built. Re-enqueueing would also interleave
// with any other organize job and have two of them inventing the same folder
// from two different snapshots of the tree.
//
// The cost is a long-running job, which is exactly what the queue's stale-job
// recovery is for -- and progress is reported per batch, so it is never a
// silent hour.
const unfiledOrganizer = require("../../services/unfiledOrganizer");
const folderConsolidation = require("../../services/folderConsolidation");

/**
 * A ceiling on one run, so this always terminates.
 *
 * The loop's natural stop is "no unfiled files left", but it must not depend on
 * that: a batch the planner declines to file (everything low-confidence, or an
 * API failure) returns the same files to the next iteration, and without a cap
 * that is an infinite loop burning API calls. If the cap is hit the pile is
 * simply smaller and the job can be run again.
 */
const MAX_BATCHES = parseInt(process.env.ORGANIZE_UNFILED_MAX_BATCHES || "50", 10);

/**
 * How many batches in a row may file nothing before the run gives up.
 *
 * Not one. A single batch can legitimately fail -- everything in it scored low
 * confidence, or the planner proposed a name the guards refused -- while the
 * rest of the pile is perfectly filable. Since unplaced files bank an attempt
 * and drop out of the next selection, continuing looks at genuinely different
 * documents rather than asking the same question again.
 */
const MAX_EMPTY_BATCHES = 3;

async function handle({ ownerUserId, actorUserId, maxBatches }, job) {
  const owner = ownerUserId || actorUserId;
  if (!owner) throw new Error("organize_unfiled requires the owner whose files are being filed.");

  const limit = Math.min(parseInt(maxBatches, 10) || MAX_BATCHES, MAX_BATCHES);
  const totals = {
    batches: 0, considered: 0, filed: 0,
    createdFolders: [], reusedFolders: 0, skippedFolders: [],
  };

  const startingUnfiled = (await unfiledOrganizer.unfiledSummary(owner)).unfiled;
  let emptyStreak = 0;

  for (let i = 0; i < limit; i += 1) {
    const result = await unfiledOrganizer.organizeUnfiled(owner);

    // Nothing left, or nothing can be done -- either way this is the end of
    // the run and not a failure.
    if (!result.considered) break;
    if (result.reason) {
      totals.reason = result.reason;
      break;
    }

    totals.batches += 1;
    totals.considered += result.considered;
    totals.filed += result.filed;
    totals.reusedFolders += result.reusedFolders;
    totals.createdFolders.push(...result.createdFolders);
    totals.skippedFolders.push(...result.skippedFolders);

    if (startingUnfiled > 0) {
      await job?.updateProgress?.(Math.min(99, (totals.filed / startingUnfiled) * 100));
    }

    // A batch that files nothing is no longer a reason to stop immediately.
    //
    // It was, before files carried an attempt count: back then the next batch
    // would have selected the identical files and got the identical answer, so
    // continuing was pure waste. Now every considered-but-unplaced file banks
    // an attempt, which moves the selection window on -- so the very next batch
    // sees DIFFERENT documents, and one awkward batch is no reason to abandon a
    // backlog of thousands.
    //
    // What still has to terminate is a run where nothing anywhere can be
    // filed. A few consecutive empty batches is that signal, and it costs a
    // couple of planning calls to be sure rather than one.
    emptyStreak = result.filed === 0 ? emptyStreak + 1 : 0;
    if (emptyStreak >= MAX_EMPTY_BATCHES) break;
  }

  // CONSOLIDATE AT THE END OF THE RUN, NOT BETWEEN BATCHES.
  //
  // Planning is batch-wise and each batch only sees the tree as it stands, so
  // two batches can name the same idea differently -- "Forms And Templates" in
  // one, "Document Templates" in another. Neither is wrong given what it could
  // see, and no single planning call can notice, because noticing requires
  // reading the whole tree at once.
  //
  // Once per run rather than per batch: merging mid-run would delete folders
  // the next batch is about to be shown as existing, and it is a whole-tree
  // call each time. Measured on the first full backlog this collapsed 105
  // folders to 73 without touching a single one the user made.
  if (totals.filed > 0) {
    try {
      const c = await folderConsolidation.consolidate(owner);
      totals.consolidated = { merged: c.merged, filesMoved: c.filesMoved };
      if (c.merged) {
        console.log(`[organize-unfiled] Consolidated ${c.merged} duplicate folder(s), moving ${c.filesMoved} file(s).`);
      }
    } catch (err) {
      // A tidy-up failing must not fail a run that successfully filed
      // hundreds of documents. The duplicates are cosmetic; the filing is not.
      console.error(`[organize-unfiled] Consolidation failed: ${err.message}`);
    }
  }

  await job?.updateProgress?.(100);

  return {
    ...totals,
    createdFolders: totals.createdFolders.map((f) => f.path),
    remainingUnfiled: (await unfiledOrganizer.unfiledSummary(owner)).unfiled,
  };
}

module.exports = { handle, MAX_BATCHES };
