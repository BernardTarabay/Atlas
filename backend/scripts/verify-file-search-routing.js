// Guards the contract that lets a search result point at a place on the map.
//
// Two features depend on searchEverything returning subject_id: the Subjects
// map highlighting the branches that contain matching files, and the
// assistant's "Show me" button revealing the route to a file it found. The
// column was NOT there originally -- the decoration returned subject_name
// only -- so this exists to stop it quietly going away again. A missing id
// would not throw; the buttons would just silently do nothing.
//
//   node scripts/verify-file-search-routing.js

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const env = require("../src/config/env");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const fileContentRepository = require("../src/repositories/fileContentRepository");
const classificationResultRepository = require("../src/repositories/classificationResultRepository");
const subjectRepository = require("../src/repositories/subjectRepository");
const fileRepository = require("../src/repositories/fileRepository");
// searchEverything scopes by owner through its filters (buildFilterClauses
// refuses a missing owner). fileService.search does this for every production
// caller; a script calling the repository directly has to do it itself.
const { parseFileFilters } = require("../src/repositories/fileFilters");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

let root, locId;

(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-searchroute-"));
  await fsp.writeFile(path.join(root, "marina lease.txt"), "x");
  await fsp.writeFile(path.join(root, "unfiled note.txt"), "x");

  const admin = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
  const loc = await storageLocationService.create(
    { name: "Search Routing Test", type: "local", rootPath: root, accessMode: "direct" }, admin.id);
  locId = loc.id;
  await scanProcessor.handle({ storageLocationId: locId });

  const files = {};
  for (const r of (await p.query("SELECT * FROM files WHERE storage_location_id=$1", [locId])).rows) {
    files[r.filename_current] = r;
  }
  const subject = (await subjectRepository.list({ limit: 1 }))[0];

  // One classified file with real content...
  await fileContentRepository.upsert(files["marina lease.txt"].id, {
    extractedText: "Lease agreement for the marina development site, signed by both parties in March.",
    textQuality: "ok",
  });
  await classificationResultRepository.create({
    fileId: files["marina lease.txt"].id,
    classifiedSubjectId: subject.id,
    classifiedDocumentTypeId: null,
    confidenceLevel: "high",
    confidenceScore: 0.9,
    method: "rule",
    rawOutput: {},
  });

  // ...and one that has never been classified, which must come back with a
  // null subject rather than being dropped from the results.
  await fileContentRepository.upsert(files["unfiled note.txt"].id, {
    extractedText: "A marina related note that nobody has filed anywhere yet.",
    textQuality: "ok",
  });

  const rows = await fileRepository.searchEverything("marina", { limit: 10, offset: 0, filters: parseFileFilters({}, admin.id) });
  check("content search finds both files", rows.length === 2, `${rows.length} hit(s)`);

  const filed = rows.find((r) => r.filename_current === "marina lease.txt");
  const unfiled = rows.find((r) => r.filename_current === "unfiled note.txt");

  check("a classified hit carries subject_id", filed?.subject_id === subject.id,
    `${filed?.subject_id} (expected ${subject.id})`);
  check("a classified hit carries subject_name", filed?.subject_name === subject.name, filed?.subject_name);
  check("a content hit carries a snippet to show", Boolean(filed?.snippet), (filed?.snippet || "").slice(0, 48));

  // The unfiled case is the one that breaks a naive UI: there is nowhere to
  // reveal, so the button has to be disabled rather than pointing at null.
  check("an unclassified hit is returned, not dropped", Boolean(unfiled));
  check("an unclassified hit has a null subject_id", unfiled && unfiled.subject_id === null,
    String(unfiled?.subject_id));

  // Filename-only search has to carry the same fields, since the map
  // highlights from either kind of hit.
  const byName = await fileRepository.searchEverything("lease", { limit: 10, offset: 0, filters: parseFileFilters({}, admin.id) });
  const nameHit = byName.find((r) => r.filename_current === "marina lease.txt");
  check("a filename hit also carries subject_id", nameHit?.subject_id === subject.id, String(nameHit?.subject_id));

  console.log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
  if (failed > 0) process.exitCode = 1;
})()
  .catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; })
  .finally(async () => {
    try {
      if (locId) {
        const ids = `(SELECT id FROM files WHERE storage_location_id='${locId}')`;
        await p.query(`DELETE FROM classification_results WHERE file_id IN ${ids}`);
        await p.query(`DELETE FROM rename_proposals      WHERE file_id IN ${ids}`);
        await p.query(`DELETE FROM file_content          WHERE file_id IN ${ids}`);
        await p.query(`DELETE FROM file_metadata         WHERE file_id IN ${ids}`);
        await p.query(`DELETE FROM file_hashes           WHERE file_id IN ${ids}`);
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
  });
