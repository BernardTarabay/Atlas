// Archive and Trash -- the two destinations that are not folders.
//
// WHAT THEY ARE
//
//   Archive   "I do not want to see this, but I am not throwing it away."
//             Hidden from every listing, count and search. Kept forever.
//             Reversible at any time, with nothing scheduled against it.
//
//   Trash     "Throw this away." Hidden the same way, and REMOVED FROM THE
//             DATABASE after a retention window (env.trash.retentionDays).
//             Reversible until that window closes, and not afterwards.
//
// They look like folders in the tree because that is the shape of the gesture
// people already have -- drag a thing onto a place -- but they are statuses,
// not subjects. The reasoning is in migration 037: a subject says what a
// document is ABOUT, and these say where it is in its LIFE. Modelling them as
// folders would mean every listing query in the application growing an "...and
// not filed under Trash" clause, and every query that forgot showing deleted
// documents as live ones.
//
// WHAT "PERMANENTLY DELETE" DOES AND DOES NOT MEAN
//
// It removes Atlas's ROW. It does not touch the bytes on your disk -- this
// application never moves or deletes the originals it indexes, and a purge is
// no exception. A purged file that still exists on disk will be re-imported by
// the next scan of its storage location, which is correct: the file is still
// there, and Atlas is a catalogue of what is there.
const db = require("../config/database");
const fileRepository = require("../repositories/fileRepository");
const subjectRepository = require("../repositories/subjectRepository");
const renameProposalRepository = require("../repositories/renameProposalRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { requireOwner } = require("../repositories/ownership");
const { ValidationError } = require("../validators/validationError");
const { parsePagination } = require("../utils/pagination");
const { FileStatus } = require("../models/enums");
const env = require("../config/env");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

/** The two destinations, as the API and the UI name them. */
const DESTINATIONS = Object.freeze({ ARCHIVE: "archive", TRASH: "trash" });

const STATUS_FOR = Object.freeze({
  [DESTINATIONS.ARCHIVE]: FileStatus.ARCHIVED,
  [DESTINATIONS.TRASH]: FileStatus.DELETED,
});

function parseDestination(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!Object.values(DESTINATIONS).includes(key)) {
    throw new ValidationError(`Unknown destination "${value}". Use "archive" or "trash".`);
  }
  return key;
}

/**
 * Send files to Archive or Trash.
 *
 * Both directions go through one function because they differ only in which
 * status is written and which timestamp is stamped. Keeping them apart would
 * be two implementations of "move a batch of files the user selected", which
 * is the failure fileOrganizeService's header warns about.
 *
 * Pending rename proposals are cancelled on the way out for both: a proposal
 * asks "should this file be renamed?", and a file the user has just put away
 * is not a question they want asked again.
 */
async function moveFiles(fileIds, destination, actorUserId) {
  requireOwner(actorUserId, "lifecycleService.moveFiles");
  const dest = parseDestination(destination);
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    throw new ValidationError("Select at least one file.");
  }

  const owned = await fileRepository.listByIdsForOwner(fileIds, actorUserId);
  const ownedIds = new Set(owned.map((f) => f.id));
  const result = { moved: [], notFound: [], destination: dest };

  for (const fileId of fileIds) {
    if (!ownedIds.has(fileId)) { result.notFound.push(fileId); continue; }
    const file = owned.find((f) => f.id === fileId);

    await db.query(
      // $2 is cast on every use: without it Postgres sees the same parameter
      // as file_status in the assignment and as text in the comparisons, and
      // refuses with "inconsistent types deduced for parameter $2".
      `UPDATE files
          SET status = $2::file_status,
              deleted_at  = CASE WHEN $2::file_status = 'deleted'  THEN now() ELSE NULL END,
              archived_at = CASE WHEN $2::file_status = 'archived' THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $1 AND owner_user_id = $3`,
      [fileId, STATUS_FOR[dest], actorUserId]
    );
    await renameProposalRepository.cancelPendingForFile(fileId, actorUserId).catch(() => {});

    await auditLogRepository.record({
      userId: actorUserId,
      action: dest === DESTINATIONS.TRASH ? "file.trashed" : "file.archived",
      entityType: "file",
      entityId: fileId,
      previousState: { status: file.status },
      newState: { status: STATUS_FOR[dest] },
      reason: dest === DESTINATIONS.TRASH
        ? `Moved to Trash; removed permanently after ${env.trash.retentionDays} days unless restored`
        : "Moved to Archive; hidden from listings until restored",
    });
    result.moved.push(fileId);
  }

  return result;
}

