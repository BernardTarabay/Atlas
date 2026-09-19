const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("filesystem_agents");

/**
 * How long after its last heartbeat an agent is still called online.
 *
 * The same 120 seconds deviceRepository uses, and the same reasoning: the
 * agent heartbeats on a fixed interval, so this only has to be comfortably
 * longer than that interval plus one missed beat.
 */
const ONLINE_GRACE_SECONDS = 120;

/**
 * Every agent, with a LIVE-DERIVED status rather than the stored one.
 *
 * `filesystem_agents.status` is only ever as fresh as the last write, and the
 * only writer that sets it to 'online' is markHeartbeat. Nothing set it back.
 * There WAS a markStaleOffline() written for that job, carrying a comment
 * explaining why it mattered -- and it had no caller anywhere in the codebase,
 * so an agent whose machine was shut down reported itself online forever, and
 * GET /api/agents told an administrator that a dead agent was answering.
 *
 * Deriving it here is what deviceRepository.listForOwnerWithStatus already
 * does, for the identical reason its own comment gives: "offline" needs no
 * background sweeper to be true. A sweeper is a second thing that has to be
 * running for a status to be correct, and this table already knows the answer.
 *
 * `revoked_at` wins over everything: a revoked agent that happens to still be
 * beating is not online, it is finished.
 */
async function listWithStatus({ limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT a.*,
            CASE
              WHEN a.revoked_at IS NOT NULL THEN 'revoked'
              WHEN a.last_seen_at IS NULL   THEN 'never_connected'
              WHEN a.last_seen_at > now() - ($3 || ' seconds')::interval THEN 'online'
              ELSE 'offline'
            END AS status
       FROM filesystem_agents a
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset, ONLINE_GRACE_SECONDS]
  );
  return rows;
}

/** The single active (non-revoked) agent brokering a location, if any. */
async function findActiveForStorageLocation(storageLocationId) {
  const { rows } = await db.query(
    `SELECT * FROM filesystem_agents
     WHERE storage_location_id = $1 AND revoked_at IS NULL
     ORDER BY last_seen_at DESC NULLS LAST, created_at ASC
     LIMIT 1`,
    [storageLocationId]
  );
  return rows[0] || null;
}

async function create({ storageLocationId, name, apiKeyHash, registeredDirectories = [] }) {
  const { rows } = await db.query(
    `INSERT INTO filesystem_agents
       (storage_location_id, name, api_key_hash, status, registered_directories)
     VALUES ($1, $2, $3, 'offline', $4)
     RETURNING *`,
    [storageLocationId, name, apiKeyHash, JSON.stringify(registeredDirectories)]
  );
  return rows[0];
}

/**
 * Enrollment/identity fields reported by the agent when it opens a session.
 * Written as one explicit statement rather than a generic column-name-driven
 * update: this table holds api_key_hash, and a dynamic updater is exactly
 * how a credential column ends up writable from a request body.
 */
async function updateEnrollment(id, { agentVersion, platform, hostname, registeredDirectories }) {
  const { rows } = await db.query(
    `UPDATE filesystem_agents SET
       enrolled_at   = COALESCE(enrolled_at, now()),
       agent_version = COALESCE($2, agent_version),
       platform      = COALESCE($3, platform),
       hostname      = COALESCE($4, hostname),
       registered_directories = COALESCE($5, registered_directories)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      agentVersion || null,
      platform || null,
      hostname || null,
      registeredDirectories ? JSON.stringify(registeredDirectories) : null,
    ]
  );
  return rows[0] || null;
}

async function markHeartbeat(id) {
  const { rows } = await db.query(
    `UPDATE filesystem_agents SET status = 'online', last_seen_at = now()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

async function revoke(id) {
  const { rows } = await db.query(
    `UPDATE filesystem_agents SET revoked_at = now(), status = 'offline'
     WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  ...base,
  ONLINE_GRACE_SECONDS,
  listWithStatus,
  findActiveForStorageLocation,
  create,
  updateEnrollment,
  markHeartbeat,
  revoke,
};
