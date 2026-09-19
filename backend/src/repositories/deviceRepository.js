// Registered machines.
//
// A device is the durable identity of a computer in this system; a
// filesystem_agent is one credential currently able to reach it. Keeping them
// apart means reinstalling the agent (new API key, new machine name from the
// OS, a reformat) does not create a second "computer" in the UI and does not
// orphan the file_replicas rows that record what is stored on it.
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");
const { ownedRepository, requireOwner } = require("./ownership");

const base = createBaseRepository("devices", { defaultOrderBy: "name ASC" });
const owned = ownedRepository(db, "devices", { orderBy: "name ASC" });

// Beyond this a device that has stopped heartbeating is reported offline. The
// agent's own poll interval is 5s and it heartbeats on every successful poll,
// so two minutes is many missed beats -- long enough to ride out a suspended
// laptop lid or a flaky connection without flapping the status.
const ONLINE_GRACE_SECONDS = 120;

/**
 * The user's devices, with the live-derived status rather than the stored one.
 *
 * `status` in the table is only ever as fresh as the last write. A laptop that
 * is closed mid-session leaves 'online' behind and nothing ever corrects it,
 * so the UI would keep promising files are reachable from a machine that
 * stopped answering hours ago. Deriving from last_seen_at at read time means
 * "offline" needs no background sweeper to be true.
 */
async function listForOwnerWithStatus(ownerUserId) {
  requireOwner(ownerUserId, "devices.listForOwnerWithStatus");
  const { rows } = await db.query(
    `SELECT d.*,
            CASE
              WHEN d.status = 'revoked'        THEN 'revoked'
              WHEN d.kind = 'server'           THEN 'online'
              WHEN d.last_seen_at IS NULL      THEN 'never_connected'
              WHEN d.last_seen_at > now() - ($2 || ' seconds')::interval THEN 'online'
              ELSE 'offline'
            END AS live_status,
            (SELECT count(*)::int FROM storage_locations sl
              WHERE sl.device_id = d.id AND sl.is_active = true) AS location_count,
            (SELECT count(*)::int FROM file_replicas fr
              WHERE fr.device_id = d.id AND fr.state = 'present')  AS file_count,
            (SELECT count(*)::int FROM filesystem_agents fa
              WHERE fa.device_id = d.id AND fa.revoked_at IS NULL) AS agent_count
       FROM devices d
      WHERE d.owner_user_id = $1
      ORDER BY (d.kind = 'server') DESC, d.name ASC`,
    [ownerUserId, ONLINE_GRACE_SECONDS]
  );
  return rows;
}

async function create({ ownerUserId, name, hostname = null, platform = null, kind = "desktop" }) {
  requireOwner(ownerUserId, "devices.create");
  const { rows } = await db.query(
    `INSERT INTO devices (owner_user_id, name, hostname, platform, kind)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [ownerUserId, name, hostname, platform, kind]
  );
  return rows[0];
}

/**
 * The server's own device row for a user, created on first need.
 *
 * Every `direct` storage location is physically on the machine running this
 * backend, and the cross-device UI has to be able to say so. Doing this
 * lazily rather than at registration keeps the users table free of a
 * side effect, and ON CONFLICT makes it safe to call from concurrent
 * requests.
 */
async function ensureServerDevice(ownerUserId) {
  requireOwner(ownerUserId, "devices.ensureServerDevice");
  const { rows } = await db.query(
    `INSERT INTO devices (owner_user_id, name, kind, status)
     VALUES ($1, 'This server', 'server', 'online')
     ON CONFLICT (owner_user_id, name) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [ownerUserId]
  );
  return rows[0];
}

async function rename(id, ownerUserId, name) {
  requireOwner(ownerUserId, "devices.rename");
  const { rows } = await db.query(
    `UPDATE devices SET name = $3, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 RETURNING *`,
    [id, ownerUserId, name]
  );
  return rows[0] || null;
}

async function setStatus(id, ownerUserId, status) {
  requireOwner(ownerUserId, "devices.setStatus");
  const { rows } = await db.query(
    `UPDATE devices SET status = $3, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 RETURNING *`,
    [id, ownerUserId, status]
  );
  return rows[0] || null;
}

/** True when this device is answering right now. The single source of the
 *  online rule, so availability checks and the device list cannot disagree. */
async function isOnline(deviceId) {
  const { rows } = await db.query(
    `SELECT (kind = 'server'
             OR (status <> 'revoked'
                 AND last_seen_at IS NOT NULL
                 AND last_seen_at > now() - ($2 || ' seconds')::interval)) AS online
       FROM devices WHERE id = $1`,
    [deviceId, ONLINE_GRACE_SECONDS]
  );
  return rows[0]?.online === true;
}

module.exports = {
  ...base, ...owned,
  ONLINE_GRACE_SECONDS,
  listForOwnerWithStatus, create, ensureServerDevice, rename, setStatus, isOnline,
};
