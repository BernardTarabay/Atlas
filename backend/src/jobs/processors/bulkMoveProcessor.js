// "File everything matching THIS into THAT" -- the bulk move by criteria.
//
// WHY THIS EXISTS
//
// Every bulk filing action in the app until now started from a set the user
// had already assembled by hand: a page of ticked checkboxes, a photo grid, a
// triage queue, or the whole of one subject (move_subject_contents). All of
// them answer "move these files", and none of them answers "move every file
// LIKE this", which is the question someone with tens of thousands of
// documents actually has. "Put every 2019 invoice from the old NAS under
// Archive/2019" is not expressible as a list of ids you could realistically
// tick, and asking the assistant to enumerate them one move_file at a time
// turns one instruction into thousands of round trips.
//
// WHY IT IS A JOB AND NOT A REQUEST
//
// jobs/index.js used to note that `bulk_move` had no processor because "filing
// a document under a subject is a database-only operation handled
// synchronously by fileOrganizeService, so it never needed a queue". That
// held while the caller always had a hand-picked list in front of it. A filter
// does not have a size limit the user can see before they run it -- the same
// sentence can match nine files or ninety thousand -- so the work has to be
// something they can watch, walk away from, and see the result of on the
// Processing Jobs page, rather than a request that appears to hang.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not implement filing. It resolves a filter to a set of ids and then
// loops fileOrganizeService.moveManyToSubject exactly like the Library's bulk
// filing does, so every per-file duplicate check, ownership check and audit
// entry applies identically. A second filing implementation is the "four
// callers, four implementations" failure that module's header warns about, and
// the one that skips a check is always the fastest one written last.
const fileRepository = require("../../repositories/fileRepository");
const fileService = require("../../services/fileService");
const subjectRepository = require("../../repositories/subjectRepository");
const processingJobItemRepository = require("../../repositories/processingJobItemRepository");
const fileOrganizeService = require("../../services/fileOrganizeService");
const auditLogRepository = require("../../repositories/auditLogRepository");
const { parseFileFilters } = require("../../repositories/fileFilters");

// Files are filed one at a time inside moveManyToSubject; this only bounds how
// many ids are held and reported on at once.
const BATCH_SIZE = 200;

/**
 * The most files one instruction may move.
 *
 * Not a performance limit -- a real ceiling on how much a single sentence to a
 * chatbot is allowed to rearrange. A filter that matches more than this is
 * refused with the count, so the user narrows it deliberately instead of
 * discovering afterwards that "move my old files" reorganised the archive.
 */
const MAX_FILES_PER_MOVE = 50000;

