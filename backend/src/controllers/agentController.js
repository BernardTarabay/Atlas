// HTTP shaping for the Filesystem Agent protocol. Two audiences share this
// file: admin-facing registration/revocation (user JWT + `agent.manage`),
// and agent-facing session/poll/report (agent JWT). The routes file keeps
// them behind different middleware.
const agentService = require("../services/agentService");
const filesystemAgentRepository = require("../repositories/filesystemAgentRepository");
const agentOperationRepository = require("../repositories/agentOperationRepository");
const { parsePagination } = require("../utils/pagination");

// --- admin-facing -------------------------------------------------------

async function list(req, res) {
  const { limit, offset } = parsePagination(req.query);
  // listWithStatus, not list: the stored `status` column goes stale the moment
  // an agent stops beating and nothing corrects it. See the repository.
  const agents = await filesystemAgentRepository.listWithStatus({ limit, offset });
  // api_key_hash must never leave the server, even to an admin.
  res.json(agents.map(({ api_key_hash, ...rest }) => rest));
}

async function register(req, res) {
  const { storageLocationId, name, registeredDirectories } = req.body || {};
  const { agent, apiKey } = await agentService.register(
    { storageLocationId, name, registeredDirectories },
    req.user.id
  );
  const { api_key_hash, ...safe } = agent;
  res.status(201).json({
    agent: safe,
    apiKey,
    // Said plainly because it is genuinely unrecoverable -- only the bcrypt
    // hash is stored, exactly like a user password.
    warning: "Copy this API key now. It is shown once and cannot be retrieved again.",
  });
}

async function revoke(req, res) {
  res.json(await agentService.revoke(req.params.id, req.user.id));
}

async function listOperations(req, res) {
  const { limit, offset } = parsePagination(req.query);
  res.json(await agentOperationRepository.listForAgent(req.params.id, { limit, offset }));
}

// --- agent-facing -------------------------------------------------------

async function openSession(req, res) {
  const { agentId, apiKey, agentVersion, platform, hostname } = req.body || {};
  res.json(await agentService.openSession({ agentId, apiKey, agentVersion, platform, hostname }));
}

async function heartbeat(req, res) {
  res.json(await agentService.heartbeat(req.agent.id, { registeredDirectories: req.body?.registeredDirectories }));
}

async function poll(req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const operations = await agentService.pollOperations(req.agent.id, limit);
  res.json(
    operations.map((op) => ({
      id: op.id,
      operationType: op.operation_type,
      payload: op.payload,
      expiresAt: op.expires_at,
    }))
  );
}

async function report(req, res) {
  const { success, result, errorMessage } = req.body || {};
  const updated = await agentService.reportResult(req.agent.id, req.params.operationId, {
    success: Boolean(success),
    result,
    errorMessage,
  });
  res.json({ id: updated.id, status: updated.status });
}

module.exports = { list, register, revoke, listOperations, openSession, heartbeat, poll, report };