/**
 * Bring files back out of Archive or Trash.
 *
 * They return to `active` and to whatever folder they were filed under -- the
 * classification rows were never touched, so restoring is genuinely putting a
 * thing back rather than reconstructing it. A file whose folder was deleted in
 * the meantime comes back unfiled, which is the same answer as anywhere else.
 */
async function restoreFiles(fileIds, actorUserId) {
  requireOwner(actorUserId, "lifecycleService.restoreFiles");
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    throw new ValidationError("Select at least one file.");
  }

  const owned = await fileRepository.listByIdsForOwner(fileIds, actorUserId);
  const result = { restored: [], notFound: [] };

  for (const fileId of fileIds) {
    const file = owned.find((f) => f.id === fileId);
    if (!file) { result.notFound.push(fileId); continue; }

    await db.query(
      `UPDATE files SET status = 'active', deleted_at = NULL, archived_at = NULL, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [fileId, actorUserId]
    );
    await auditLogRepository.record({
      userId: actorUserId,
      action: "file.restored",
      entityType: "file",
      entityId: fileId,
      previousState: { status: file.status },
      newState: { status: FileStatus.ACTIVE },
      reason: `Restored from ${file.status === FileStatus.DELETED ? "Trash" : "Archive"}`,
    });
    result.restored.push(fileId);
  }

  return result;
}

/**
 * Remove rows for good.
 *
 * The only operation here that cannot be undone, which is why nothing calls it
 * without an explicit, separately-confirmed instruction -- see the two-step
 * confirmation on the controller, and `purgeExpired` below, where the delay
 * IS the confirmation.
 *
 * Deliberately scoped to files already in Trash. "Permanently delete" applied
 * to a live file would be a one-click unrecoverable action on something the
 * user has not even put away yet; making Trash the only route means every
 * permanent deletion has a reversible step in front of it.
 */
async function purgeFiles(fileIds, actorUserId) {
  requireOwner(actorUserId, "lifecycleService.purgeFiles");
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    throw new ValidationError("Select at least one file.");
  }

  const { rows } = await db.query(
    `SELECT id, filename_current FROM files
      WHERE id = ANY($1::uuid[]) AND owner_user_id = $2 AND status = 'deleted'`,
    [fileIds, actorUserId]
  );
  if (rows.length === 0) {
    throw new ValidationError("Nothing to delete -- these files are not in the Trash.");
  }

  const ids = rows.map((r) => r.id);
  // The audit entry is written BEFORE the row disappears: entity_id points at
  // a file that will not exist a moment later, and that record is the only
  // remaining evidence the document was ever here.
  for (const row of rows) {
    await auditLogRepository.record({
      userId: actorUserId,
      action: "file.purged",
      entityType: "file",
      entityId: row.id,
      previousState: { filename: row.filename_current },
      reason: "Permanently removed from the Trash. The original file on disk was not touched.",
    });
  }

  await db.query("DELETE FROM files WHERE id = ANY($1::uuid[]) AND owner_user_id = $2", [ids, actorUserId]);
  return { purged: ids.length, fileIds: ids };
}

/**
 * Everything whose retention window has closed, across all accounts.
 *
 * Run on a schedule (jobs/processors/purgeTrashProcessor.js). Owner-scoped
 * queries are the rule everywhere else in this codebase; this one is
 * deliberately not, because it is not answering a user's question -- it is
 * housekeeping that has to cover every account, and it selects strictly on
 * elapsed time rather than on anything a request supplied.
 */
async function findExpired({ retentionDays = env.trash.retentionDays, limit = 500, ownerUserId } = {}) {
  // Scoped like every other read of user-owned rows.
  //
  // This used to take no owner and select across every account, which is
  // precisely what `requireOwner` exists to prevent -- and the reason the
  // nightly purge never ran: enqueueJob could not resolve an owner for a
  // `purge_trash` job, processingJobs.create refused it, and the failure went
  // into a log nobody read. The Trash had therefore never been emptied.
  //
  // The fix is to scope the purge rather than exempt it: one job per owner,
  // each one visible on that owner's Jobs page, each one deleting only their
  // rows. See findOwnersWithExpired below for the one query that is allowed to
  // look across accounts, and why.
  requireOwner(ownerUserId, "lifecycleService.findExpired");
  const { rows } = await db.query(
    `SELECT id, owner_user_id, filename_current, deleted_at
       FROM files
      WHERE status = 'deleted'
        AND deleted_at IS NOT NULL
        AND deleted_at < now() - ($1 || ' days')::interval
        AND owner_user_id = $3
      ORDER BY deleted_at ASC
      LIMIT $2`,
    [String(retentionDays), limit, ownerUserId]
  );
  return rows;
}

/**
 * Whose Trash has something old enough to remove.
 *
 * THE ONE DELIBERATELY CROSS-ACCOUNT READ IN THIS FILE.
 *
 * A scheduler running on a timer has no user attached -- it is nobody's
 * request -- so something has to answer "for whom should a purge be queued?"
 * before per-owner scoping can begin. That question cannot itself be scoped.
 *
 * It is made safe by returning ids and nothing else: no filenames, no paths,
 * no counts that would reveal one account's contents to another. Every actual
 * row this leads to is then read back through findExpired, which does require
 * an owner.
 */
async function findOwnersWithExpired({ retentionDays = env.trash.retentionDays } = {}) {
  const { rows } = await db.query(
    `SELECT DISTINCT owner_user_id
       FROM files
      WHERE status = 'deleted'
        AND deleted_at IS NOT NULL
        AND deleted_at < now() - ($1 || ' days')::interval
        AND owner_user_id IS NOT NULL`,
    [String(retentionDays)]
  );
  return rows.map((r) => r.owner_user_id);
}

/**
 * The contents of Archive or Trash, with the pagination the listing needs.
 *
 * Trash rows carry `days_left`, which is the only number that matters in that
 * view: a Trash you cannot see the deadline in is just a folder you forgot
 * about, and the promise the retention window makes is worthless if it is
 * invisible until the day it fires.
 */
async function listDestination(destination, query = {}, ownerUserId) {
  requireOwner(ownerUserId, "lifecycleService.listDestination");
  const dest = parseDestination(destination);
  const { limit, offset } = parsePagination(query);

  const [files, total] = await Promise.all([
    fileRepository.listByLifecycle(STATUS_FOR[dest], ownerUserId, {
      limit, offset, retentionDays: env.trash.retentionDays,
    }),
    fileRepository.countByLifecycle(STATUS_FOR[dest], ownerUserId),
  ]);

  return { destination: dest, files, total, retentionDays: env.trash.retentionDays };
}

/** How much is waiting, and how long the oldest has left. */
async function summary(ownerUserId) {
  requireOwner(ownerUserId, "lifecycleService.summary");
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE status = 'archived')::int AS archived,
       count(*) FILTER (WHERE status = 'deleted')::int  AS trashed,
       min(deleted_at) FILTER (WHERE status = 'deleted') AS oldest_deleted_at
     FROM files WHERE owner_user_id = $1`,
    [ownerUserId]
  );
  const row = rows[0] || {};
  return {
    archived: row.archived || 0,
    trashed: row.trashed || 0,
    retentionDays: env.trash.retentionDays,
    oldestDeletedAt: row.oldest_deleted_at || null,
  };
}

