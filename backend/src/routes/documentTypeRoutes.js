const express = require("express");
const controller = require("../controllers/documentTypeController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate, requirePermission("document.view"));

router.get("/", asyncHandler(controller.list));

module.exports = router;
