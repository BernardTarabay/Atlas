// Proves the search filters (task #44) actually reach the SQL, on every path
// that has to honour them.
//
// The unit tests cover parsing and predicate building, which is pure. What
// they cannot cover is the part that goes wrong in practice: the predicates
// are spliced into four DIFFERENT queries, each with its own existing
// positional parameters, and an off-by-one in $n numbering is not a syntax
// error -- it runs, and quietly filters by the wrong value. So this runs the
// real queries against real rows and checks the sets that come back.
//
// The four paths, and why each one matters:
//   list (no search term)  "every PDF from 2019" contains no search term. A
//                          filter bar that only works alongside a query is
//                          not a filter bar.
//   full-text search       filters must NARROW a search, not replace it.
//   in-subject list        browsing a branch and narrowing within it.
//   per-subject counts     the number on a tree node must describe the list
//                          clicking it opens.
//
//   node scripts/verify-search-filters.js

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
const fileService = require("../src/services/fileService");
const subjectService = require("../src/services/subjectService");
const { closeAllQueues } = require("../src/queues");
const { dequeueFixtureJobs, pauseQueues, resumeQueues } = require("./_fixtureQueue");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

let root, locId, subjectIds = [];

async function cleanup() {
  try {
    if (locId) {
      const ids = `(SELECT id FROM files WHERE storage_location_id='${locId}')`;
      await p.query(`DELETE FROM rename_proposals      WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM classification_results WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_content          WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_metadata         WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_hashes           WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM duplicate_group_members WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM audit_logs WHERE entity_type='file' AND entity_id IN ${ids}`);
      await p.query(
        `DELETE FROM processing_jobs WHERE storage_location_id=$1 OR payload->>'fileId' IN
           (SELECT id::text FROM files WHERE storage_location_id=$1)`, [locId]);
      await p.query(`DELETE FROM filesystem_scans WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM files            WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM storage_locations WHERE id=$1`, [locId]);
    }
    for (const id of subjectIds.slice().reverse()) {
      await p.query("DELETE FROM subjects WHERE id=$1", [id]).catch(() => {});
    }
    if (root) await fsp.rm(root, { recursive: true, force: true });
    console.log("\ncleaned up.");
  } catch (e) { console.log("cleanup warning:", e.message); }
  // Hand the queues back to whatever worker is running, even if the
  // script threw part-way through.
  await resumeQueues().catch(() => {});
  await p.end(); await closeAllQueues();
}

const names = (rows) => rows.map((r) => r.filename_current || r.display_name).sort();
const sameSet = (rows, expected) =>
  JSON.stringify(names(rows)) === JSON.stringify([...expected].sort());

