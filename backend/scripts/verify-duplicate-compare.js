// Proves you can actually DECIDE inside a duplicate group (task #45).
//
// The page's one job is "which of these copies do I keep", and it used to
// show a filename and a path per member. For an exact group that is the worst
// possible information: the bytes are identical, the names are usually
// identical too, so the two rows are indistinguishable and the choice is a
// coin flip. Everything that actually breaks the tie -- which drive it is on,
// whether that copy got indexed, whether it is filed, whether it is a cloud
// placeholder with no bytes here at all -- was in the database and not in the
// response.
//
// So this checks two things end to end:
//   the group detail carries enough per copy to choose between them, in the
//   right types (a bigint arriving as a string turns every size comparison
//   into a string comparison);
//   comparing two members returns the verdict the pipeline itself would
//   reach, for all four outcomes -- identical, probable, distinct, and not
//   enough text to say.
//
//   node scripts/verify-duplicate-compare.js

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const env = require("../src/config/env");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const duplicateGroupRepository = require("../src/repositories/duplicateGroupRepository");
const duplicateGroupService = require("../src/services/duplicateGroupService");
const fileContentRepository = require("../src/repositories/fileContentRepository");
const classificationResultRepository = require("../src/repositories/classificationResultRepository");
const subjectRepository = require("../src/repositories/subjectRepository");
const fileService = require("../src/services/fileService");
const { closeAllQueues } = require("../src/queues");
const { dequeueFixtureJobs, pauseQueues, resumeQueues } = require("./_fixtureQueue");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

let root, locId, groupId;

async function cleanup() {
  try {
    if (locId) {
      const ids = `(SELECT id FROM files WHERE storage_location_id='${locId}')`;
      await p.query(`DELETE FROM duplicate_group_members WHERE file_id IN ${ids}`);
      if (groupId) await p.query(`DELETE FROM duplicate_groups WHERE id=$1`, [groupId]);
      await p.query(`DELETE FROM rename_proposals      WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM classification_results WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_content          WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_metadata         WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_hashes           WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM audit_logs WHERE entity_type='file' AND entity_id IN ${ids}`);
      await p.query(
        `DELETE FROM processing_jobs WHERE storage_location_id=$1 OR payload->>'fileId' IN
           (SELECT id::text FROM files WHERE storage_location_id=$1)`, [locId]);
      await p.query(`DELETE FROM filesystem_scans WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM files            WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM storage_locations WHERE id=$1`, [locId]);
    }
    if (root) await fsp.rm(root, { recursive: true, force: true });
    console.log("\ncleaned up.");
  } catch (e) { console.log("cleanup warning:", e.message); }
  // Hand the queues back to whatever worker is running, even if the
  // script threw part-way through.
  await resumeQueues().catch(() => {});
  await p.end(); await closeAllQueues();
}

// Long enough to clear MIN_TOKENS_FOR_COMPARISON (40 words) -- below that the
// comparator correctly refuses to score, which is its own test case below.
const BODY =
  "Le present rapport annuel decrit les activites de la province pendant l annee ecoulee " +
  "ainsi que les depenses engagees par la communaute locale et les comptes verifies par " +
  "le conseil provincial reuni au mois de decembre pour approuver le budget suivant ";