async function handle(payload, bullJob) {
  const { filters: rawFilters, toSubjectId, actorUserId, confirmDuplicates = false } = payload;

  // `q` rides inside the filter object (that is how the assistant sends it and
  // how the filter bar sends it), but it is not a structured column, so it is
  // taken out before parseFileFilters -- which validates the shape and would
  // reject a field it does not know.
  const semanticQuery = typeof rawFilters?.q === "string" && rawFilters.q.trim()
    ? rawFilters.q.trim()
    : null;
  // Taken from the payload rather than re-derived, and never defaulted: an
  // unscoped filter would enumerate every account's corpus. Same rule as
  // bulkDeleteProcessor.
  const ownerUserId = payload.ownerUserId || actorUserId;
  if (!ownerUserId) throw new Error("bulk_move requires the owner whose files are being filed.");
  if (!toSubjectId) throw new Error("bulk_move requires a destination subject.");

  // Re-validated here rather than trusted from the payload. The job may run
  // minutes after it was enqueued, and the destination can be deleted in
  // between -- filing 40,000 files into a subject that no longer exists would
  // succeed row by row and leave them pointing at nothing.
  const destination = await subjectRepository.findByIdForOwner(toSubjectId, ownerUserId);
  if (!destination) throw new Error("The destination folder no longer exists.");

  // The SAME parser the HTTP listing uses, on the SAME query shape the filter
  // bar sends. The assistant's filter vocabulary is the UI's vocabulary; there
  // is no second filter language to keep in sync, and a filter that means one
  // thing on the Files page cannot come to mean another here.
  const filters = parseFileFilters(rawFilters || {}, ownerUserId);

  /**
   * The match set is resolved ONCE, up front, and then worked through.
   *
   * Paging the filter while mutating what it matches is a silent
   * correctness bug: `unfiled=true` stops matching a file the instant it is
   * filed, so every batch shifts the window and OFFSET 200 skips the 200
   * files that moved out from under it. Snapshotting the ids means the set
   * cannot move while it is being processed, and the number reported at the
   * end is the number that was matched at the start.
   */
  /**
   * SEMANTIC CRITERIA, when the request cannot be expressed as a filter.
   *
   * "Move all the documents about project X" is not a filter -- there is no
   * column for aboutness. It is a SEARCH, and the app already has one that
   * matches on meaning as well as wording (descriptionSearchService: every
   * file carries a plain-language description, and photos, video and audio
   * are described too). Running the move over those results is what lets the
   * assistant act on a description instead of refusing and offering to search.
   *
   * The query and the structured filters COMBINE. "Every PDF about the Marina
   * lease" is `q` plus `ext=pdf`, and the search path applies both, so a
   * semantic move is still narrowable by the ordinary fields.
   *
   * Ordering is irrelevant here and relevance ranking is not: a move either
   * includes a file or it does not. What the ranking DOES do is decide the cut
   * when there are more matches than the cap, which is why the cap check below
   * is left exactly as it was -- an over-large semantic match should be
   * narrowed by the user, not silently truncated to the top N.
   */
  const matched = semanticQuery
    ? await fileService.idsMatchingSearch(semanticQuery, {
        filters,
        limit: MAX_FILES_PER_MOVE + 1,
      })
    : await fileRepository.idsMatching({
        filters,
        subjectId: null, // subject is a FILTER here (descendant-inclusive), not a scope
        limit: MAX_FILES_PER_MOVE + 1,
      });

  if (matched.length > MAX_FILES_PER_MOVE) {
    throw new Error(
      `That matches more than ${MAX_FILES_PER_MOVE.toLocaleString()} files. ` +
      "Narrow it -- by date, folder, or file type -- and run it again."
    );
  }

  // Subtract the no-ops before starting. See fileRepository.idsCurrentlyInSubject.
  const alreadyThere = await fileRepository.idsCurrentlyInSubject(matched, toSubjectId);
  const toMove = matched.filter((id) => !alreadyThere.has(id));

  const summary = {
    matched: matched.length,
    alreadyInDestination: alreadyThere.size,
    moved: 0,
    needsConfirmation: 0,
    failed: 0,
    notFound: 0,
    destination: destination.name,
  };

  await auditLogRepository.record({
    userId: actorUserId,
    action: "file.move_by_filter.started",
    entityType: "subject",
    entityId: toSubjectId,
    newState: { filters: rawFilters, matched: matched.length, willMove: toMove.length },
    reason:
      `Filing ${toMove.length} file(s) into "${destination.name}" by filter` +
      (alreadyThere.size ? ` (${alreadyThere.size} were already there)` : ""),
  });

  for (let i = 0; i < toMove.length; i += BATCH_SIZE) {
    const batch = toMove.slice(i, i + BATCH_SIZE);

    const items = new Map();
    for (const fileId of batch) {
      items.set(
        fileId,
        await processingJobItemRepository.create({
          jobId: bullJob?.data?.processingJobId,
          fileId,
          status: "pending",
        })
      );
    }

    const result = await fileOrganizeService.moveManyToSubject({
      fileIds: batch,
      subjectId: toSubjectId,
      ownerUserId,
      source: fileOrganizeService.PlacementSource.USER,
      confirmDuplicates,
    });

    summary.moved += result.moved.length;
    summary.needsConfirmation += result.needsConfirmation.length;
    summary.failed += result.failed.length;
    summary.notFound += result.notFound.length;

    // Per-file outcomes, so "why did 12 of 4,000 not move" is answerable from
    // the Processing Jobs page rather than by re-running the filter and
    // comparing sets by eye.
    const moved = new Set(result.moved);
    const pending = new Set(result.needsConfirmation.map((n) => n.fileId));
    for (const [fileId, item] of items) {
      if (!item) continue;
      const status = moved.has(fileId) ? "succeeded" : pending.has(fileId) ? "skipped" : "failed";
      await processingJobItemRepository.complete(item.id, {
        status,
        error: status === "skipped" ? "A possible duplicate -- left where it was for review." : null,
      });
    }

    if (bullJob?.updateProgress) {
      await bullJob.updateProgress(Math.min(100, Math.round(((i + batch.length) / Math.max(1, toMove.length)) * 100)));
    }
  }

  await auditLogRepository.record({
    userId: actorUserId,
    action: "file.move_by_filter.finished",
    entityType: "subject",
    entityId: toSubjectId,
    newState: summary,
    reason: `Filed ${summary.moved} file(s) into "${destination.name}".`,
  });

  return summary;
}

module.exports = { handle, MAX_FILES_PER_MOVE, BATCH_SIZE };
