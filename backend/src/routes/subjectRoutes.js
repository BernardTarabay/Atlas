const express = require("express");
const controller = require("../controllers/subjectController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate, requirePermission("document.view"));

// POST /import is gone along with the other byte-upload routes. Like
// /storage-locations/upload, it copied file bytes into the managed upload
// folder -- see routes/storageLocationRoutes.js for why that whole approach
// was removed. Registering a folder indexes it in place instead, and the
// taxonomy is built from classification rather than from folder names.

router.get("/", asyncHandler(controller.list));
// Before "/:id/..." so the literal segment is never read as a subject id.
router.get("/recent", asyncHandler(controller.recentDestinations));
// Literal segments, before "/:id/..." -- or "unfiled" is read as a subject id.
router.get("/unfiled/summary", asyncHandler(controller.unfiledSummary));
// Creating folders IS a structural change to the taxonomy, so it sits behind
// the same permission as creating one by hand. That the author is the
// assistant does not lower the bar.
router.post("/unfiled/organize", requirePermission("subject.manage"), asyncHandler(controller.organizeUnfiled));
router.get("/:id/documents", asyncHandler(controller.documentsForSubject));
// The total for the list above, so a pager can say "of 62" rather than only
// "page 3". Separate request for the same reason GET /files/count is separate
// from GET /files -- the list returns a bare array several callers consume.
router.get("/:id/documents/count", asyncHandler(controller.countDocumentsForSubject));
// Structural taxonomy changes (create/rename/delete a Subject/Category/
// Subcategory) are gated behind subject.manage, distinct from
// classification.modify which only governs assigning an existing subject
// to a file (see fileController.update / PATCH /files/:id).
router.post("/", requirePermission("subject.manage"), asyncHandler(controller.create));
router.patch("/:id", requirePermission("subject.manage"), asyncHandler(controller.update));
// Drag-and-drop reparenting. PATCH /:id stays rename/describe only.
router.patch("/:id/parent", requirePermission("subject.manage"), asyncHandler(controller.moveToParent));
// What a delete would cost, before committing to it.
router.get("/:id/removal-preview", requirePermission("subject.manage"), asyncHandler(controller.removalPreview));
router.delete("/:id", requirePermission("subject.manage"), asyncHandler(controller.remove));

module.exports = router;
