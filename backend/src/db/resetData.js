#!/usr/bin/env node
// Wipes everything that accumulates from scanning/uploading/processing
// files, for starting a clean test run without losing login access or
// taxonomy setup. Deliberately does NOT touch: users, roles, permissions,
// user_roles (you'd be locked out), subjects/document_types/tags (the seed
// taxonomy the naming pipeline depends on), refresh_tokens (no need to
// force a re-login), schema_migrations, or filesystem_agents (unrelated,
// unimplemented Phase 12 feature).
//
// Also deletes the physical bytes under the managed upload location's
// root (UPLOAD_ROOT) -- truncating the `files`/`storage_locations` rows
// alone would leave the actual uploaded copies orphaned on disk, and the
// next managed upload re-provisions a location pointing at the exact same
// folder, so leftover bytes there would just get rescanned right back in.
//
// Usage: npm run db:reset-data   (run from backend/, with the API and
// worker processes stopped first so nothing writes mid-reset)
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const readline = require("readline");
const { pool } = require("../config/database");
const env = require("../config/env");
const { closeAllQueues } = require("../queues");
const pgQueue = require("../queues/pgQueue");
const { JobType } = require("../models/enums");

const TABLES_TO_WIPE = [
  "processing_job_items",
  "processing_jobs",
  "duplicate_group_members",
  "duplicate_groups",
  "rename_proposals",
  "classification_results",
  "file_hashes",
  "file_content",
  "file_metadata",
  "related_documents",
  "document_versions",
  "document_subjects",
  "document_tags",
  "documents",
  "files",
  "filesystem_scans",
  "audit_logs",
  "storage_locations",
];

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function run() {
  const force = process.argv.includes("--yes");
  if (!force) {
    const answer = await confirm(
      `This permanently deletes ALL files, documents, proposals, duplicate groups, processing\n` +
      `jobs, audit log entries, and storage locations (users/roles/taxonomy are kept).\n` +
      `It also deletes uploaded file bytes under: ${path.resolve(process.env.UPLOAD_ROOT || "./storage/uploads")}\n` +
      `Type "yes" to continue: `
    );
    if (answer.trim().toLowerCase() !== "yes") {
      console.log("[reset-data] Aborted.");
      return;
    }
  }

  // PAUSE FIRST, THEN TRUNCATE.
  //
  // This used to have to drain Redis before touching the tables, because
  // processing_jobs was only half the story and truncating it while BullMQ
  // still held tens of thousands of jobs left the worker grinding through
  // every one against rows that no longer existed. On a real reset that was
  // 15,759 queued jobs -- a "clean slate" that spent the next hour logging
  // failures and could re-insert rows behind the truncate.
  //
  // Since migration 040 the jobs ARE the rows, so the truncate drains the
  // queue by definition and that whole failure mode is gone. What remains is
  // the narrower race: a worker claiming new work mid-reset. Pausing stops
  // that. A job already executing at this instant may still write a row
  // afterwards, which is exactly why the truncate comes second.
  await drainQueues();

  const client = await pool.connect();
  try {
    console.log("[reset-data] Truncating tables...");
    await client.query("BEGIN");
    await client.query(`TRUNCATE TABLE ${TABLES_TO_WIPE.join(", ")} RESTART IDENTITY CASCADE`);
    await client.query("COMMIT");
    console.log(`[reset-data] Truncated: ${TABLES_TO_WIPE.join(", ")}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // SECOND SWEEP.
  //
  // The header says to stop the worker first, and on a real reset nobody
  // did -- jobs that were already executing when the truncate landed
  // finished afterwards and wrote a duplicate group, four processing_jobs
  // rows and seven audit entries referencing files that no longer exist.
  // Small, but the whole point of this script is that "0 files" means zero
  // of everything. The queues are already drained by now, so nothing new can
  // start; this just catches whatever was mid-flight.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const strays = await pool.query(
    `SELECT (SELECT count(*) FROM processing_jobs)
          + (SELECT count(*) FROM duplicate_groups)
          + (SELECT count(*) FROM audit_logs) AS n`
  );
  if (Number(strays.rows[0].n) > 0) {
    await pool.query(
      `TRUNCATE TABLE processing_job_items, processing_jobs, duplicate_group_members,
                     duplicate_groups, filesystem_scans, audit_logs RESTART IDENTITY CASCADE`
    );
    console.log(
      `[reset-data] Swept ${strays.rows[0].n} row(s) written by jobs that were still ` +
      "running when the truncate landed."
    );
  }

  const uploadRoot = path.resolve(process.env.UPLOAD_ROOT || "./storage/uploads");
  try {
    await fsp.rm(uploadRoot, { recursive: true, force: true });
    await fsp.mkdir(uploadRoot, { recursive: true });
    console.log(`[reset-data] Cleared uploaded file bytes at ${uploadRoot}`);
  } catch (err) {
    console.warn(`[reset-data] Could not clear ${uploadRoot}: ${err.message} (delete it by hand if needed)`);
  }

  await clearMirror();

  console.log("[reset-data] Done. Users, roles, and taxonomy (subjects/document types) were left untouched.");
  console.log("[reset-data] Your ORIGINAL files were not touched -- this app never moves or deletes them.");
}

/**
 * Stop workers claiming new jobs for the duration of the reset.
 *
 * Deliberately does NOT wait for running jobs to finish. A reset should not
 * block on a 67-second video description, and the truncate below removes the
 * rows any straggler would write to.
 *
 * The queue is left paused only until the reset finishes -- resumeQueue() in
 * the finally block hands it back even if this throws, because a queue left
 * paused looks exactly like a broken worker.
 */
async function drainQueues() {
  try {
    await pgQueue.setPaused(true, "reset-data");
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM processing_jobs WHERE status IN ('queued','running')"
    );
    console.log(`[reset-data] Paused the queue; ${rows[0].n} pending job(s) will be truncated with the tables.`);
  } catch (err) {
    // A reset must still work when the queue table is in a bad state -- that
    // is a common reason to be resetting in the first place.
    console.warn(`[reset-data] Could not pause the queue: ${err.message}`);
  }
}

async function resumeQueue() {
  await pgQueue.setPaused(false).catch(() => {});
}

/**
 * Remove the organized shortcut mirror.
 *
 * The mirror is disposable by design -- it is regenerated from the database
 * by the sync_mirror job -- so leaving it behind after a wipe means a folder
 * full of shortcuts pointing at files the app no longer knows about.
 *
 * Only shortcut files are deleted, never anything else. The mirror lives in a
 * folder the user can open, and treating "delete the mirror" as "delete that
 * whole directory" would take anything they had dropped in there with it.
 */
async function clearMirror() {
  const mirrorRoot = env.mirrorRoot;
  if (!mirrorRoot) return;

  let removed = 0;
  let kept = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        // Only removes directories the walk left empty; rmdir on a
        // non-empty one throws and is ignored.
        await fsp.rmdir(full).catch(() => {});
      } else if (/\.(lnk|url)$/i.test(entry.name)) {
        await fsp.rm(full, { force: true }).catch(() => {});
        removed += 1;
      } else {
        kept += 1;
      }
    }
  }

  try {
    await walk(path.resolve(mirrorRoot));
    console.log(
      `[reset-data] Removed ${removed} shortcut(s) from the mirror at ${mirrorRoot}` +
      (kept > 0 ? ` (left ${kept} non-shortcut file(s) alone).` : ".")
    );
  } catch (err) {
    console.warn(`[reset-data] Could not clear the mirror at ${mirrorRoot}: ${err.message}`);
  }
}

run()
  .catch((err) => {
    console.error("[reset-data] Failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await resumeQueue();
    await pool.end();
    await closeAllQueues().catch(() => {});
  });