// --- folders ---------------------------------------------------------------

/**
 * Hide a folder and everything under it, or bring it back.
 *
 * Archiving a folder does NOT archive its files. That sounds like a gap and is
 * the point: a folder is a view onto documents, and hiding the view should not
 * change what the documents are. The files stay active, stay searchable, and
 * stay findable by every other route -- they simply stop appearing in a branch
 * the user has put away. Cascading to the files would make "hide this old
 * project" quietly remove hundreds of documents from search, which is a very
 * different thing from what was asked.
 */
async function setSubjectArchived(subjectId, archived, actorUserId) {
  requireOwner(actorUserId, "lifecycleService.setSubjectArchived");
  const subject = await subjectRepository.findByIdForOwner(subjectId, actorUserId);
  if (!subject) throw new NotFoundError("Folder not found.");

  const { rows } = await db.query(
    `UPDATE subjects SET archived_at = $2, updated_at = now()
      WHERE id = $1 AND owner_user_id = $3 RETURNING *`,
    [subjectId, archived ? new Date() : null, actorUserId]
  );

  await auditLogRepository.record({
    userId: actorUserId,
    action: archived ? "subject.archived" : "subject.unarchived",
    entityType: "subject",
    entityId: subjectId,
    previousState: { archivedAt: subject.archived_at },
    newState: { archivedAt: rows[0]?.archived_at || null },
    reason: archived
      ? `Archived "${subject.name}" -- hidden from the tree, documents inside are untouched`
      : `Restored "${subject.name}" to the tree`,
  });

  return rows[0] || null;
}

module.exports = {
  NotFoundError,
  DESTINATIONS,
  STATUS_FOR,
  parseDestination,
  listDestination,
  moveFiles,
  restoreFiles,
  purgeFiles,
  findExpired,
  findOwnersWithExpired,
  summary,
  setSubjectArchived,
};
