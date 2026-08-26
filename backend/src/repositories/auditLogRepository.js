// Append-only audit trail (spec §21). No update/delete helpers are exposed
// on purpose -- audit rows are write-once from the application's perspective.
const db = require("../config/database");

/**
 * `client` is the escape hatch that lets an audit row join a caller's
 * transaction instead of autocommitting on its own connection.
 *
 * It matters because several job processors write a fact and then record it,
 * and those two statements were independently committed: a crash between them
 * left a change with no trace, or -- when the audit row landed first -- a
 * trace of something that never happened. Passing the transaction's client
 * makes the record and the thing it describes succeed or fail together.
 * Omitting it keeps the old behaviour exactly, so no existing caller changes.
 */
async function record({ userId = null, action, entityType, entityId = null, previousState = null, newState = null, reason = null, status = "success", ipAddress = null, userAgent = null, client = null }) {
  const exec = client || db;
  const { rows } = await exec.query(
    `INSERT INTO audit_logs (
       user_id, action, entity_type, entity_id, previous_state, new_state,
       reason, status, ip_address, user_agent
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [userId, action, entityType, entityId, previousState, newState, reason, status, ipAddress, userAgent]
  );
  return rows[0];
}

async function listForEntity(entityType, entityId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM audit_logs WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [entityType, entityId, limit, offset]
  );
  return rows;
}

async function listRecent({ limit = 100, offset = 0 } = {}) {
  const { rows } = await db.query(
    "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2",
    [limit, offset]
  );
  return rows;
}

/**
 * Used by the AI classification daily-call-cap check (spec: bounded, opt-in
 * spend) -- counting real persisted audit rows rather than an in-memory
 * counter means the cap survives a worker restart instead of quietly
 * resetting to zero.
 */
async function countSince(action, since) {
  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = $1 AND created_at >= $2",
    [action, since]
  );
  return rows[0].count;
}

/**
 * The same count across SEVERAL actions at once.
 *
 * Written for the daily AI cap, which counted three tiers of AI call against
 * one budget -- and which is now removed, because each tier was checking only
 * its own audit action and a "500-call cap" therefore allowed 1,003 calls.
 *
 * Kept because the question it answers is still a real one: "how many AI calls
 * of any kind have we made since X" is what reporting and dashboards want. It
 * simply no longer gates anything.
 */
async function countSinceAny(actions, since) {
  const list = (Array.isArray(actions) ? actions : [actions]).filter(Boolean);
  if (!list.length) return 0;
  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = ANY($1::text[]) AND created_at >= $2",
    [list, since]
  );
  return rows[0].count;
}

/**
 * Deliberate, single exception to "audit rows are write-once" (see the
 * header comment on this file). The Audit Log page needs a working "clear"
 * action; this is that action's only implementation. auditLogService.clear()
 * immediately writes one new row recording the clear itself, so there's
 * still a trace of who purged history and when, even though the history
 * that came before it is gone.
 */
async function clearAll() {
  const { rowCount } = await db.query("DELETE FROM audit_logs");
  return rowCount;
}

/** Used by the CSV export -- a plain, unpaginated read of recent history. */
async function listForExport({ limit = 10000 } = {}) {
  const { rows } = await db.query(
    "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
  return rows;
}

module.exports = { record, listForEntity, listRecent, countSince, countSinceAny, clearAll, listForExport };
