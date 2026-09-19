// Proves bulk move BY CRITERIA: "file everything matching this into that".
//
// WHAT THIS IS FOR
//
// Every bulk filing path before this started from a set the user had already
// assembled -- ticked checkboxes, a photo grid, a triage queue, or one whole
// folder. None of them answered "move every file LIKE this", which is the only
// form the instruction can take once an archive is big enough that nobody is
// going to tick fifty thousand boxes. The assistant now proposes it as a single
// reviewable card (move_by_filter) instead of thousands of move_file actions.
//
// WHAT MUST HOLD, AND WHY EACH ONE BITES
//
//  1. The filter vocabulary is the UI's. If the assistant's `ext` meant
//     something different from the filter bar's `ext`, the card a user approved
//     would not be the set they were shown.
//  2. Files already in the destination are NOT re-filed. "Latest row wins", so
//     re-filing 50,000 unmoved files buries every real placement decision under
//     a wall of no-ops and costs 50,000 writes to change nothing.
//  3. The match set is snapshotted before work starts. `unfiled=true` stops
//     matching a file the moment it is filed, so a paging implementation skips
//     everything that moved out from under its OFFSET.
//  4. An empty filter is refused. It means the entire repository, which is a
//     legitimate thing to ask for and a catastrophic thing to do by accident.
//  5. Ownership holds. A filter is not a list of ids someone hand-checked.
//
//     node scripts/verify-move-by-filter.js

const { Pool } = require("pg");
const env = require("../src/config/env");
const fileService = require("../src/services/fileService");
const fileRepository = require("../src/repositories/fileRepository");
const subjectRepository = require("../src/repositories/subjectRepository");
const bulkMoveProcessor = require("../src/jobs/processors/bulkMoveProcessor");
const classificationResultRepository = require("../src/repositories/classificationResultRepository");
const processingJobRepository = require("../src/repositories/processingJobRepository");
const { parseFileFilters } = require("../src/repositories/fileFilters");
const { ConfidenceLevel, ClassificationMethod } = require("../src/models/enums");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

const PREFIX = "__verify_move_by_filter__";
const fixtureIds = [];
const subjectIds = [];

async function cleanup() {
  try {
    if (fixtureIds.length) {
      await p.query("DELETE FROM processing_job_items WHERE file_id = ANY($1::uuid[])", [fixtureIds]);
      await p.query("DELETE FROM classification_results WHERE file_id = ANY($1::uuid[])", [fixtureIds]);
      await p.query("DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])", [fixtureIds]);
      await p.query("DELETE FROM files WHERE id = ANY($1::uuid[])", [fixtureIds]);
    }
    for (const id of subjectIds.slice().reverse()) {
      await p.query("DELETE FROM audit_logs WHERE entity_id=$1", [id]).catch(() => {});
      await p.query("DELETE FROM subjects WHERE id=$1", [id]).catch(() => {});
    }
    if (jobRowIds.length) {
      await p.query("DELETE FROM processing_job_items WHERE processing_job_id = ANY($1::uuid[])", [jobRowIds]).catch(() => {});
      await p.query("DELETE FROM processing_jobs WHERE id = ANY($1::uuid[])", [jobRowIds]).catch(() => {});
    }
  } catch (e) { console.log(`   (cleanup) ${e.message}`); }
  await p.end().catch(() => {});
  await closeAllQueues().catch(() => {});
  
}

