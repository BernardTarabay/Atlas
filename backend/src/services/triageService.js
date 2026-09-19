// Triage: the one place collecting everything the pipeline could not
// confidently handle -- and, now, the place those files get resolved.
//
// WHAT CHANGED
//
// This service used to own three verbs: LIST, COUNT, RETRY. Everything else
// was "go and do it on the Files page", on the reasoning that a second code
// path for renaming is how the read-only guard and the audit entry end up
// applying on one page and not the other.
//
// That reasoning is right and is kept. What was wrong was the conclusion: the
// fix is not to withhold the action, it is to have ONE implementation that
// both pages call. So the verbs below delegate -- moving calls
// fileOrganizeService (and therefore the duplicate guard), renaming calls
// fileService.updateFile (and therefore the read-only guard and filename
// validation). Nothing here reimplements them.
//
// The result is that a file in triage can be resolved where it is found,
// which is what makes it a worklist rather than a list of complaints.
const triageRepository = require("../repositories/triageRepository");
const fileRepository = require("../repositories/fileRepository");
const fileContentRepository = require("../repositories/fileContentRepository");
const renameProposalRepository = require("../repositories/renameProposalRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const fileOrganizeService = require("./fileOrganizeService");
const fileService = require("./fileService");
const pipelineState = require("./pipelineState");
const duplicateGuard = require("./duplicateGuard");
const { REASONS, REASON_KEYS, retryPlanFor } = require("./triageReasons");
const { enqueueJob } = require("../queues");
const { parsePagination } = require("../utils/pagination");
const { ValidationError } = require("../validators/validationError");
const { requireOwner } = require("../repositories/ownership");
const { FileStatus, ProposalStatus } = require("../models/enums");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

/** Rejects an unknown ?reason= rather than silently returning the whole queue
 *  -- a typo'd filter that looks like it worked is how you conclude a reason
 *  has no files under it when it has thousands. */
function parseReason(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!REASON_KEYS.includes(value)) {
    throw new ValidationError(`Unknown triage reason "${value}". Valid reasons: ${REASON_KEYS.join(", ")}.`);
  }
  return value;
}

/**
 * The queue itself. Each row carries its reason plus the human-readable
 * explanation, whether retrying it can do anything, and WHICH ACTIONS APPLY.
 *
 * The action list is computed here rather than in the UI for the same reason
 * the retry plan is: the page must not have to keep its own copy of the rules
 * in sync. A file whose bytes are missing cannot be filed under a subject,
 * and a button that is offered and then fails is worse than one that is not
 * offered.
 */
async function list(query = {}, ownerUserId) {
  requireOwner(ownerUserId, "triageService.list");
  const { limit, offset } = parsePagination(query);
  const reason = parseReason(query.reason);
  const rows = await triageRepository.list(ownerUserId, { reason, limit, offset });

  return rows.map((row) => {
    const meta = REASONS[row.reason];
    const plan = retryPlanFor(row);
    return {
      ...row,
      size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
      reasonLabel: meta.label,
      reasonExplanation: meta.explanation,
      // What the retry button will actually do, decided here rather than
      // guessed at by the UI -- so the tooltip and the action can't disagree.
      retryable: !plan.blocked,
      retryJobType: plan.blocked ? null : plan.jobType,
      retryBlockedMessage: plan.blocked || null,
      actions: actionsFor(row),
      state: pipelineState.describe(row),
    };
  });
}

/**
 * Which of the workspace's actions make sense for this file.
 *
 * `missing` is the interesting case: the bytes are gone, so anything that
 * reads or writes the file is pointless, but filing it and archiving it are
 * still meaningful decisions about a record the user may want to keep.
 */
function actionsFor(row) {
  const gone = row.status === FileStatus.MISSING;

  // RETRY IS DELIBERATELY NOT OFFERED.
  //
  // It was, and it was the wrong tool for this queue. Retrying re-runs a
  // pipeline stage, and for the files that actually accumulate here -- a
  // photograph with no text layer, a video, a document whose extracted text is
  // noise -- the stage will reach exactly the same conclusion, because the
  // conclusion is correct. The file went straight back to triage, which read
  // as the button doing nothing.
  //
  // What resolves these files is a DECISION, not another pass: put it in a
  // folder, or get rid of it. So those are what the queue offers. The retry
  // endpoint still exists for the genuinely transient case (a stage that died
  // on a transient fault), and the Jobs page is where that belongs -- it is a
  // property of the failed job, not of the document.
  const actions = ["inspect", "move", "delete"];
  if (!gone) {
    actions.push("rename", "keep_name", "ask_ai", "check_duplicates");
    if (row.needs_ocr || row.reason === "needs_ocr") actions.push("run_ocr");
  }
  return actions;
}

