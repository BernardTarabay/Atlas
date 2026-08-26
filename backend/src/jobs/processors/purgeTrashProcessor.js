// Emptying the Trash, on a timer.
//
// WHAT MAKES THIS SAFE ENOUGH TO RUN UNATTENDED
//
// It is the only thing in this application that removes rows for good, and it
// does so with nobody watching. Three properties earn it that:
//
//   1. It selects on elapsed time alone. Not on a filter, not on anything a
//      request supplied -- only "has this been in the Trash longer than the
//      retention window". There is no input to get wrong.
//   2. The window IS the confirmation. A user putting something in the Trash
//      has been told it will be removed after N days, and has that whole period
//      to change their mind. Nothing is destroyed that was not both chosen and
//      then left alone for a month.
//   3. It never touches your disk. Purging removes Atlas's record of a file.
//      The file itself is untouched -- this application never deletes the
//      originals it indexes -- so a purged file that still exists on disk is
//      simply re-imported by the next scan, which is correct: it is still
//      there, and this is a catalogue of what is there.
//
// Deliberately batched and re-queued rather than looping until empty: an
// unbounded delete on a repository that has been accumulating for months is a
// long transaction holding locks against live work.
const lifecycleService = require("../../services/lifecycleService");
const auditLogRepository = require("../../repositories/auditLogRepository");
const db = require("../../config/database");
const env = require("../../config/env");

const BATCH_SIZE = 500;

async function handle(payload = {}) {
  // `??`, not `||`. A retention of 0 -- "empty the Trash now" -- is a
  // legitimate instruction, and `0 || 30` silently turns it into the default,
  // so the one value that means "purge everything" was the one value that
  // could never be passed.
  const retentionDays = payload.retentionDays ?? env.trash.retentionDays;
  // One owner per job (trashPurgeScheduler). The purge deletes rows for good,
  // so the blast radius is bounded to a single account by construction rather
  // than by the WHERE clause happening to be right.
  const { ownerUserId } = payload;
  const expired = await lifecycleService.findExpired({ retentionDays, limit: BATCH_SIZE, ownerUserId });

  if (expired.length === 0) {
    return { purged: 0, retentionDays, message: "Nothing in the Trash is old enough to remove." };
  }

  // One audit entry per file, written BEFORE the row goes: entity_id will
  // point at something that no longer exists, and this record is the only
  // remaining evidence the document was ever catalogued.
  for (const file of expired) {
    await auditLogRepository.record({
      userId: null,
      action: "file.purged",
      entityType: "file",
      entityId: file.id,
      previousState: { filename: file.filename_current, deletedAt: file.deleted_at },
      reason:
        `Removed from the Trash automatically after ${retentionDays} days. ` +
        "The original file on disk was not touched.",
    });
  }

  const ids = expired.map((f) => f.id);
  // The owner is re-asserted in the DELETE even though findExpired already
  // scoped the SELECT.
  //
  // Not redundancy to be tidied away: this is the only statement in the
  // application that destroys rows with nobody watching, so it should not be
  // possible for a future change to findExpired -- or a caller that passes ids
  // from somewhere else -- to turn it into a cross-account delete. The same
  // reasoning the agent path checks use (docs/04 §4.5): the destructive step
  // validates for itself rather than trusting its caller got it right.
  const { rowCount } = await db.query(
    "DELETE FROM files WHERE id = ANY($1::uuid[]) AND owner_user_id = $2",
    [ids, ownerUserId]
  );
  if (rowCount !== ids.length) {
    // Surfaces as a failed job rather than a quiet miscount, because the only
    // ways this happens are a scoping bug or a concurrent write, and both are
    // worth knowing about on an unattended delete.
    throw new Error(
      `Purge selected ${ids.length} file(s) but deleted ${rowCount}. Refusing to report a purge that did not happen as described.`
    );
  }

  return {
    purged: ids.length,
    retentionDays,
    // Told rather than inferred, so a scheduler can decide to run again
    // immediately instead of waiting a day to clear a backlog.
    more: expired.length === BATCH_SIZE,
  };
}

module.exports = { handle, BATCH_SIZE };
