const express = require("express");
const controller = require("../controllers/fileController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate);

router.get("/", requirePermission("document.view"), asyncHandler(controller.list));
// Both registered before "/:id", or the literal path segment is read as a
// file id and answered with "Malformed id" from the Postgres uuid cast.
// (That is not hypothetical -- the Subjects map was calling a
// never-registered GET /files/search and silently swallowing the 400.)
router.get("/count", requirePermission("document.view"), asyncHandler(controller.count));
router.get("/filter-options", requirePermission("document.view"), asyncHandler(controller.filterOptions));
// Ids only, for "select all N". Before "/:id" like its neighbours.
router.get("/ids", requirePermission("document.view"), asyncHandler(controller.matchingIds));
router.delete("/remove-all", requirePermission("document.delete"), asyncHandler(controller.removeAll));
// Read-only similarity check between any two files. Registered before
// "/:id" so "compare" is never swallowed as a file id. Only reveals how
// alike two files the user can already view are, so document.view is the
// right bar.
router.post("/compare", requirePermission("document.view"), asyncHandler(controller.compare));
// Filing a selection under a subject, from the Library. Registered before
// "/:id" for the same reason as the routes above. `document.move` matches
// POST /photos/move and POST /triage/move, which reach the identical
// operation (fileOrganizeService.moveManyToSubject) from a different list --
// the same action must not need a different permission depending on which
// page you happened to start from.
router.post("/move", requirePermission("document.move"), asyncHandler(controller.moveMany));
// The same operation, reached by criteria instead of by a list of ids. Same
// permission for the same reason: it is the identical act of filing, and which
// page you started from must not change what you are allowed to do. Registered
// before "/:id" like its neighbours.
router.post("/move-by-filter", requirePermission("document.move"), asyncHandler(controller.moveByFilter));
// --- Archive and Trash ---------------------------------------------------
//
// Before "/:id" like every other literal segment here, or "lifecycle" would be
// read as a file id and fail the uuid cast.
//
// Moving something to Archive or Trash needs document.delete, not
// document.move: filing a document somewhere and putting it away are different
// acts, and the second is the one that makes it disappear from every listing.
// EVERY LITERAL SEGMENT COMES BEFORE ":destination", not just before "/:id".
//
// Got this wrong once already: with POST "/lifecycle/:destination" registered
// first, POST "/lifecycle/purge" was matched by it and answered
// `Unknown destination "purge"` -- the irreversible route was unreachable and
// failed as a validation error, which looks like a bad request rather than a
// missing route. Same rule as "/compare" and "/move" above.
router.get("/lifecycle/summary", requirePermission("document.view"), asyncHandler(controller.lifecycleSummary));
router.post("/lifecycle/restore", requirePermission("document.move"), asyncHandler(controller.lifecycleRestore));
// The only irreversible route in the application. Two-step: see the controller.
router.post("/lifecycle/purge", requirePermission("document.delete"), asyncHandler(controller.lifecyclePurge));
router.get("/lifecycle/:destination", requirePermission("document.view"), asyncHandler(controller.lifecycleList));
router.post("/lifecycle/:destination", requirePermission("document.delete"), asyncHandler(controller.lifecycleMove));

// The organized shortcut folder. Literal segments before "/:id", same rule as
// "/lifecycle" and "/compare" above, or "mirror" is read as a file id and
// fails the uuid cast.
//
// scan.run rather than a new permission: rebuilding the mirror is the same
// kind of act as triggering a scan -- a long job over the whole archive,
// started by a person -- and a permission key that no seed grants would 403
// for everybody until a migration caught up.
router.get("/mirror/status", requirePermission("document.view"), asyncHandler(controller.mirrorStatus));
router.post("/mirror/sync", requirePermission("scan.run"), asyncHandler(controller.mirrorSync));

router.get("/:id", requirePermission("document.view"), asyncHandler(controller.getOne));
router.get("/:id/download", requirePermission("document.download"), asyncHandler(controller.download));
// Preview streams the same bytes as download (mime-whitelisted, inline) --
// same permission bar as download since it exposes the same content.
router.get("/:id/preview", requirePermission("document.download"), asyncHandler(controller.preview));
// Field-level permission checks (document.rename / classification.modify)
// happen inside the controller, since which permission applies depends on
// which fields are actually present in the request body.
router.patch("/:id", requirePermission("document.view"), asyncHandler(controller.update));
// Same permission bar as download -- this never sends bytes over the
// network at all, it just spawns the host OS's file manager, so it isn't
// more sensitive than download, only more environment-dependent (see
// fileService.revealInFileManager).
router.post("/:id/reveal", requirePermission("document.download"), asyncHandler(controller.reveal));
// Opens the file itself in the host's default application, rather than its
// folder. Same permission bar, same "only meaningful on the server's own
// desktop" caveat -- see fileService.openOnHost.
router.post("/:id/open", requirePermission("document.download"), asyncHandler(controller.openLocally));
router.delete("/:id", requirePermission("document.delete"), asyncHandler(controller.remove));

module.exports = router;