/** Counts per reason (plus in-flight), for the filter tabs and the nav badge. */
async function summary(ownerUserId) {
  requireOwner(ownerUserId, "triageService.summary");
  const { byReason, total, inFlight } = await triageRepository.countByReason(ownerUserId);
  return {
    total,
    inFlight,
    // Every reason is present, including the zeros: a filter list that hides
    // its empty entries makes the remaining ones look like the whole story,
    // the same argument the dashboard's attention rows make.
    reasons: REASON_KEYS.map((key) => ({
      key,
      label: REASONS[key].label,
      explanation: REASONS[key].explanation,
      count: byReason[key] || 0,
    })),
  };
}

/** Everything needed to decide about one file, in one request. */
async function inspect(fileId, ownerUserId) {
  const file = await fileRepository.findByIdForOwner(fileId, ownerUserId);
  if (!file) throw new NotFoundError("File not found.");

  const [content, row, proposals] = await Promise.all([
    fileContentRepository.findByFile(fileId),
    triageRepository.findOne(fileId, ownerUserId),
    renameProposalRepository.listForFile(fileId),
  ]);

  return {
    file: { ...file, size_bytes: file.size_bytes === null ? null : Number(file.size_bytes) },
    state: pipelineState.describe(file),
    reason: row?.reason || null,
    reasonExplanation: row ? REASONS[row.reason]?.explanation : null,
    actions: row ? actionsFor(row) : ["inspect", "move", "rename", "archive"],
    text: content?.extracted_text ? content.extracted_text.slice(0, 4000) : null,
    textQuality: content?.text_quality || null,
    needsOcr: Boolean(content?.needs_ocr),
    pendingProposal: proposals.find((p) => p.status === ProposalStatus.PENDING) || null,
    retryCounts: file.retry_counts || {},
  };
}

/**
 * Re-run the pipeline for one stuck file, starting at the stage that
 * actually needs redoing (see triageReasons.retryPlanFor).
 *
 * WHY THIS NO LONGER LOOPS FOREVER
 *
 * The old version enqueued the stage and stopped. If the stage failed the
 * same way again the file came straight back with the same reason, and
 * nothing anywhere counted the attempts -- so "retry" could be pressed
 * indefinitely with no progress and no signal that there would not be any.
 *
 * pipelineState counts retries per stage and declares the file terminally
 * failed at the limit. This checks that first and refuses with an explanation
 * instead of queueing work whose outcome is already known.
 */
async function retry(fileId, actorUserId) {
  const row = await triageRepository.findOne(fileId, actorUserId);
  if (!row) {
    throw new NotFoundError(
      "This file is not in the triage queue -- it may have been picked up by a job, or already fixed."
    );
  }

  const plan = retryPlanFor(row);
  if (plan.blocked) throw new ValidationError(plan.blocked);

  const file = await fileRepository.findByIdForOwner(fileId, actorUserId);
  if (!pipelineState.canRetry(file, plan.jobType)) {
    const attempts = pipelineState.retriesFor(file, plan.jobType);
    throw new ValidationError(
      `"${file.filename_current}" has already been through ${plan.jobType.replace(/_/g, " ")} ` +
      `${attempts} times and failed the same way each time. Re-running it again will not produce a ` +
      "different result -- file it manually, rename it yourself, or archive it."
    );
  }

  await pipelineState.markRetrying(fileId, plan.jobType);

  const job = await enqueueJob(plan.jobType, plan.payload, {
    storageLocationId: row.storage_location_id,
    createdBy: actorUserId,
    ownerUserId: actorUserId,
  });

  await auditLogRepository.record({
    userId: actorUserId,
    action: "triage.retried",
    entityType: "file",
    entityId: fileId,
    previousState: { reason: row.reason, textQuality: row.text_quality, lastJobStatus: row.last_job_status },
    newState: { jobType: plan.jobType, processingJobId: job.id, attempt: pipelineState.retriesFor(file, plan.jobType) + 1 },
    reason: `Retried from the triage queue (${REASONS[row.reason].label}); re-ran ${plan.jobType}.`,
  });

  return { retried: true, fileId, reason: row.reason, jobType: plan.jobType, jobId: job.id };
}

/**
 * File a triaged document under a folder.
 *
 * Delegates to the one move implementation, so this gets the duplicate guard,
 * the ownership check and the placement provenance for free -- and cannot
 * drift from what the Files page does.
 */
