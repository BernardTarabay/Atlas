// Connected mailboxes (docs/10-email-inbox.md). One row per Gmail
// account a user has connected for inbox triage.
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("email_accounts", { defaultOrderBy: "created_at DESC" });

async function findByProviderAndAddress(provider, emailAddress) {
  const { rows } = await db.query(
    "SELECT * FROM email_accounts WHERE provider = $1 AND email_address = $2",
    [provider, emailAddress]
  );
  return rows[0] || null;
}

async function listByUser(userId) {
  const { rows } = await db.query(
    "SELECT * FROM email_accounts WHERE user_id = $1 ORDER BY created_at DESC",
    [userId]
  );
  return rows;
}

/** Every currently-connected account, regardless of owner -- used by the
 * periodic background sync scheduler (server.js), which isn't acting on
 * behalf of any one logged-in request. */
async function listConnected() {
  const { rows } = await db.query("SELECT * FROM email_accounts WHERE status = 'connected'");
  return rows;
}

async function updateTokens(id, { refreshTokenEncrypted, scopes }) {
  const { rows } = await db.query(
    `UPDATE email_accounts SET refresh_token_encrypted = $2, scopes = $3, status = 'connected', last_error = NULL
     WHERE id = $1 RETURNING *`,
    [id, refreshTokenEncrypted, scopes]
  );
  return rows[0] || null;
}

async function markSynced(id) {
  const { rows } = await db.query(
    "UPDATE email_accounts SET last_synced_at = now(), last_error = NULL, status = 'connected' WHERE id = $1 RETURNING *",
    [id]
  );
  return rows[0] || null;
}

async function markError(id, message) {
  const { rows } = await db.query(
    "UPDATE email_accounts SET status = 'error', last_error = $2 WHERE id = $1 RETURNING *",
    [id, message]
  );
  return rows[0] || null;
}

async function disconnect(id) {
  const { rows } = await db.query(
    "UPDATE email_accounts SET status = 'disconnected' WHERE id = $1 RETURNING *",
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  ...base,
  findByProviderAndAddress, listByUser, listConnected,
  updateTokens, markSynced, markError, disconnect,
};
