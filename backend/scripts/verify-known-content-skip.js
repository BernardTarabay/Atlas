// Proves the reported problem is fixed: "when I add 2 storage locations with
// very similar files but one has 1k new files, I want it to disregard all
// previously seen files and only allow the new files through the pipeline".
//
// This walks the actual scenario. Folder A is scanned and fully processed.
// Folder B is then registered, containing mostly the same documents plus a
// few genuinely new ones. What has to be true afterwards:
//
//   the repeated files cost nothing        no extract_metadata, no
//                                          extract_text, no classify, no
//                                          generate_names, and above all no
//                                          Gemini call
//   they are still fully usable            searchable text, a subject, a
//                                          date -- adopting must not leave
//                                          them as blanks in the listings
//   they produce no review items           no rename proposal per copy; that
//                                          pile is the actual complaint
//   they are still recorded as duplicates  the whole point of the app
//   the NEW files are untouched by any     they must go through everything,
//   of this                                or the optimisation has eaten the
//                                          feature
//
//   node scripts/verify-known-content-skip.js

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const env = require("../src/config/env");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const hashProcessor = require("../src/jobs/processors/hashProcessor");
const extractMetadataProcessor = require("../src/jobs/processors/extractMetadataProcessor");
const extractTextProcessor = require("../src/jobs/processors/extractTextProcessor");
const classifyProcessor = require("../src/jobs/processors/classifyProcessor");
const detectDuplicatesProcessor = require("../src/jobs/processors/detectDuplicatesProcessor");
const classificationResultRepository = require("../src/repositories/classificationResultRepository");
const fileContentRepository = require("../src/repositories/fileContentRepository");
const fileMetadataRepository = require("../src/repositories/fileMetadataRepository");
const subjectRepository = require("../src/repositories/subjectRepository");
const duplicateGroupRepository = require("../src/repositories/duplicateGroupRepository");
const fileRepository = require("../src/repositories/fileRepository");
const dashboardRepository = require("../src/repositories/dashboardRepository");
const { parseFileFilters } = require("../src/repositories/fileFilters");
const { closeAllQueues } = require("../src/queues");
const { dequeueFixtureJobs, pauseQueues, resumeQueues } = require("./_fixtureQueue");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

let rootA, rootB, locA, locB;

async function cleanup() {
  try {
    for (const id of [locA, locB].filter(Boolean)) {
      const ids = `(SELECT id FROM files WHERE storage_location_id='${id}')`;
      await p.query(`DELETE FROM duplicate_group_members WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM rename_proposals       WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM classification_results  WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_content           WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_metadata          WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_hashes            WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM audit_logs WHERE entity_type='file' AND entity_id IN ${ids}`);
      await p.query(
        `DELETE FROM processing_jobs WHERE storage_location_id=$1 OR payload->>'fileId' IN
           (SELECT id::text FROM files WHERE storage_location_id=$1)`, [id]);
      await p.query(`DELETE FROM filesystem_scans WHERE storage_location_id=$1`, [id]);
      await p.query(`DELETE FROM files            WHERE storage_location_id=$1`, [id]);
      await p.query(`DELETE FROM storage_locations WHERE id=$1`, [id]);
    }
    await p.query("DELETE FROM duplicate_groups WHERE NOT EXISTS (SELECT 1 FROM duplicate_group_members m WHERE m.duplicate_group_id = duplicate_groups.id)");
    for (const r of [rootA, rootB].filter(Boolean)) await fsp.rm(r, { recursive: true, force: true });
    console.log("\ncleaned up.");
  } catch (e) { console.log("cleanup warning:", e.message); }
  // Hand the queues back to whatever worker is running, even if the
  // script threw part-way through.
  await resumeQueues().catch(() => {});
  await p.end(); await closeAllQueues();
}

// Real enough to survive the text-quality gate (40+ words, proper prose) --
// a fixture that reads as gibberish would be skipped for unrelated reasons
// and prove nothing.
const doc = (n) =>
  `Rapport numero ${n} de la province. Le present document decrit les activites du couvent pendant ` +
  `l annee ecoulee, les depenses engagees par la communaute locale, et les comptes verifies par le ` +
  `conseil provincial reuni au mois de decembre afin d approuver le budget de l exercice suivant.`;

