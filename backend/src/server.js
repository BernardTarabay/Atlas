const env = require("./config/env");
const app = require("./app");
const { pool } = require("./config/database");
const { startEmailSyncScheduler, stopEmailSyncScheduler } = require("./jobs/emailSyncScheduler");
const { startTrashPurgeScheduler, stopTrashPurgeScheduler } = require("./jobs/trashPurgeScheduler");
const { startOrganizeUnfiledScheduler, stopOrganizeUnfiledScheduler } = require("./jobs/organizeUnfiledScheduler");
const { startOperationalRetentionScheduler, stopOperationalRetentionScheduler } = require("./jobs/operationalRetentionScheduler");
const filesystemBrowseService = require("./services/filesystemBrowseService");
const { storageWatcher } = require("./jobs/storageWatcher");

const server = app.listen(env.port, () => {
  console.log(`Server running on http://localhost:${env.port} [${env.nodeEnv}]`);
  startEmailSyncScheduler();
  startTrashPurgeScheduler();
  startOrganizeUnfiledScheduler();
  startOperationalRetentionScheduler();

  // Real-time ingestion. Lives in the API process rather than the worker
  // for the same reason the email scheduler does: it only ever ENQUEUES
  // jobs, and running it in every worker replica would queue the same scan
  // once per replica.
  storageWatcher.start().catch((err) => console.error("[watcher] Failed to start:", err.message));

  // The folder picker is unconfined by default, which is right for the
  // self-hosted desktop this app is built for and wrong the moment a second
  // account exists. Checked at boot rather than assumed either way.
  filesystemBrowseService.warnIfSharedAndUnconfined().catch(() => {});
});

// Graceful shutdown so in-flight DB queries / connections close cleanly.
//
// Two things this did not do. It never closed the Postgres pool, so shutdown
// relied on process.exit tearing the sockets down rather than ending them
// properly. And server.close() only stops accepting NEW connections -- it
// waits indefinitely for existing keep-alive ones, which every browser tab
// holding the SPA has open. A restart with the app open in a tab therefore
// hung forever, and since this runs as a Scheduled Task at logon, the next
// start would find port 5000 still held by the process that was asked to
// stop.
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return; // a second Ctrl-C should not race the first
  shuttingDown = true;
  console.log(`[server] Received ${signal}, shutting down...`);

  stopEmailSyncScheduler();
  stopTrashPurgeScheduler();
  stopOrganizeUnfiledScheduler();
  stopOperationalRetentionScheduler();
  storageWatcher.stop();

  // Backstop: if anything is still holding the loop open after this, stop
  // anyway. A shutdown that does not finish is worse than an abrupt one.
  const forceExit = setTimeout(() => {
    console.error("[server] Shutdown timed out after 10s; exiting anyway.");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async () => {
    try {
      await pool.end();
      console.log("[server] Closed out remaining connections.");
    } catch (err) {
      console.error("[server] Error closing the database pool:", err.message);
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  });

  // Node 18.2+: ends idle keep-alive sockets and closes active ones once
  // their current response finishes, so the close callback above actually
  // fires instead of waiting on an open browser tab.
  server.closeIdleConnections?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = server;
