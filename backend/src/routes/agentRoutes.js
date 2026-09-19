const express = require("express");
const controller = require("../controllers/agentController");
const { authenticate } = require("../middleware/authenticate");
const { authenticateAgent } = require("../middleware/authenticateAgent");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

/**
 * The one body in this API that carries file bytes.
 *
 * `read_file` returns the file base64-encoded inside the operation result
 * (desktop-agent/src/operations.js), so this endpoint's body is ~4/3 the size
 * of the file plus the JSON envelope. The general 1MB parser in app.js
 * deliberately skips this path and hands the decision here.
 *
 * SIZING: base64 is 4/3, JSON string-escaping adds a little more, and the
 * envelope is negligible. 280mb carries the agent's 200MB file ceiling
 * (AGENT_MAX_READ_BYTES) with room to spare. The two numbers must move
 * together -- a file cap above what this parser accepts produces a 413 that
 * looks like a server fault rather than a limit, which is exactly the failure
 * this pair of comments exists to prevent from recurring.
 */
const AGENT_RESULT_BODY_LIMIT = process.env.AGENT_RESULT_BODY_LIMIT || "280mb";
const agentResultJson = express.json({ limit: AGENT_RESULT_BODY_LIMIT });

// --- agent-facing -------------------------------------------------------
// Registered BEFORE the user `authenticate` middleware below, because an
// agent presents an agent token (different secret, no user identity) and
// would be rejected outright by it.

// Unauthenticated by necessity: this IS the authentication step, exchanging
// the long-lived API key for a short-lived session token. Rate-limited at
// the app level like the other credential-accepting route (/api/auth).
router.post("/session", asyncHandler(controller.openSession));

router.post("/heartbeat", authenticateAgent, asyncHandler(controller.heartbeat));
router.get("/operations", authenticateAgent, asyncHandler(controller.poll));
// ORDER IS THE SECURITY PROPERTY HERE: authenticateAgent reads a header and
// never touches the body, so it can and must run BEFORE the large parser. An
// unauthenticated caller is rejected having buffered nothing; only a holder of
// a valid agent session token can make this process hold 280MB.
router.post(
  "/operations/:operationId/result",
  authenticateAgent,
  agentResultJson,
  asyncHandler(controller.report)
);

// --- admin-facing -------------------------------------------------------
router.use(authenticate);

router.get("/", requirePermission("agent.manage"), asyncHandler(controller.list));
router.post("/", requirePermission("agent.manage"), asyncHandler(controller.register));
router.delete("/:id", requirePermission("agent.manage"), asyncHandler(controller.revoke));
router.get("/:id/operations", requirePermission("agent.manage"), asyncHandler(controller.listOperations));

module.exports = router;