(async () => {
  // A live worker would otherwise process these fixtures out from under
  // the assertions -- see scripts/_fixtureQueue.js.
  await pauseQueues();
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-dupcompare-"));
  const NAMES = ["copy-one.txt", "copy-two.txt", "near-copy.txt", "unrelated.txt", "almost-empty.txt"];
  for (const n of NAMES) await fsp.writeFile(path.join(root, n), "content of " + n);

  const admin = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
  // Every read below is owner-scoped (repositories/ownership.js): the owner is
  // a required argument, not an optional narrowing, so a fixture that omits it
  // throws rather than quietly reading the whole instance.
  const ownerId = admin.id;
  const loc = await storageLocationService.create(
    { name: "Dup Compare Test", type: "local", rootPath: root, accessMode: "direct" }, admin.id);
  locId = loc.id;
  await scanProcessor.handle({ storageLocationId: locId });
  await dequeueFixtureJobs(p, locId);

  const f = {};
  for (const r of (await p.query("SELECT * FROM files WHERE storage_location_id=$1", [locId])).rows) {
    f[r.filename_current] = r;
  }
  const idOf = (n) => f[n].id;

  // copy-one and copy-two are byte-identical: same hash, same text.
  await p.query("UPDATE files SET sha256_hash='identical-hash' WHERE id = ANY($1)",
    [[idOf("copy-one.txt"), idOf("copy-two.txt")]]);
  for (const n of ["copy-one.txt", "copy-two.txt"]) {
    await fileContentRepository.upsert(idOf(n), { extractedText: BODY, textQuality: "ok", needsOcr: false });
  }

  // near-copy shares most of its phrasing with the pair but is not identical.
  await p.query("UPDATE files SET sha256_hash='near-hash' WHERE id=$1", [idOf("near-copy.txt")]);
  await fileContentRepository.upsert(idOf("near-copy.txt"),
    { extractedText: BODY + "avec une note supplementaire ajoutee a la fin du document",
      textQuality: "ok", needsOcr: false });

  await p.query("UPDATE files SET sha256_hash='unrelated-hash' WHERE id=$1", [idOf("unrelated.txt")]);
  await fileContentRepository.upsert(idOf("unrelated.txt"), {
    extractedText:
      "Invoice for plumbing repairs carried out at the school building including replacement " +
      "of the main water pipe and the installation of new taps in the kitchen area during " +
      "the summer holidays as agreed with the contractor in writing beforehand and signed " +
      "off by the bursar once the work had been inspected and found satisfactory",
    textQuality: "ok", needsOcr: false,
  });

  // Below the 40-word floor: scoring this would rate two near-empty files as
  // near-identical on boilerplate alone.
  await p.query("UPDATE files SET sha256_hash='tiny-hash' WHERE id=$1", [idOf("almost-empty.txt")]);
  await fileContentRepository.upsert(idOf("almost-empty.txt"),
    { extractedText: "Just a few words here.", textQuality: "too_short", needsOcr: false });

  // One copy is filed and the other is not -- exactly the kind of difference
  // that decides which copy to keep, and exactly what was not being shown.
  const subject = (await subjectRepository.listTopLevel(ownerId))[0];
  await classificationResultRepository.create({
    fileId: idOf("copy-one.txt"),
    classifiedSubjectId: subject.id,
    classifiedDocumentTypeId: null,
    confidenceLevel: "high",
    confidenceScore: 1,
    method: "manual",
    rawOutput: { fixture: true },
  });

  const group = await duplicateGroupRepository.createGroup({
    ownerUserId: ownerId, groupType: "exact", detectionMethod: "hash", confidenceLevel: "high", confidenceScore: 1,
  });
  groupId = group.id;
  await duplicateGroupRepository.addMember(groupId, idOf("copy-one.txt"), 1);
  await duplicateGroupRepository.addMember(groupId, idOf("copy-two.txt"), 1);

  // --- can you tell the two copies apart? ---------------------------------

  console.log("\ninspecting a group's members:\n");

  const detail = await duplicateGroupService.getById(groupId, ownerId);
  const byName = Object.fromEntries(detail.members.map((m) => [m.filename_current, m]));
  const one = byName["copy-one.txt"];
  const two = byName["copy-two.txt"];

  check("both copies come back", detail.members.length === 2, `${detail.members.length} members`);

  for (const field of ["size_bytes", "location_name", "extension", "status", "text_quality", "text_length"]) {
    check(`each member carries ${field}`,
      detail.members.every((m) => m[field] !== undefined && m[field] !== null),
      JSON.stringify(detail.members.map((m) => m[field])));
  }

  check("size_bytes is a number, not a bigint string",
    typeof one.size_bytes === "number", typeof one.size_bytes);
  check("text_length is a number, not a bigint string",
    typeof one.text_length === "number", typeof one.text_length);

  check("the filed copy shows its subject and the unfiled one does not",
    one.subject_name === subject.name && two.subject_name === null,
    `${one.subject_name} / ${two.subject_name}`);

  // Both halves matter on screen: the name says which drive this copy is on,
  // and the read-only flag says whether renaming it would touch the original
  // at all. (New locations default to read-only -- originals are not this
  // app's to rewrite until someone says so.)
  check("the storage location travels with each copy",
    one.location_name === "Dup Compare Test" && typeof one.location_is_read_only === "boolean",
    `${one.location_name}, read-only=${one.location_is_read_only}`);

  check("no copy is canonical before anyone resolves the group",
    detail.members.every((m) => m.is_canonical === false),
    JSON.stringify(detail.members.map((m) => m.is_canonical)));

  await duplicateGroupService.resolve(groupId, { canonicalFileId: idOf("copy-one.txt") }, admin.id);
  const afterResolve = await duplicateGroupService.getById(groupId, ownerId);
  const flags = Object.fromEntries(afterResolve.members.map((m) => [m.filename_current, m.is_canonical]));
  check("after resolving, exactly the chosen copy is flagged canonical",
    flags["copy-one.txt"] === true && flags["copy-two.txt"] === false, JSON.stringify(flags));

  // --- comparing two of them ----------------------------------------------

  console.log("\ncomparing pairs:\n");

  const identical = await fileService.compareFiles(idOf("copy-one.txt"), idOf("copy-two.txt"), ownerId);
  check("two byte-identical copies compare as exact",
    identical.verdict === "exact" && identical.identical === true && identical.similarity === 1,
    `${identical.verdict} @ ${identical.similarity}`);

  const near = await fileService.compareFiles(idOf("copy-one.txt"), idOf("near-copy.txt"), ownerId);
  check("a near-copy compares as a probable duplicate, above the threshold",
    near.verdict === "probable" && near.similarity >= near.threshold,
    `${near.verdict} @ ${(near.similarity * 100).toFixed(1)}% (threshold ${(near.threshold * 100).toFixed(0)}%)`);

  const distinct = await fileService.compareFiles(idOf("copy-one.txt"), idOf("unrelated.txt"), ownerId);
  check("two unrelated documents compare as distinct",
    distinct.verdict === "distinct" && distinct.similarity < distinct.threshold,
    `${distinct.verdict} @ ${(distinct.similarity * 100).toFixed(1)}%`);

  const tooShort = await fileService.compareFiles(idOf("copy-one.txt"), idOf("almost-empty.txt"), ownerId);
  check("a file with too little text refuses to be scored rather than guessing",
    tooShort.verdict === "not_comparable" && tooShort.similarity === null,
    `${tooShort.verdict}, names the file: ${/almost-empty/.test(tooShort.explanation)}`);

  // Comparing must never be the thing that creates a group -- it is a
  // question, not an assertion (fileService.compareFiles is read-only).
  const groupCount = (await p.query(
    `SELECT count(*)::int n FROM duplicate_group_members WHERE file_id IN
       (SELECT id FROM files WHERE storage_location_id=$1)`, [locId])).rows[0].n;
  check("comparing created no new duplicate-group membership", groupCount === 2, `${groupCount} memberships`);

  let sameFile = null;
  try { await fileService.compareFiles(idOf("copy-one.txt"), idOf("copy-one.txt"), ownerId); }
  catch (err) { sameFile = err.message; }
  check("comparing a file with itself is refused", /two different files/i.test(sameFile || ""),
    sameFile || "(it was allowed!)");

  console.log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
  if (failed > 0) process.exitCode = 1;
})().catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; }).finally(cleanup);
