// Repairs damage already written by the mis-decoded OLE title bug.
//
// Fixing the decoder stops NEW garbage appearing; it does nothing for the
// titles, rename proposals and canonical names already stored from before.
// Those persist until something rewrites them, and a rename proposal is not
// self-correcting -- it sits in the queue looking like a decision waiting to
// be made.
//
// What this does, per affected file:
//   1. re-runs metadata extraction, so the stored title is re-read with the
//      fixed decoder
//   2. rejects any pending rename proposal whose proposed name is mojibake
//   3. re-queues naming, so a correct proposal replaces it
//   4. clears an APPLIED canonical name that is mojibake, so the file falls
//      back to its real filename until a good name is proposed
//
// Nothing on disk is touched. Canonical names live in the database and the
// shortcut mirror, both regenerable; the original files were never renamed.
//
//   node scripts/repair-mojibake-titles.js            # dry run, reports only
//   node scripts/repair-mojibake-titles.js --apply

const { Pool } = require("pg");
const env = require("../src/config/env");
const extractMetadataProcessor = require("../src/jobs/processors/extractMetadataProcessor");
const renameProposalRepository = require("../src/repositories/renameProposalRepository");
const auditLogRepository = require("../src/repositories/auditLogRepository");
const { looksLikeMojibake } = require("../src/services/extraction/ole/codePageString");
const { enqueueJob, closeAllQueues } = require("../src/queues");
const { JobType } = require("../src/models/enums");

const APPLY = process.argv.includes("--apply");
const pool = new Pool({ connectionString: env.databaseUrl });

(async () => {
  const titles = (await pool.query(
    `SELECT fm.file_id, fm.metadata->>'title' AS title, f.filename_current
       FROM file_metadata fm JOIN files f ON f.id = fm.file_id
      WHERE fm.metadata->>'title' IS NOT NULL AND f.status <> 'deleted'`
  )).rows.filter((r) => looksLikeMojibake(r.title));

  const proposals = (await pool.query(
    `SELECT id, file_id, proposed_filename FROM rename_proposals WHERE status = 'pending'`
  )).rows.filter((r) => looksLikeMojibake(r.proposed_filename));

  const applied = (await pool.query(
    `SELECT id, filename_current, canonical_filename FROM files
      WHERE canonical_filename IS NOT NULL AND status <> 'deleted'`
  )).rows.filter((r) => looksLikeMojibake(r.canonical_filename));

  console.log("Damage from the mis-decoded OLE title bug:");
  console.log(`  stored metadata titles      ${titles.length}`);
  console.log(`  pending rename proposals    ${proposals.length}`);
  console.log(`  APPLIED canonical names     ${applied.length}`);

  if (titles.length + proposals.length + applied.length === 0) {
    console.log("\nNothing to repair.");
    return;
  }

  const sample = [...titles.slice(0, 5), ...proposals.slice(0, 5)];
  if (sample.length) {
    console.log("\nExamples:");
    for (const s of sample) {
      const bad = s.title || s.proposed_filename;
      console.log(`  ${(s.filename_current || "").slice(0, 36).padEnd(36)} -> ${bad.slice(0, 44)}`);
    }
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to repair.");
    return;
  }

  // Every file that needs its metadata re-read: those with a bad stored
  // title, plus those whose proposal or canonical name is bad (the title they
  // came from may since have been overwritten, but re-reading is cheap and
  // idempotent).
  const fileIds = new Set([
    ...titles.map((t) => t.file_id),
    ...proposals.map((p) => p.file_id),
    ...applied.map((a) => a.id),
  ]);

  console.log(`\nRe-reading metadata for ${fileIds.size} file(s)...`);
  let reread = 0;
  let unreadable = 0;
  for (const fileId of fileIds) {
    try {
      await extractMetadataProcessor.handle({ fileId });
      reread += 1;
    } catch (err) {
      unreadable += 1; // drive offline, file moved -- report, don't abort
    }
  }
  console.log(`  re-read ${reread}, could not read ${unreadable}`);

  for (const p of proposals) {
    await renameProposalRepository.review(p.id, { status: "rejected", reviewedBy: null });
  }
  console.log(`Rejected ${proposals.length} mojibake proposal(s).`);

  for (const a of applied) {
    await pool.query(
      "UPDATE files SET canonical_filename = NULL, canonical_relative_dir = NULL, canonical_set_at = NULL WHERE id = $1",
      [a.id]
    );
    await auditLogRepository.record({
      action: "rename.mojibake_reverted",
      entityType: "file",
      entityId: a.id,
      previousState: { canonicalFilename: a.canonical_filename },
      reason:
        "The canonical name was generated from a title decoded with the wrong code page. Cleared so the " +
        "file shows its real filename again; a corrected name will be proposed. The file on disk was never renamed.",
    });
  }
  if (applied.length) console.log(`Cleared ${applied.length} applied canonical name(s).`);

  console.log("Re-queuing naming...");
  for (const fileId of fileIds) {
    await enqueueJob(JobType.GENERATE_NAMES, { fileId }, {});
  }

  console.log(`\nDone. ${fileIds.size} file(s) re-queued -- corrected proposals will appear shortly.`);
  if (applied.length) {
    console.log("Run a mirror sync afterwards so the shortcut folder picks up the corrected names.");
  }
})()
  .catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await closeAllQueues(); });
