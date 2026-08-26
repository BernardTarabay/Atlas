// Proves the two naming rules that were reported as broken:
//
//   1. A title shared across many files is the TEMPLATE's title, not the
//      document's. Measured on the live corpus, 403 files carried the
//      organisation's name and every one of them was being renamed to it.
//   2. With no title worth using, the file KEEPS ITS NAME. It must not fall
//      back to a taxonomy bucket ("Academic.pdf"), which is both worse than
//      the name it had and identical for every file in that subject.
//
// The negative case matters just as much: a genuinely unique, descriptive
// title must still produce a rename, or the guard has broken the feature it
// was protecting.
//
//   node scripts/verify-title-quality.js

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const env = require("../src/config/env");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const generateNamesProcessor = require("../src/jobs/processors/generateNamesProcessor");
const fileContentRepository = require("../src/repositories/fileContentRepository");
const fileMetadataRepository = require("../src/repositories/fileMetadataRepository");
const classificationResultRepository = require("../src/repositories/classificationResultRepository");
const subjectRepository = require("../src/repositories/subjectRepository");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

const COMPANY = "Ordre des Peres Carmes -- VERIFY FIXTURE";
let root, locId;

async function cleanup() {
  try {
    if (locId) {
      const ids = `(SELECT id FROM files WHERE storage_location_id='${locId}')`;
      await p.query(`DELETE FROM rename_proposals      WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM classification_results WHERE file_id IN ${ids}`);
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
}

const proposalFor = async (fileId) =>
  (await p.query("SELECT * FROM rename_proposals WHERE file_id=$1", [fileId])).rows[0] || null;

(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-title-"));
  // Six files sharing one title (the template), one with a real title, one
  // with none at all.
  const shared = Array.from({ length: 6 }, (_, i) => `circulaire ${i + 1}.doc`);
  const NAMES = [...shared, "real title.doc", "no title at all.doc"];
  for (const n of NAMES) await fsp.writeFile(path.join(root, n), "x".repeat(4096));

  const admin = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
  const loc = await storageLocationService.create(
    { name: "Title Quality Test", type: "local", rootPath: root, accessMode: "direct" }, admin.id);
  locId = loc.id;
  await scanProcessor.handle({ storageLocationId: locId });

  const files = {};
  for (const r of (await p.query("SELECT * FROM files WHERE storage_location_id=$1", [locId])).rows) {
    files[r.filename_current] = r;
  }
  const subject = (await subjectRepository.list({ limit: 1 }))[0];

  const setup = async (name, title) => {
    const f = files[name];
    await fileContentRepository.upsert(f.id, {
      extractedText: "A letter to the community regarding the annual assembly and the associated arrangements.",
      textQuality: "ok",
    });
    if (title) {
      await fileMetadataRepository.upsert(f.id, {
        extractor: "doc", extractorVersion: "test",
        metadata: { title }, extractionStatus: "completed",
      });
    }
    await classificationResultRepository.create({
      fileId: f.id,
      classifiedSubjectId: subject.id,
      classifiedDocumentTypeId: null,
      confidenceLevel: "medium",
      confidenceScore: 0.6,
      method: "rule",
      rawOutput: {},
    });
    return f;
  };

  for (const n of shared) await setup(n, COMPANY);
  await setup("real title.doc", "Convention de Bail Marina 2024");
  await setup("no title at all.doc", null);

  console.log(`\nfixtures: 6 files sharing "${COMPANY.slice(0, 30)}...", 1 unique title, 1 with none\n`);

  for (const n of NAMES) await generateNamesProcessor.handle({ fileId: files[n].id });

  // --- boilerplate must be ignored ---------------------------------------
  const first = await proposalFor(files[shared[0]].id);
  const usedCompany = first && first.proposed_filename.toLowerCase().includes("ordre");
  check("a title shared by 6 files is NOT used as the name", !usedCompany,
    first ? first.proposed_filename : "(no proposal)");

  check("that file keeps its original filename",
    !first || first.proposed_filename === "circulaire 1.doc",
    first ? first.proposed_filename : "(no proposal at all)");

  const audited = (await p.query(
    `SELECT count(*)::int n FROM audit_logs WHERE action='rename.boilerplate_title_ignored'
      AND entity_id = ANY($1)`, [shared.map((n) => files[n].id)]
  )).rows[0].n;
  check("the reason is recorded, not silent", audited >= 1, `${audited} audit entries`);

  // --- no title means no rename, NOT a bucket name ------------------------
  const none = await proposalFor(files["no title at all.doc"].id);
  const bucketish = none && /^(academic|finance|legal|administrative|personal|reference)\b/i.test(none.proposed_filename);
  check("a file with no title is NOT renamed to its taxonomy bucket", !bucketish,
    none ? none.proposed_filename : "(no proposal)");
  check("it keeps its original filename",
    !none || none.proposed_filename === "no title at all.doc",
    none ? none.proposed_filename : "(no proposal)");

  // --- but a real title must STILL work -----------------------------------
  const real = await proposalFor(files["real title.doc"].id);
  check("a unique descriptive title IS still used", Boolean(real) && /Bail|Marina/i.test(real.proposed_filename),
    real ? real.proposed_filename : "(none -- the guard is too aggressive)");

  console.log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
  if (failed > 0) process.exitCode = 1;
})().catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; }).finally(cleanup);