(async () => {
  // A live worker would otherwise process these fixtures out from under
  // the assertions -- see scripts/_fixtureQueue.js.
  await pauseQueues();
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-filters-"));
  await fsp.mkdir(path.join(root, "Archives"), { recursive: true });
  await fsp.mkdir(path.join(root, "Recent"), { recursive: true });

  // Two folders, three types, three years, two subjects (parent + child).
  // Every fixture differs from the others on exactly one axis so a failing
  // check names the filter that broke.
  const FIXTURES = [
    { file: "Archives/rapport-2019.pdf",  date: "2019-06-15", subject: "child",  text: "rapport annuel de la province" },
    { file: "Archives/lettre-2019.doc",   date: "2019-12-31", subject: "child",  text: "lettre au pere general" },
    { file: "Archives/budget-2021.pdf",   date: "2021-03-02", subject: "parent", text: "budget approuve par le conseil" },
    { file: "Recent/photo-2023.jpg",      date: "2023-08-01", subject: "parent", text: "photographie du couvent" },
    { file: "Recent/undated.pdf",         date: null,         subject: "child",  text: "document sans date connue" },
    { file: "Recent/README",              date: "2019-01-01", subject: null,     text: "notes about this folder" },
  ];
  for (const f of FIXTURES) await fsp.writeFile(path.join(root, f.file), "x".repeat(1024));

  const admin = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
  // Every read below is owner-scoped (repositories/ownership.js): the owner is
  // a required argument, not an optional narrowing, so a fixture that omits it
  // throws rather than quietly reading the whole instance.
  const ownerId = admin.id;
  const loc = await storageLocationService.create(
    { name: "Filter Test", type: "local", rootPath: root, accessMode: "direct" }, ownerId);
  locId = loc.id;
  await scanProcessor.handle({ storageLocationId: locId });
  await dequeueFixtureJobs(p, locId);

  // `level` is not passed: the migration-029 trigger derives it and
  // materialized_path from the parent, so there is one place that decides
  // where a row sits in the tree.
  const parent = await subjectRepository.create({
    ownerUserId: ownerId, parentId: null, name: "FilterTest Parent", slug: "filtertest-parent", description: null,
  });
  subjectIds.push(parent.id);
  const child = await subjectRepository.create({
    ownerUserId: ownerId, parentId: parent.id, name: "FilterTest Child", slug: "filtertest-child", description: null,
  });
  subjectIds.push(child.id);
  const subjectOf = { parent: parent.id, child: child.id };

  const byName = {};
  for (const r of (await p.query("SELECT * FROM files WHERE storage_location_id=$1", [locId])).rows) {
    byName[r.filename_current] = r;
  }

  for (const fx of FIXTURES) {
    const file = byName[path.basename(fx.file)];
    await p.query("UPDATE files SET document_date=$2, sha256_hash=$3 WHERE id=$1",
      [file.id, fx.date, `hash-${file.id}`]);
    await fileContentRepository.upsert(file.id, { extractedText: fx.text, textQuality: "ok", needsOcr: false });
    if (fx.subject) {
      await classificationResultRepository.create({
        fileId: file.id,
        classifiedSubjectId: subjectOf[fx.subject],
        classifiedDocumentTypeId: null,
        confidenceLevel: "high", confidenceScore: 1, method: "manual",
        rawOutput: { fixture: true },
      });
    }
  }

  // Everything below scopes to this location so the surrounding repository
  // (9k real files) cannot make a check pass or fail by accident.
  const listed = (extra = {}) =>
    fileService.search({ storageLocationId: locId, limit: 100, ...extra }, ownerId);
  const counted = (extra = {}) =>
    fileService.count({ storageLocationId: locId, ...extra }, ownerId);

  // --- the listing path (no search term) ----------------------------------

  console.log("\nfiltering the plain listing:\n");

  check("with no filters, every fixture is listed",
    (await listed()).length === FIXTURES.length, `${(await listed()).length} of ${FIXTURES.length}`);

  check("file type narrows to that type",
    sameSet(await listed({ ext: "pdf" }), ["rapport-2019.pdf", "budget-2021.pdf", "undated.pdf"]),
    names(await listed({ ext: "pdf" })).join(", "));

  check("several file types are an OR, not an impossible AND",
    (await listed({ ext: "pdf,jpg" })).length === 4,
    names(await listed({ ext: "pdf,jpg" })).join(", "));

  check("a file with no extension is reachable at all",
    sameSet(await listed({ ext: "none" }), ["README"]),
    names(await listed({ ext: "none" })).join(", "));

  check("a date range includes the whole of its final day",
    // lettre-2019.doc is dated 2019-12-31; an inclusive-midnight upper bound
    // would silently drop it.
    sameSet(await listed({ dateFrom: "2019-01-01", dateTo: "2019-12-31" }),
      ["rapport-2019.pdf", "lettre-2019.doc", "README"]),
    names(await listed({ dateFrom: "2019-01-01", dateTo: "2019-12-31" })).join(", "));

  check("an undated file matches no range, and says so by being absent",
    !names(await listed({ dateFrom: "1900-01-01", dateTo: "2100-01-01" })).includes("undated.pdf"),
    names(await listed({ dateFrom: "1900-01-01", dateTo: "2100-01-01" })).join(", "));

  check("a folder path filter is a prefix on the path inside the location",
    sameSet(await listed({ pathPrefix: "Archives" }),
      ["rapport-2019.pdf", "lettre-2019.doc", "budget-2021.pdf"]),
    names(await listed({ pathPrefix: "Archives" })).join(", "));

  check("the subject filter includes files filed under a CHILD subject",
    sameSet(await listed({ subjectId: parent.id }),
      ["rapport-2019.pdf", "lettre-2019.doc", "budget-2021.pdf", "photo-2023.jpg", "undated.pdf"]),
    names(await listed({ subjectId: parent.id })).join(", "));

  check("filtering by the child subject alone excludes the parent's own files",
    sameSet(await listed({ subjectId: child.id }),
      ["rapport-2019.pdf", "lettre-2019.doc", "undated.pdf"]),
    names(await listed({ subjectId: child.id })).join(", "));

  check("filters combine as AND: PDFs, from 2019, under Archives",
    sameSet(await listed({ ext: "pdf", dateFrom: "2019-01-01", dateTo: "2019-12-31", pathPrefix: "Archives" }),
      ["rapport-2019.pdf"]),
    names(await listed({ ext: "pdf", dateFrom: "2019-01-01", dateTo: "2019-12-31", pathPrefix: "Archives" })).join(", "));

  // --- the count path -----------------------------------------------------

  console.log("\ncounting:\n");

  for (const filter of [{}, { ext: "pdf" }, { pathPrefix: "Archives" }, { subjectId: parent.id },
                        { ext: "pdf", dateFrom: "2019-01-01", dateTo: "2019-12-31" }]) {
    const rows = await listed(filter);
    const { count } = await counted(filter);
    check(`the count matches the rows for ${JSON.stringify(filter) || "{}"}`,
      count === rows.length, `count=${count} rows=${rows.length}`);
  }

  // --- the full-text search path ------------------------------------------

  console.log("\nfiltering a search:\n");

  const searchAll = await listed({ q: "2019" });
  check("a search without filters finds both 2019 documents by name",
    names(searchAll).includes("rapport-2019.pdf") && names(searchAll).includes("lettre-2019.doc"),
    names(searchAll).join(", "));

  const searchPdf = await listed({ q: "2019", ext: "pdf" });
  check("a file-type filter NARROWS a search rather than replacing it",
    names(searchPdf).includes("rapport-2019.pdf") && !names(searchPdf).includes("lettre-2019.doc"),
    names(searchPdf).join(", "));

  const searchContent = await listed({ q: "provinceX-no-such-word" });
  check("a search that matches nothing still returns nothing once filtered",
    searchContent.length === 0, `${searchContent.length} rows`);

  const searchSubject = await listed({ q: "rapport", subjectId: child.id });
  check("a subject filter applies to search results too",
    sameSet(searchSubject, ["rapport-2019.pdf"]), names(searchSubject).join(", "));

  // --- inside a subject, and the tree counts ------------------------------

  console.log("\ninside a subject, and the tree:\n");

  const inChild = await subjectService.getDocumentsForSubject(child.id, { limit: 100 }, ownerId);
  check("browsing a subject lists its own files",
    sameSet(inChild, ["rapport-2019.pdf", "lettre-2019.doc", "undated.pdf"]), names(inChild).join(", "));

  const inChildPdf = await subjectService.getDocumentsForSubject(child.id, { limit: 100, ext: "pdf" }, ownerId);
  check("filters narrow WITHIN the subject you have open",
    sameSet(inChildPdf, ["rapport-2019.pdf", "undated.pdf"]), names(inChildPdf).join(", "));

  const inChildSearch = await subjectService.getDocumentsForSubject(child.id, { limit: 100, q: "lettre", ext: "pdf" }, ownerId);
  check("searching inside a subject respects the filter as well",
    inChildSearch.length === 0, names(inChildSearch).join(", ") || "(none, correctly)");

  const treeAll = await subjectService.list({}, ownerId);
  const treePdf = await subjectService.list({ ext: "pdf" }, ownerId);
  const nodeOf = (list, id) => list.find((s) => s.id === id);

  check("unfiltered, the tree rolls child counts up into the parent",
    nodeOf(treeAll, parent.id).fileCount === 2 && nodeOf(treeAll, parent.id).totalFileCount === 5,
    `direct=${nodeOf(treeAll, parent.id).fileCount} total=${nodeOf(treeAll, parent.id).totalFileCount}`);

  check("the tree's numbers describe the FILTERED set, not the whole one",
    nodeOf(treePdf, parent.id).fileCount === 1 && nodeOf(treePdf, parent.id).totalFileCount === 3,
    `direct=${nodeOf(treePdf, parent.id).fileCount} total=${nodeOf(treePdf, parent.id).totalFileCount}`);

  check("a tree node's count equals the number of files listing it returns",
    nodeOf(treePdf, child.id).fileCount ===
      (await subjectService.getDocumentsForSubject(child.id, { limit: 100, ext: "pdf" }, ownerId)).length,
    `${nodeOf(treePdf, child.id).fileCount}`);

  // --- refusals -----------------------------------------------------------

  console.log("\nrefusing bad input rather than ignoring it:\n");

  for (const [label, query] of [
    ["a malformed date", { dateFrom: "last tuesday" }],
    ["a backwards range", { dateFrom: "2021-01-01", dateTo: "2019-01-01" }],
    ["a malformed subject id", { subjectId: "nope" }],
  ]) {
    let message = null;
    try { await listed(query); } catch (err) { message = err.message; }
    check(`${label} is refused, not silently dropped`, Boolean(message), message || "(accepted!)");
  }

  // A filter the backend ignored is indistinguishable from one that matched
  // nothing -- which is how you conclude the archive has no 2019 documents.
  const unknownIgnored = await listed({ notAFilter: "whatever" });
  check("an unrecognised parameter does not silently narrow anything",
    unknownIgnored.length === FIXTURES.length, `${unknownIgnored.length} rows`);

  // --- facets -------------------------------------------------------------

  const facets = await fileRepository.filterFacets(ownerId);
  const facetExts = Object.fromEntries(facets.extensions.map((e) => [e.ext, e.count]));
  check("the type list offered to the user includes the no-extension bucket",
    facetExts.none >= 1, Object.keys(facetExts).slice(0, 8).join(", "));
  check("the facets report how many files a date filter would hide",
    facets.dateRange.undated >= 1, `${facets.dateRange.undated} undated`);

  console.log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
  if (failed > 0) process.exitCode = 1;
})().catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; }).finally(cleanup);
