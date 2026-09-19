const subjectService = require("../services/subjectService");
const unfiledOrganizer = require("../services/unfiledOrganizer");
const { enqueueJob } = require("../queues");
const { JobType } = require("../models/enums");

async function list(req, res) {
  res.json(await subjectService.list(req.query, req.user.id));
}

async function countDocumentsForSubject(req, res) {
  res.json(await subjectService.countDocumentsForSubject(req.params.id, req.query, req.user.id));
}

async function documentsForSubject(req, res) {
  res.json(await subjectService.getDocumentsForSubject(req.params.id, req.query, req.user.id));
}

/** Folders this user filed into most recently -- the picker's shortlist. */
async function recentDestinations(req, res) {
  res.json(await subjectService.listRecentDestinations(req.user.id));
}

/**
 * `origin` is deliberately NOT taken from the request body.
 *
 * It records who decided a folder should exist, and the whole point of
 * recording that is to distinguish a human's structure from a model's
 * suggestion. A client that could set it could label its own creations as
 * anything, which makes the badge meaningless. Folders created here are
 * 'user' by definition -- a person clicked the button. The assistant's
 * accepted suggestions go through triageService, which passes 'ai' from
 * server-side context.
 */
async function create(req, res) {
  const { parentId, name, description } = req.body || {};
  const subject = await subjectService.create(
    { parentId, name, description, origin: "user" },
    req.user.id
  );
  res.status(201).json(subject);
}

async function update(req, res) {
  const { name, description } = req.body || {};
  res.json(await subjectService.update(req.params.id, { name, description }, req.user.id));
}

/**
 * What deleting this folder would take with it, so the confirmation can name
 * the consequences instead of asking "are you sure?" about an unknown amount.
 */
/**
 * Move a folder under a different parent. Separate from PATCH /:id, which is
 * rename/describe only -- reparenting rewrites the whole branch's paths and is
 * a structurally different operation.
 */
async function moveToParent(req, res) {
  const { parentId } = req.body || {};
  res.json(await subjectService.moveToParent(req.params.id, parentId || null, req.user.id));
}

async function removalPreview(req, res) {
  res.json(await subjectService.previewRemoval(req.params.id, req.user.id));
}

/**
 * `?force=true` is the user having seen the preview and said yes. Without it
 * a folder holding documents or subfolders is refused with a message naming
 * both -- confirmation, not prohibition.
 */
async function remove(req, res) {
  res.json(
    await subjectService.remove(req.params.id, req.user.id, {
      force: String(req.query.force || "").toLowerCase() === "true",
      // "unfile" (default) or "trash". The documents are never destroyed by a
      // folder delete -- the worst it does is put them somewhere recoverable.
      contents: String(req.query.contents || "unfile").toLowerCase() === "trash" ? "trash" : "unfile",
    })
  );
}

// importFile is gone along with folderImportService -- it copied file bytes
// into the managed upload folder. See routes/storageLocationRoutes.js.

/**
 * How big the unfiled pile is, and whether anything can be done about it.
 *
 * Read-only, and cheap, so the Library can show the state before offering the
 * action -- an "Organize" button that turns out to have nothing to organize,
 * or no API key behind it, is worse than no button.
 */
async function unfiledSummary(req, res) {
  res.json(await unfiledOrganizer.unfiledSummary(req.user.id));
}

/**
 * Let the assistant file the unfiled pile, creating folders where the archive
 * has none that fit.
 *
 * Queued rather than run inline: a full pass is dozens of planning calls and
 * many minutes (see migrations/043). `batch: true` runs a SINGLE batch inline
 * instead, which is what makes the feature demonstrable -- a person can press
 * it once, watch ~120 files get filed, and see which folders were invented
 * before handing it the whole backlog.
 */
async function organizeUnfiled(req, res) {
  const { batch = false } = req.body || {};

  if (batch) {
    const result = await unfiledOrganizer.organizeUnfiled(req.user.id);
    return res.json({ mode: "batch", ...result });
  }

  const job = await enqueueJob(
    JobType.ORGANIZE_UNFILED,
    { ownerUserId: req.user.id, actorUserId: req.user.id },
    { createdBy: req.user.id, ownerUserId: req.user.id }
  );
  return res.status(202).json({ mode: "job", jobId: job.id });
}

module.exports = {
  list, documentsForSubject, countDocumentsForSubject, recentDestinations,
  create, update, remove, removalPreview, moveToParent,
  unfiledSummary, organizeUnfiled,
};