async function makeFile(locationId, ownerUserId, { ext, date, folder }) {
  const rel = `${PREFIX}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { rows } = await p.query(
    `INSERT INTO files (storage_location_id, filename_original, filename_current, size_bytes,
                        original_path, current_path, status, owner_user_id, document_date, extension)
     VALUES ($1,$2,$2,1,$3,$3,'active',$4,$5,$6) RETURNING id`,
    [locationId, `f.${ext}`, rel, ownerUserId, date, ext]
  );
  fixtureIds.push(rows[0].id);
  return rows[0].id;
}

const fileToSubject = (fileId, subjectId) =>
  classificationResultRepository.createPartial({
    fileId, classifiedSubjectId: subjectId,
    confidenceLevel: ConfidenceLevel.HIGH, confidenceScore: 1,
    method: ClassificationMethod.MANUAL, rawOutput: { fixture: true },
  });

/**
 * A stand-in for the queued job, carrying a REAL processing_jobs row.
 *
 * Not a bare `{ data: {} }`: the processor writes a processing_job_item per
 * file so "why did 12 of 4,000 not move" is answerable afterwards, and those
 * rows have a NOT NULL job_id. Faking the id away would skip the per-file
 * bookkeeping entirely -- which is precisely the part worth checking, since it
 * is what the Processing Jobs page reads. This creates the row the worker
 * would have created and passes its id through the same field.
 */
const jobRowIds = [];
async function makeJob(ownerUserId) {
  const row = await processingJobRepository.create({
    jobType: "bulk_move", payload: { testRun: PREFIX }, ownerUserId, createdBy: ownerUserId,
  });
  jobRowIds.push(row.id);
  return { data: { processingJobId: row.id }, updateProgress: async () => {} };
}

(async () => {
  console.log("Verifying move-by-filter\n" + "=".repeat(38));
  try {
    const owner = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
    const location = (await p.query("SELECT id FROM storage_locations ORDER BY created_at LIMIT 1")).rows[0];
    if (!owner || !location) { console.log("   SKIP  needs a user and a storage location"); return; }

    const dest = await subjectRepository.create({
      ownerUserId: owner.id, parentId: null, name: `${PREFIX} Destination`, slug: `${PREFIX}-dest`.toLowerCase().replace(/_/g, "-"),
    });
    subjectIds.push(dest.id);
    const elsewhere = await subjectRepository.create({
      ownerUserId: owner.id, parentId: null, name: `${PREFIX} Elsewhere`, slug: `${PREFIX}-else`.toLowerCase().replace(/_/g, "-"),
    });
    subjectIds.push(elsewhere.id);

    // 3 PDFs from 2019, 2 PDFs from 2023, 2 JPGs from 2019. Every fixture
    // differs on exactly one axis so a failure names the filter that broke.
    const pdf2019 = [];
    for (let i = 0; i < 3; i += 1) pdf2019.push(await makeFile(location.id, owner.id, { ext: "pdf", date: "2019-06-15", folder: "Archives" }));
    const pdf2023 = [];
    for (let i = 0; i < 2; i += 1) pdf2023.push(await makeFile(location.id, owner.id, { ext: "pdf", date: "2023-06-15", folder: "Recent" }));
    const jpg2019 = [];
    for (let i = 0; i < 2; i += 1) jpg2019.push(await makeFile(location.id, owner.id, { ext: "jpg", date: "2019-06-15", folder: "Archives" }));

    for (const id of [...pdf2019, ...pdf2023, ...jpg2019]) await fileToSubject(id, elsewhere.id);

    console.log("\n1. The filter vocabulary is the UI's, not a second dialect");

    const scoped = { ext: "pdf", dateFrom: "2019-01-01", dateTo: "2019-12-31", pathPrefix: PREFIX };
    const listed = await fileRepository.idsMatching({
      filters: parseFileFilters(scoped, owner.id), subjectId: null, limit: 1000,
    });
    const mine = listed.filter((id) => fixtureIds.includes(id));
    check("the same query object the filter bar sends resolves the same files",
      mine.length === 3 && pdf2019.every((id) => mine.includes(id)),
      `${mine.length} of 3 (PDFs, 2019, under ${PREFIX})`);

    console.log("\n2. Filing by criteria moves exactly the matching set");

    const summary = await bulkMoveProcessor.handle({
      filters: scoped, toSubjectId: dest.id, actorUserId: owner.id, ownerUserId: owner.id,
    }, await makeJob(owner.id));

    check("every matching file was filed", summary.moved === 3,
      `moved ${summary.moved}, failed ${summary.failed}, matched ${summary.matched}`);

    const inDest = await fileRepository.idsCurrentlyInSubject(fixtureIds, dest.id);
    check("...and they are now in the destination", pdf2019.every((id) => inDest.has(id)),
      `${inDest.size} in "${summary.destination}"`);

    const stillElsewhere = await fileRepository.idsCurrentlyInSubject(fixtureIds, elsewhere.id);
    check("...and NOTHING that failed to match was touched",
      stillElsewhere.size === 4 && [...pdf2023, ...jpg2019].every((id) => stillElsewhere.has(id)),
      `${stillElsewhere.size} untouched (2 PDFs from 2023, 2 JPGs from 2019)`);

    console.log("\n3. Running it again is a no-op, not 3 more classification rows");

    const rowsBefore = (await p.query(
      "SELECT count(*)::int n FROM classification_results WHERE file_id = ANY($1::uuid[])", [pdf2019])).rows[0].n;

    const second = await bulkMoveProcessor.handle({
      filters: scoped, toSubjectId: dest.id, actorUserId: owner.id, ownerUserId: owner.id,
    }, await makeJob(owner.id));

    const rowsAfter = (await p.query(
      "SELECT count(*)::int n FROM classification_results WHERE file_id = ANY($1::uuid[])", [pdf2019])).rows[0].n;

    check("files already in the destination are reported, not re-filed",
      second.alreadyInDestination === 3 && second.moved === 0,
      `alreadyInDestination ${second.alreadyInDestination}, moved ${second.moved}`);
    check("...and no classification rows were written for them",
      rowsAfter === rowsBefore, `${rowsBefore} -> ${rowsAfter}`);

    console.log("\n4. The unfiled pile can be emptied in one instruction");

    // The case a paging implementation gets wrong: `unfiled` stops matching a
    // file the instant it is filed, so OFFSET-based batching skips whatever
    // moved out from under it. The set is snapshotted, so it cannot.
    const unfiled = [];
    for (let i = 0; i < 5; i += 1) unfiled.push(await makeFile(location.id, owner.id, { ext: "txt", date: null, folder: "Inbox" }));

    const unfiledSummary = await bulkMoveProcessor.handle({
      filters: { unfiled: "true", pathPrefix: PREFIX }, toSubjectId: dest.id,
      actorUserId: owner.id, ownerUserId: owner.id,
    }, await makeJob(owner.id));

    check("every unfiled file was filed, none skipped by a shifting window",
      unfiledSummary.moved === 5, `moved ${unfiledSummary.moved} of 5`);

    const stillUnfiled = await fileRepository.countMatching({
      filters: parseFileFilters({ unfiled: "true", pathPrefix: PREFIX }, owner.id),
    });
    check("...and the pile is actually empty afterwards", stillUnfiled === 0, `${stillUnfiled} left`);

    console.log("\n5. What it refuses");

    let threw = null;
    try { await fileService.moveByFilter({}, dest.id, owner.id); }
    catch (e) { threw = e.message; }
    check("an empty filter is refused rather than moving the whole repository",
      /every file/i.test(threw || ""), threw || "(accepted!)");

    threw = null;
    try { await fileService.moveByFilter({ ext: "pdf" }, null, owner.id); }
    catch (e) { threw = e.message; }
    check("filing with no destination is refused", /folder/i.test(threw || ""), threw || "(accepted!)");

    threw = null;
    try { await fileService.moveByFilter({ dateFrom: "last tuesday" }, dest.id, owner.id); }
    catch (e) { threw = e.message; }
    check("a malformed filter is refused in the request, not in a worker later",
      /YYYY-MM-DD/.test(threw || ""), threw || "(accepted!)");

    threw = null;
    try {
      await bulkMoveProcessor.handle({
        filters: { ext: "pdf" }, toSubjectId: "00000000-0000-4000-8000-000000000000",
        actorUserId: owner.id, ownerUserId: owner.id,
      }, await makeJob(owner.id));
    } catch (e) { threw = e.message; }
    check("a destination that no longer exists fails loudly, mid-job",
      /no longer exists/i.test(threw || ""), threw || "(accepted!)");

    threw = null;
    try {
      await bulkMoveProcessor.handle({ filters: { ext: "pdf" }, toSubjectId: dest.id }, await makeJob(owner.id));
    } catch (e) { threw = e.message; }
    check("a job with no owner is refused rather than filing every account's files",
      /owner/i.test(threw || ""), threw || "(accepted!)");

    console.log("\n6. Document type stays independent of where files are filed");

    // The axes must not become coupled by this work: filing by a type filter
    // must not CHANGE any file's type, and must not require one.
    const typesBefore = (await p.query(
      `SELECT count(*)::int n FROM classification_results cr
        WHERE cr.file_id = ANY($1::uuid[]) AND cr.classified_document_type_id IS NOT NULL`,
      [pdf2019])).rows[0].n;
    check("filing by criteria wrote no document types", typesBefore === 0,
      `${typesBefore} type assignments on the moved files`);
  } catch (e) {
    failed += 1;
    console.log(`\n   ERROR ${e.stack}`);
  } finally {
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