async function moveToSubject(fileId, { subjectId, confirmDuplicate = false, note = null }, actorUserId) {
  if (!subjectId) throw new ValidationError("Choose a folder to file this under.");
  return fileOrganizeService.moveToSubject({
    fileId, subjectId, ownerUserId: actorUserId,
    source: fileOrganizeService.PlacementSource.USER,
    note, confirmDuplicate,
  });
}

/** Rename, via the same path the Files page uses. */
async function rename(fileId, filename, actorUserId) {
  const result = await fileService.updateFile(fileId, { filename }, actorUserId);
  await pipelineState.markUserResolved(fileId, "renamed");
  return result;
}

/**
 * "The name it already has is the right one."
 *
 * The counterpart to rejecting a rename proposal, available directly from
 * triage for files that never got a proposal at all -- an unreadable scan
 * produces no suggestion, so there is nothing to reject, and yet the user's
 * decision is exactly the same one. Recording it is what takes the file out
 * of the queue: without it the file keeps matching "could not be named"
 * forever, because it is still true and always will be.
 */
async function keepOriginalName(fileId, actorUserId) {
  const file = await fileRepository.findByIdForOwner(fileId, actorUserId);
  if (!file) throw new NotFoundError("File not found.");

  // Any outstanding suggestion is declined by this, so the user is not asked
  // the same question twice on two different pages.
  const cancelled = await renameProposalRepository.rejectPendingForFile(fileId, actorUserId);
  await pipelineState.markUserResolved(fileId, "kept_name");

  await auditLogRepository.record({
    userId: actorUserId,
    action: "file.original_name_kept",
    entityType: "file",
    entityId: fileId,
    newState: { filename: file.filename_current, rejectedProposals: cancelled.length },
    reason:
      "The user confirmed the file's existing name is correct. This SETTLES the file -- it is not " +
      "an unfinished state and not a failure, and the file continues to its destination normally.",
  });

  return { kept: true, fileId, filename: file.filename_current, rejectedProposals: cancelled.length };
}

/** Withdraw a file from the working set without deleting anything on disk. */
async function archive(fileId, actorUserId) {
  const file = await fileRepository.findByIdForOwner(fileId, actorUserId);
  if (!file) throw new NotFoundError("File not found.");

  await fileRepository.updateStatus(fileId, FileStatus.ARCHIVED);
  await pipelineState.markUserResolved(fileId, "archived", { state: pipelineState.State.ARCHIVED });

  await auditLogRepository.record({
    userId: actorUserId,
    action: "file.archived",
    entityType: "file",
    entityId: fileId,
    previousState: { status: file.status },
    newState: { status: FileStatus.ARCHIVED },
    reason: "Archived from the triage queue. The file on disk is untouched.",
  });

  return { archived: true, fileId };
}

/** Run the duplicate check on demand, without moving anything. */
async function checkDuplicates(fileId, ownerUserId) {
  const file = await fileRepository.findByIdForOwner(fileId, ownerUserId);
  if (!file) throw new NotFoundError("File not found.");
  return duplicateGuard.check(fileId, ownerUserId);
}


/**
 * File several triaged documents at once.
 *
 * Same single implementation as everywhere else, so the duplicate guard, the
 * ownership check and the audit entry all apply per file.
 */
async function moveMany(fileIds, subjectId, actorUserId, { confirmDuplicates = false } = {}) {
  if (!subjectId) throw new ValidationError("Choose a folder to file these under.");
  return fileOrganizeService.moveManyToSubject({
    fileIds, subjectId, ownerUserId: actorUserId,
    source: fileOrganizeService.PlacementSource.USER,
    confirmDuplicates,
  });
}

/**
 * Remove a triaged file from the working set.
 *
 * Delegates to fileService.removeFile, which marks it deleted and cancels any
 * pending rename proposal. Nothing is erased from disk -- the same promise the
 * rest of the application makes.
 */
async function remove(fileId, actorUserId) {
  const fileService = require("./fileService");
  return fileService.removeFile(fileId, actorUserId);
}

async function removeMany(fileIds, actorUserId) {
  requireOwner(actorUserId, "triageService.removeMany");
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    throw new ValidationError("Select at least one file.");
  }
  const fileService = require("./fileService");
  const removed = [];
  const failed = [];
  for (const fileId of fileIds) {
    try { await fileService.removeFile(fileId, actorUserId); removed.push(fileId); }
    catch (err) { failed.push({ fileId, message: err.publicMessage || err.message }); }
  }
  return { removed: removed.length, failed };
}

module.exports = {
  NotFoundError,
  list, summary, inspect, retry,
  moveToSubject, moveMany, rename, keepOriginalName, archive, checkDuplicates,
  remove, removeMany,
  actionsFor,
};
