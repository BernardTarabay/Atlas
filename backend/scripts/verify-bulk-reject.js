// Proves "clear the 0% suggestions" clears exactly the right rows -- and,
// more importantly, that it touches nothing else.
//
// The risk with a threshold-based bulk action is silent over-reach: an
// off-by-one on the comparison, or a missing status filter, and it quietly
// discards proposals the user still wanted. That is invisible afterwards,
// because a rejected proposal looks the same whether it was rejected on
// purpose or not.
//
//   node scripts/verify-bulk-reject.js

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const env = require("../src/config/env");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const renameProposalService = require("../src/services/renameProposalService");
const renameProposalRepository = require("../src/repositories/renameProposalRepository");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

let root, locId;

async function cleanup() {
  try {
    if (locId) {
      const ids = `(SELECT id FROM files WHERE storage_location_id='${locId}')`;
      await p.query(`DELETE FROM rename_proposals WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_content    WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_metadata   WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_hashes     WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM audit_logs WHERE entity_type='file' AND entity_id IN ${ids}`);
      await p.query(`DELETE FROM processing_jobs  WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM filesystem_scans WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM files            WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM storage_locations WHERE id=$1`, [locId]);
    }
    if (root) await fsp.rm(root, { recursive: true, force: true });
    console.log("\ncleaned up.");
  } catch (e) { console.log("cleanup warning:", e.message); }
  await p.end(); await closeAllQueues();
}

(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-reject-"));
  for (let i = 0; i < 6; i += 1) await fsp.writeFile(path.join(root, `f${i}.txt`), `file ${i}`);

  const admin = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
  const loc = await storageLocationService.create(
    { name: "Bulk Reject Test", type: "local", rootPath: root, accessMode: "direct" }, admin.id);
  locId = loc.id;
  await scanProcessor.handle({ storageLocationId: locId });

  const files = (await p.query("SELECT id FROM files WHERE storage_location_id=$1 ORDER BY filename_current", [locId])).rows;
  check("six test files indexed", files.length === 6, `${files.length}`);

  // A spread across the threshold, plus one already-decided row that must be
  // left alone no matter what.
  const scores = [0, 0, 0.2, 0.5, 0.95];
  const made = [];
  for (const [i, score] of scores.entries()) {
    made.push(await renameProposalRepository.create({
      fileId: files[i].id,
      currentFilename: `f${i}.txt`,
      proposedFilename: `Renamed_${i}.txt`,
      confidenceLevel: score >= 0.8 ? "high" : score > 0 ? "medium" : "low",
      confidenceScore: score,
      reason: "verification fixture",
    }));
  }
  // Already applied -- a bulk reject must never reach back and change it.
  const applied = await renameProposalRepository.create({
    fileId: files[5].id,
    currentFilename: "f5.txt",
    proposedFilename: "Already_Applied.txt",
    confidenceLevel: "low",
    confidenceScore: 0,
    reason: "verification fixture",
  });
  await p.query("UPDATE rename_proposals SET status='applied' WHERE id=$1", [applied.id]);

  console.log("\nfixtures: pending at 0, 0, 0.2, 0.5, 0.95 + one APPLIED at 0");

  // --- dry run must agree with what the action then does ------------------
  const preview = await renameProposalService.countPendingBelowConfidence(0, admin.id);
  check("dry run counts exactly the two pending zeros", preview.count === 2, `count=${preview.count}`);

  const result = await renameProposalService.rejectBelowConfidence(0, admin.id);
  check("reject discards exactly two", result.rejected === 2, `rejected=${result.rejected}`);

  const after = Object.fromEntries(
    (await p.query(
      `SELECT status, count(*)::int n FROM rename_proposals
        WHERE file_id IN (SELECT id FROM files WHERE storage_location_id=$1) GROUP BY 1`, [locId]
    )).rows.map((r) => [r.status, r.n])
  );
  check("three pending survive", (after.pending || 0) === 3, JSON.stringify(after));
  check("the applied row is untouched", (after.applied || 0) === 1, JSON.stringify(after));

  const survivors = (await p.query(
    `SELECT confidence_score FROM rename_proposals
      WHERE status='pending' AND file_id IN (SELECT id FROM files WHERE storage_location_id=$1)
      ORDER BY confidence_score`, [locId])).rows.map((r) => Number(r.confidence_score));
  check("survivors are the non-zero ones", JSON.stringify(survivors) === JSON.stringify([0.2, 0.5, 0.95]),
    JSON.stringify(survivors));

  // --- the threshold is inclusive, and must not run away ------------------
  const preview2 = await renameProposalService.countPendingBelowConfidence(0.5, admin.id);
  check("0.5 threshold is inclusive of 0.5", preview2.count === 2, `count=${preview2.count}`);

  const r2 = await renameProposalService.rejectBelowConfidence(0.5, admin.id);
  check("rejecting at 0.5 leaves the 0.95 alone", r2.rejected === 2, `rejected=${r2.rejected}`);

  const left = (await p.query(
    `SELECT confidence_score FROM rename_proposals
      WHERE status='pending' AND file_id IN (SELECT id FROM files WHERE storage_location_id=$1)`, [locId]
  )).rows.map((r) => Number(r.confidence_score));
  check("only the high-confidence proposal remains", JSON.stringify(left) === JSON.stringify([0.95]), JSON.stringify(left));

  // --- no file was harmed -------------------------------------------------
  const onDisk = await fsp.readdir(root);
  check("every original file is still on disk", onDisk.length === 6, onDisk.join(", "));
  const canon = (await p.query(
    "SELECT count(*)::int n FROM files WHERE storage_location_id=$1 AND canonical_filename IS NOT NULL", [locId]
  )).rows[0].n;
  check("no canonical name was written by a rejection", canon === 0, `${canon}`);

  // --- garbage thresholds are refused, not guessed at ---------------------
  for (const bad of [undefined, null, "", "abc", -1, 2]) {
    let threw = false;
    try { await renameProposalService.rejectBelowConfidence(bad, admin.id); } catch { threw = true; }
    check(`refuses maxConfidence=${JSON.stringify(bad)}`, threw);
  }

  console.log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
  if (failed > 0) process.exitCode = 1;
})().catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; }).finally(cleanup);
