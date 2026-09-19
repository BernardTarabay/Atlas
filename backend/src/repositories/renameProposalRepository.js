// Intelligent naming, human-reviewed (spec §10). Never blindly applied.
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");
const { requireOwner } = require("./ownership");

const base = createBaseRepository("rename_proposals");

// A proposal has no owner column of its own -- it belongs to whoever owns the
// file it is about. Denormalising an owner onto it would be a second copy of
// a fact that cannot change independently, and one more thing to keep in
// sync; this EXISTS is cheap because files.id is the primary key.
const OWNED_BY = (n) => `EXISTS (
  SELECT 1 FROM files f WHERE f.id = rename_proposals.file_id AND f.owner_user_id = $${n}
)`;

// Each of these takes an optional `client` so a caller can run it inside a
// transaction (see config/database.withTransaction). Default stays `db`, so
// every existing call site behaves exactly as before.
async function create({
  fileId, currentFilename, proposedFilename, proposedRelativeDir = null,
  reason, metadataUsed = {}, confidenceLevel, confidenceScore = null, client = null,
}) {
  const exec = client || db;
  const { rows } = await exec.query(
    `INSERT INTO rename_proposals (
       file_id, current_filename, proposed_filename, proposed_relative_dir,
       reason, metadata_used, confidence_level, confidence_score
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [fileId, currentFilename, proposedFilename, proposedRelativeDir, reason, metadataUsed, confidenceLevel, confidenceScore]
  );
  return rows[0];
}

async function listPending(ownerUserId, { limit = 50, offset = 0 } = {}) {
  requireOwner(ownerUserId, "renameProposals.listPending");
  const { rows } = await db.query(
    `SELECT * FROM rename_proposals
      WHERE status = 'pending' AND ${OWNED_BY(3)}
      ORDER BY confidence_score DESC NULLS LAST, created_at ASC LIMIT $1 OFFSET $2`,
    [limit, offset, ownerUserId]
  );
  return rows;
}

/** Every proposal ever made for one file, newest first. */
async function listForFile(fileId) {
  const { rows } = await db.query(
    "SELECT * FROM rename_proposals WHERE file_id = $1 ORDER BY created_at DESC",
    [fileId]
  );
  return rows;
}

/**
 * Decline every outstanding suggestion for one file.
 *
 * Distinct from cancelPendingForFile only in intent, and the distinction is
 * worth keeping in the name: cancelling happens because the FILE went away,
 * this happens because the user said the name it already has is right. Both
 * land on 'rejected', which findRejectedMatch then uses to avoid re-proposing
 * the same name for the same content later.
 */
async function rejectPendingForFile(fileId, reviewedBy) {
  const { rows } = await db.query(
    `UPDATE rename_proposals SET status = 'rejected', reviewed_by = $2, reviewed_at = now()
      WHERE file_id = $1 AND status = 'pending' RETURNING id`,
    [fileId, reviewedBy]
  );
  return rows.map((r) => r.id);
}

/** One proposal, only if the caller owns the file it describes. */
async function findByIdForOwner(id, ownerUserId) {
  requireOwner(ownerUserId, "renameProposals.findByIdForOwner");
  const { rows } = await db.query(
    `SELECT * FROM rename_proposals WHERE id = $1 AND ${OWNED_BY(2)}`,
    [id, ownerUserId]
  );
  return rows[0] || null;
}

/**
 * Filtered list for the approved/rejected/applied tabs. NOTE: this replaces
 * a bug where those tabs called the generic base.list() (no WHERE clause at
 * all), so every tab showed every proposal regardless of status.
 */
async function listByStatus(status, ownerUserId, { limit = 50, offset = 0 } = {}) {
  requireOwner(ownerUserId, "renameProposals.listByStatus");
  const { rows } = await db.query(
    `SELECT * FROM rename_proposals
      WHERE status = $1 AND ${OWNED_BY(4)}
      ORDER BY reviewed_at DESC NULLS LAST, created_at DESC LIMIT $2 OFFSET $3`,
    [status, limit, offset, ownerUserId]
  );
  return rows;
}

async function review(id, { status, reviewedBy, client = null }) {
  const exec = client || db;
  const { rows } = await exec.query(
    `UPDATE rename_proposals SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1 RETURNING *`,
    [id, status, reviewedBy]
  );
  return rows[0] || null;
}

async function markApplied(id, client = null) {
  const exec = client || db;
  const { rows } = await exec.query(
    `UPDATE rename_proposals SET status = 'applied', applied_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}


/**
 * Bug fix: generateNamesProcessor used to create a brand-new pending
 * proposal on every rescan, even when a proposal proposing this EXACT
 * rename (and, now, move) had already been explicitly rejected for this
 * file. That made rejections meaningless the moment a file was re-touched
 * (re-uploaded, re-scanned, or just had its mtime bumped) -- the identical
 * suggestion would silently reappear in Pending. This looks for a prior
 * rejection of the same (file_id, proposed_filename, proposed_relative_dir)
 * combination so the caller can skip re-proposing it -- IS NOT DISTINCT
 * FROM (not plain =) because proposed_relative_dir is nullable and SQL
 * NULL = NULL is never true. A genuinely different name or target folder
 * (e.g. because the file's content or classification actually changed) is
 * unaffected and still gets proposed.
 */
async function findRejectedMatch(fileId, proposedFilename, proposedRelativeDir = null) {
  const { rows } = await db.query(
    `SELECT * FROM rename_proposals
     WHERE file_id = $1 AND proposed_filename = $2
       AND proposed_relative_dir IS NOT DISTINCT FROM $3
       AND status = 'rejected'
     ORDER BY reviewed_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [fileId, proposedFilename, proposedRelativeDir]
  );
  return rows[0] || null;
}

/**
 * Bug fix (real-world report): 40 files produced 78 pending proposals.
 * generateNamesProcessor had no check for "does this file already have a
 * pending proposal" before creating a new one -- anything that caused
 * generate_names to run twice for the same file (a queue retry after a
 * transient failure partway through the job, a duplicate enqueue, etc.)
 * just stacked a second identical-or-near-identical pending proposal on
 * top instead of recognizing one was already sitting there. There should
 * only ever be at most one pending proposal per file at a time -- this is
 * how the processor checks before inserting.
 */
async function findPendingForFile(fileId) {
  const { rows } = await db.query(
    "SELECT * FROM rename_proposals WHERE file_id = $1 AND status = 'pending'",
    [fileId]
  );
  return rows;
}

/**
 * Used when a File is removed (fileService.removeFile): any proposal still
 * sitting in 'pending' for a file the user just removed shouldn't linger
 * around waiting for review, and rejecting it here means findRejectedMatch
 * above correctly holds back an identical re-proposal if the same file
 * (same content) reappears later.
 */
async function cancelPendingForFile(fileId, reviewedBy) {
  const { rows } = await db.query(
    `UPDATE rename_proposals SET status = 'rejected', reviewed_by = $2, reviewed_at = now()
     WHERE file_id = $1 AND status = 'pending' RETURNING id`,
    [fileId, reviewedBy]
  );
  return rows.map((r) => r.id);
}

/** Cheap count for the sidebar's pending-proposals badge -- avoids pulling
 * every pending row across the wire just to show a number. */
/**
 * Pending proposals at or above a confidence score, newest first.
 *
 * Backs "approve everything above 90%" -- both the count shown before the
 * user commits and the approval itself, so the number they agreed to and
 * the set that gets approved come from the same query.
 */
async function listPendingAboveConfidence(minConfidence, ownerUserId, { limit = 1000 } = {}) {
  requireOwner(ownerUserId, "renameProposals.listPendingAboveConfidence");
  const { rows } = await db.query(
    `SELECT * FROM rename_proposals
     WHERE status = 'pending' AND confidence_score >= $1 AND ${OWNED_BY(3)}
     ORDER BY confidence_score DESC, created_at ASC
     LIMIT $2`,
    [minConfidence, limit, ownerUserId]
  );
  return rows;
}

/**
 * Pending proposals at or BELOW a confidence score, worst first.
 *
 * The mirror of listPendingAboveConfidence, and the other half of a usable
 * review queue. A scan over a real drive produces a long tail of proposals
 * the classifier had no real basis for -- scanned images, files whose only
 * text is a header, formats with no extractable content. At 0.0 confidence
 * they are noise, and clearing them one row at a time is what stops anyone
 * ever reaching the proposals that are actually worth a decision.
 */
async function listPendingBelowConfidence(maxConfidence, ownerUserId, { limit = 5000 } = {}) {
  requireOwner(ownerUserId, "renameProposals.listPendingBelowConfidence");
  const { rows } = await db.query(
    `SELECT * FROM rename_proposals
     WHERE status = 'pending' AND confidence_score <= $1 AND ${OWNED_BY(3)}
     ORDER BY confidence_score ASC, created_at ASC
     LIMIT $2`,
    [maxConfidence, limit, ownerUserId]
  );
  return rows;
}

/**
 * Reject them in ONE statement rather than a loop of single-row updates.
 * The threshold case is exactly the bulk case -- "clear the 3,000 useless
 * ones" -- and 3,000 round trips is both slow and half-failable.
 */
async function rejectPendingBelowConfidence(maxConfidence, reviewedBy) {
  // reviewedBy IS the owner here -- rejecting in bulk is only ever reachable
  // from a signed-in request, and it must never reach past that account.
  requireOwner(reviewedBy, "renameProposals.rejectPendingBelowConfidence");
  const { rows } = await db.query(
    `UPDATE rename_proposals
        SET status = 'rejected', reviewed_by = $2, reviewed_at = now()
      WHERE status = 'pending' AND confidence_score <= $1 AND ${OWNED_BY(2)}
      RETURNING id, file_id, confidence_score`,
    [maxConfidence, reviewedBy]
  );
  return rows;
}

async function countPending(ownerUserId) {
  requireOwner(ownerUserId, "renameProposals.countPending");
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count FROM rename_proposals
      WHERE status = 'pending' AND ${OWNED_BY(1)}`,
    [ownerUserId]
  );
  return rows[0].count;
}

module.exports = {
  ...base, create, listPending, listByStatus, listForFile, review, markApplied,
  findRejectedMatch, findPendingForFile, cancelPendingForFile, rejectPendingForFile,
  findByIdForOwner, countPending, listPendingAboveConfidence,
  listPendingBelowConfidence, rejectPendingBelowConfidence,
};