/** Everything hashProcessor fans out to, run inline (no Redis worker here). */
async function runPipelineFor(fileId) {
  const res = await hashProcessor.handle({ fileId });
  if (res.knownContent) {
    await detectDuplicatesProcessor.handle({ fileId, phase: "exact" });
    return res;
  }
  await extractMetadataProcessor.handle({ fileId });
  await extractTextProcessor.handle({ fileId });
  await classifyProcessor.handle({ fileId });
  await detectDuplicatesProcessor.handle({ fileId, phase: "exact" });
  return res;
}

const jobsFor = async (fileId, type) =>
  (await p.query("SELECT count(*)::int n FROM processing_jobs WHERE payload->>'fileId'=$1 AND job_type=$2",
    [fileId, type])).rows[0].n;

(async () => {
  // A live worker would otherwise process these fixtures out from under
  // the assertions -- see scripts/_fixtureQueue.js.
  await pauseQueues();
  rootA = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-known-a-"));
  rootB = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-known-b-"));

  // Folder A: three documents. Folder B: the same three (byte-identical,
  // one of them even renamed, which must not stop it being recognised) plus
  // two genuinely new ones.
  const SHARED = ["alpha.txt", "beta.txt", "gamma.txt"];
  for (const n of SHARED) await fsp.writeFile(path.join(rootA, n), doc(n));
  await fsp.writeFile(path.join(rootB, "alpha.txt"), doc("alpha.txt"));
  await fsp.writeFile(path.join(rootB, "beta-COPY.txt"), doc("beta.txt")); // same bytes, different name
  await fsp.writeFile(path.join(rootB, "gamma.txt"), doc("gamma.txt"));
  await fsp.writeFile(path.join(rootB, "brand-new-1.txt"), doc("brand-new-1"));
  await fsp.writeFile(path.join(rootB, "brand-new-2.txt"), doc("brand-new-2"));

  const admin = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
  const a = await storageLocationService.create(
    { name: "Known Content A", type: "local", rootPath: rootA, accessMode: "direct" }, admin.id);
  locA = a.id;

  console.log("\nprocessing folder A (the first import):\n");
  await scanProcessor.handle({ storageLocationId: locA });
  const filesA = (await p.query("SELECT * FROM files WHERE storage_location_id=$1 ORDER BY filename_current", [locA])).rows;
  for (const f of filesA) await hashProcessor.handle({ fileId: f.id });

  // Folder A's analysis results are seeded rather than extracted. `.txt` has
  // no registered extractor (docs/07-supported-formats.md), so running the
  // real extractor over these fixtures would store an empty string and the
  // adoption checks below would pass on two empty rows matching. Seeding
  // gives the twin something real to hand over, which is the thing under
  // test. Folder B still goes through the genuine pipeline.
  const subject = (await subjectRepository.list({ limit: 1 }))[0];
  for (const f of filesA) {
    await fileContentRepository.upsert(f.id, {
      extractedText: doc(f.filename_current), textQuality: "ok", needsOcr: false,
    });
    await fileMetadataRepository.upsert(f.id, {
      extractor: "fixture", extractorVersion: "1", metadata: { title: `Titre ${f.filename_current}` },
      extractionStatus: "completed",
    });
    await classificationResultRepository.create({
      fileId: f.id, classifiedSubjectId: subject.id, classifiedDocumentTypeId: null,
      confidenceLevel: "high", confidenceScore: 0.9, method: "rule", rawOutput: { fixture: true },
    });
  }
  await p.query(
    `UPDATE files SET ai_short_title='Rapport provincial', ai_classified_at=now(),
            document_date='2019-06-15', document_date_source='embedded'
      WHERE storage_location_id=$1`, [locA]);

  const seededA = (await p.query(
    `SELECT count(*)::int n FROM file_content fc JOIN files f ON f.id=fc.file_id
      WHERE f.storage_location_id=$1 AND length(fc.extracted_text) > 0`, [locA])).rows[0].n;
  check("folder A has real extracted text for all three of its files", seededA === 3, `${seededA} of 3`);

  // --- now the second, overlapping folder ---------------------------------

  console.log("\nregistering folder B (3 repeats + 2 new):\n");
  const b = await storageLocationService.create(
    { name: "Known Content B", type: "local", rootPath: rootB, accessMode: "direct" }, admin.id);
  locB = b.id;
  await scanProcessor.handle({ storageLocationId: locB });
  await dequeueFixtureJobs(p, locB);

  const filesB = (await p.query("SELECT * FROM files WHERE storage_location_id=$1 ORDER BY filename_current", [locB])).rows;
  const results = {};
  for (const f of filesB) results[f.filename_current] = await runPipelineFor(f.id);

  const REPEATS = ["alpha.txt", "beta-COPY.txt", "gamma.txt"];
  const NEW = ["brand-new-1.txt", "brand-new-2.txt"];
  const byName = Object.fromEntries(filesB.map((f) => [f.filename_current, f]));

  check("all three repeated files were recognised as already-seen content",
    REPEATS.every((n) => results[n]?.knownContent === true),
    REPEATS.map((n) => `${n}:${Boolean(results[n]?.knownContent)}`).join(" "));

  check("a repeat is recognised by CONTENT, not by filename",
    results["beta-COPY.txt"]?.knownContent === true, "beta-COPY.txt has a different name to its twin");

  check("the genuinely new files were NOT short-circuited",
    NEW.every((n) => !results[n]?.knownContent),
    NEW.map((n) => `${n}:${Boolean(results[n]?.knownContent)}`).join(" "));

  // --- the repeats cost nothing -------------------------------------------

  console.log("\nwhat the repeats cost:\n");

  for (const type of ["extract_metadata", "extract_text", "classify", "generate_names"]) {
    const counts = await Promise.all(REPEATS.map((n) => jobsFor(byName[n].id, type)));
    check(`no ${type} job was queued for any repeat`, counts.every((c) => c === 0), counts.join(","));
  }

  const newJobs = await Promise.all(NEW.map((n) => jobsFor(byName[n].id, "extract_text")));
  check("the new files DID get queued for extraction",
    newJobs.every((c) => c >= 1), newJobs.join(","));

  const aiCalls = (await p.query(
    `SELECT count(*)::int n FROM audit_logs WHERE action='ai_classification.called' AND entity_id = ANY($1)`,
    [REPEATS.map((n) => byName[n].id)])).rows[0].n;
  check("no Gemini call was made for any repeat", aiCalls === 0, `${aiCalls} calls`);

  const proposals = (await p.query(
    `SELECT count(*)::int n FROM rename_proposals WHERE file_id = ANY($1)`,
    [REPEATS.map((n) => byName[n].id)])).rows[0].n;
  check("no rename proposal was created for any repeat -- nothing new to review",
    proposals === 0, `${proposals} proposals`);

  // --- but they are still complete ----------------------------------------

  console.log("\nand yet the repeats are fully usable:\n");

  const contentB = (await p.query(
    `SELECT f.filename_current, fc.text_quality, length(fc.extracted_text) len
       FROM files f JOIN file_content fc ON fc.file_id=f.id
      WHERE f.id = ANY($1) ORDER BY 1`, [REPEATS.map((n) => byName[n].id)])).rows;
  check("every repeat has extracted text, adopted rather than re-parsed",
    contentB.length === 3 && contentB.every((r) => r.len > 0 && r.text_quality === "ok"),
    contentB.map((r) => `${r.filename_current}:${r.len}`).join(" "));

  const searchable = (await p.query(
    `SELECT count(*)::int n FROM file_content fc
      WHERE fc.file_id = ANY($1) AND fc.search_vector @@ websearch_to_tsquery('french','provincial')`,
    [REPEATS.map((n) => byName[n].id)])).rows[0].n;
  check("the adopted text is indexed, so the copies are findable by content",
    searchable === 3, `${searchable} of 3 match a content search`);

  const meta = (await p.query(
    `SELECT count(*)::int n FROM file_metadata WHERE file_id = ANY($1) AND metadata->>'title' IS NOT NULL`,
    [REPEATS.map((n) => byName[n].id)])).rows[0].n;
  check("every repeat inherited the embedded metadata too, not just the text",
    meta === 3, `${meta} of 3`);

  const dated = (await p.query(
    `SELECT count(*)::int n FROM files
      WHERE id = ANY($1) AND document_date IS NOT NULL AND document_date_source='embedded'`,
    [REPEATS.map((n) => byName[n].id)])).rows[0].n;
  check("every repeat inherited the document date, so the new date column is not blank",
    dated === 3, `${dated} of 3`);

  const filed = (await p.query(
    `SELECT count(*)::int n FROM files f WHERE f.id = ANY($1)
       AND EXISTS (SELECT 1 FROM classification_results cr
                    WHERE cr.file_id=f.id AND cr.classified_subject_id IS NOT NULL)`,
    [REPEATS.map((n) => byName[n].id)])).rows[0].n;
  check("every repeat inherited its twin's subject, so it is filed not orphaned",
    filed === 3, `${filed} of 3 filed`);

  const enriched = (await p.query(
    `SELECT count(*)::int n FROM files WHERE id = ANY($1) AND ai_short_title IS NOT NULL`,
    [REPEATS.map((n) => byName[n].id)])).rows[0].n;
  check("the repeats show the same AI title as their twins, not a blank row",
    enriched === 3, `${enriched} of 3`);

  const named = (await p.query(
    `SELECT count(*)::int n FROM files WHERE id = ANY($1) AND canonical_filename IS NOT NULL`,
    [REPEATS.map((n) => byName[n].id)])).rows[0].n;
  check("a repeat keeps its OWN filename -- no second naming decision",
    named === 0, `${named} were renamed`);

  // --- still honestly reported as duplicates ------------------------------

  const grouped = (await p.query(
    `SELECT count(DISTINCT dgm.duplicate_group_id)::int n FROM duplicate_group_members dgm
      WHERE dgm.file_id = ANY($1)`, [REPEATS.map((n) => byName[n].id)])).rows[0].n;
  check("each repeat is still recorded in a duplicate group",
    grouped === 3, `${grouped} groups`);

  const audited = (await p.query(
    `SELECT count(*)::int n FROM audit_logs
      WHERE action='file.adopted_known_content' AND entity_id = ANY($1)`,
    [REPEATS.map((n) => byName[n].id)])).rows[0].n;
  check("every skip is written to the audit log, not silent", audited === 3, `${audited} entries`);

  // --- and once settled, they stop inflating every number ------------------
  //
  // THE COMPLAINT THIS COMES FROM: "it still says 31 documents, the photos are
  // duped too." The pipeline was doing its job -- duplicates detected, groups
  // resolved, a canonical copy chosen -- and the Library went on listing both
  // copies of everything, because the exclusion lived only in the
  // subject-scoped queries and was missing from the listing, the count, the id
  // sweep, the photo grid and the dashboard.
  //
  // A resolved group means the question "which copy do I keep" has an answer.
  // Every view that reports "what documents do I have" has to use it, and they
  // have to agree with each other -- that trio has drifted apart twice already.

  console.log("\nand once the duplicate is settled:\n");

  const scoped = { pathPrefix: "" };
  const before = await fileRepository.countMatching({ filters: parseFileFilters(scoped, admin.id) });

  // Resolve every group the repeats belong to, choosing folder A's copy.
  const groupIds = (await p.query(
    `SELECT DISTINCT duplicate_group_id AS id FROM duplicate_group_members WHERE file_id = ANY($1)`,
    [REPEATS.map((n) => byName[n].id)])).rows.map((r) => r.id);
  for (const gid of groupIds) {
    const members = await duplicateGroupRepository.listMembers(gid);
    const keeper = members.find((m) => m.storage_location_id === locA) || members[0];
    if (keeper) await duplicateGroupRepository.setCanonicalFile(gid, keeper.file_id || keeper.id, admin.id);
  }

  const after = await fileRepository.countMatching({ filters: parseFileFilters(scoped, admin.id) });
  check("resolving the duplicates lowers the document count",
    after < before, `${before} -> ${after}`);

  const listed = await fileRepository.listNotDeleted({
    limit: 500, filters: parseFileFilters(scoped, admin.id),
  });
  check("...the listing and the count agree",
    listed.length === after, `list ${listed.length}, count ${after}`);

  const ids = await fileRepository.idsMatching({
    filters: parseFileFilters(scoped, admin.id), subjectId: null, limit: 5000,
  });
  check("...and so does 'select all', which has drifted from them twice",
    ids.length === after, `ids ${ids.length}, count ${after}`);

  const overview = await dashboardRepository.overview(admin.id);
  check("...and the dashboard reports the same number as the library",
    overview.total_files === after, `dashboard ${overview.total_files}, library ${after}`);

  const stillGrouped = (await p.query(
    `SELECT count(DISTINCT dgm.duplicate_group_id)::int n FROM duplicate_group_members dgm
      WHERE dgm.file_id = ANY($1)`, [REPEATS.map((n) => byName[n].id)])).rows[0].n;
  check("...while the duplicate groups themselves are untouched -- nothing was deleted",
    stillGrouped === 3, `${stillGrouped} groups still recorded`);

  console.log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
  if (failed > 0) process.exitCode = 1;
})().catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; }).finally(cleanup);
