// Proves the reported bug is fixed: "I was getting a bunch of gibberish
// because of pictures".
//
// A scanned page extracts to noise, the AI tier reads the noise, and a
// confident invented title replaces a name a human chose. The guard has to
// hold at the naming stage specifically, because that is the last point
// before a real document gets a made-up name -- and it has to hold WITHOUT
// suppressing legitimate renames, which is the harder half.
//
//   node scripts/verify-gibberish-naming.js

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
const fileDescriptionRepository = require("../src/repositories/fileDescriptionRepository");
const subjectRepository = require("../src/repositories/subjectRepository");
const { closeAllQueues } = require("../src/queues");
const { dequeueFixtureJobs, pauseQueues, resumeQueues } = require("./_fixtureQueue");

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
      await p.query(`DELETE FROM rename_proposals      WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM classification_results WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_descriptions     WHERE file_id IN ${ids}`);
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
  // Hand the queues back to whatever worker is running, even if the script
  // threw part-way through.
  await resumeQueues().catch(() => {});
  await p.end(); await closeAllQueues();
}

const proposalsFor = async (fileId) =>
  (await p.query("SELECT * FROM rename_proposals WHERE file_id=$1", [fileId])).rows;

(async () => {
  /**
   * A LIVE WORKER WOULD REWRITE THESE FIXTURES MID-TEST.
   *
   * The fixture "PDFs" are 2 KB of the letter x, so a worker that picks them up
   * runs extract_text, fails, and overwrites the text_quality this script
   * carefully set -- including turning `real_report.pdf` from 'ok' into
   * something unusable, at which point the naming guard correctly skips it and
   * the assertion "a readable document IS still proposed" fails while the code
   * is perfectly healthy. Two checks in this script were failing for exactly
   * that reason, and it looked like a naming bug.
   *
   * The newer scripts have paused the queues from the start
   * (scripts/_fixtureQueue.js); this one predates the helper.
   */
  await pauseQueues();

  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-gibberish-"));
  const NAMES = [
    "scan_0042.pdf", "IMG_1234.pdf", "real_report.pdf", "titled_scan.pdf",
    // Added with the multimodal-title change -- see section 2 below.
    "holiday_photo.jpg", "scan_with_ocr_description.pdf", "unreadable_blob.bin",
  ];
  for (const n of NAMES) await fsp.writeFile(path.join(root, n), "x".repeat(2048));

  const admin = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
  const loc = await storageLocationService.create(
    { name: "Gibberish Test", type: "local", rootPath: root, accessMode: "direct" }, admin.id);
  locId = loc.id;
  await scanProcessor.handle({ storageLocationId: locId });
  await dequeueFixtureJobs(p, locId);

  const files = {};
  for (const r of (await p.query("SELECT * FROM files WHERE storage_location_id=$1", [locId])).rows) {
    files[r.filename_current] = r;
  }

  const subject = (await subjectRepository.list({ limit: 1 }))[0];
  const classify = (fileId) =>
    classificationResultRepository.create({
      fileId,
      classifiedSubjectId: subject.id,
      classifiedDocumentTypeId: null,
      confidenceLevel: "medium",
      confidenceScore: 0.6,
      method: "rule",
      rawOutput: { fixture: true },
    });

  // 1. A scan whose extraction produced noise, and no embedded title.
  await fileContentRepository.upsert(files["scan_0042.pdf"].id, {
    extractedText: "T h i s i s n o t r e a l t e x t a t a l l b r o k e n f o n t",
    textQuality: "gibberish",
    needsOcr: true,
  });
  await classify(files["scan_0042.pdf"].id);

  // 2. A scan with NO text layer at all.
  await fileContentRepository.upsert(files["IMG_1234.pdf"].id, {
    extractedText: "",
    textQuality: "no_text_layer",
    needsOcr: true,
  });
  await classify(files["IMG_1234.pdf"].id);

  // 3. A genuinely readable document -- this one MUST still be renamed, or
  //    the guard has broken the feature it was protecting.
  await fileContentRepository.upsert(files["real_report.pdf"].id, {
    extractedText:
      "Annual report of the provincial council covering the financial year, including the audited " +
      "accounts and the schedule of properties held by the community.",
    textQuality: "ok",
    needsOcr: false,
  });
  await classify(files["real_report.pdf"].id);

  // 4. Unreadable page content, but the file carries an embedded title the
  //    author wrote. That is real metadata and should still be used.
  await fileContentRepository.upsert(files["titled_scan.pdf"].id, {
    extractedText: "",
    textQuality: "no_text_layer",
    needsOcr: true,
  });
  await fileMetadataRepository.upsert(files["titled_scan.pdf"].id, {
    extractor: "pdf",
    extractorVersion: "test",
    metadata: { title: "Convention de Bail 2024" },
    extractionStatus: "completed",
  });
  await classify(files["titled_scan.pdf"].id);

  /**
   * 5-7. THE MULTIMODAL CASE, AND THE TWO THINGS IT MUST NOT LOOSEN.
   *
   * A photograph has no text because it is a photograph. The describe stage is
   * multimodal and actually looks at it, so the resulting title is read from
   * the content, not invented from noise -- and refusing to name from it left
   * every photo and video in an archive holding a good title the pipeline had
   * already paid for. The distinction is the description's SOURCE, not the
   * absence of text (services/descriptionService.PERCEIVED_SOURCES).
   *
   * The two negative cases are the important half. If either regresses, the
   * gibberish bug this whole script exists for is back.
   */
  const describe = (fileId, { source, description, detail = {} }) =>
    fileDescriptionRepository.upsert(fileId, {
      ownerUserId: admin.id, description, caption: null, source, detail,
    });
  const setTitle = (fileId, title) =>
    p.query("UPDATE files SET ai_short_title=$2 WHERE id=$1", [fileId, title]);

  // 5. A photo: no text, but the describer SAW it.
  await fileContentRepository.upsert(files["holiday_photo.jpg"].id, {
    extractedText: "", textQuality: "empty", needsOcr: false,
  });
  await describe(files["holiday_photo.jpg"].id, {
    source: "image", description: "Two people embracing in a modern kitchen at night.",
  });
  await setTitle(files["holiday_photo.jpg"].id, "Two people embracing in a kitchen");
  await classify(files["holiday_photo.jpg"].id);

  // 6. THE REGRESSION GUARD. A scan whose text is noise AND which has a
  //    description -- but one derived from that same noisy text. The title is
  //    only as trustworthy as what produced it, so this must still decline.
  await fileContentRepository.upsert(files["scan_with_ocr_description.pdf"].id, {
    extractedText: "T h i s i s n o t r e a l t e x t", textQuality: "gibberish", needsOcr: true,
  });
  await describe(files["scan_with_ocr_description.pdf"].id, {
    source: "ocr_text", description: "A document about thisisnotrealtext proceedings.",
  });
  await setTitle(files["scan_with_ocr_description.pdf"].id, "Thisisnotrealtext proceedings report");
  await classify(files["scan_with_ocr_description.pdf"].id);

  // 7. A file nothing can read, described by the code-built metadata path (no
  //    model involved -- it states size and extension). That is not perception
  //    and must not unlock naming either.
  await fileContentRepository.upsert(files["unreadable_blob.bin"].id, {
    extractedText: "", textQuality: "empty", needsOcr: false,
  });
  await describe(files["unreadable_blob.bin"].id, {
    source: "metadata", description: "Binary file, 2 KB. Nothing could read its contents.",
  });
  await setTitle(files["unreadable_blob.bin"].id, "Binary file 2 KB");
  await classify(files["unreadable_blob.bin"].id);

  console.log("\nrunning the naming stage on all of them:\n");
  for (const n of NAMES) await generateNamesProcessor.handle({ fileId: files[n].id });

  const gibberish = await proposalsFor(files["scan_0042.pdf"].id);
  check("a gibberish scan gets NO rename proposal", gibberish.length === 0,
    gibberish.map((x) => x.proposed_filename).join(", "));

  const noLayer = await proposalsFor(files["IMG_1234.pdf"].id);
  check("an image-only PDF gets NO rename proposal", noLayer.length === 0,
    noLayer.map((x) => x.proposed_filename).join(", "));

  const real = await proposalsFor(files["real_report.pdf"].id);
  check("a readable document IS still proposed for renaming", real.length === 1,
    real.map((x) => x.proposed_filename).join(", ") || "(none -- the guard is too aggressive)");

  const titled = await proposalsFor(files["titled_scan.pdf"].id);
  check("an unreadable file with an embedded title IS still named from that title",
    titled.length === 1 && /Bail/i.test(titled[0]?.proposed_filename || ""),
    titled.map((x) => x.proposed_filename).join(", ") || "(none)");

  // The names on disk and in the database must be untouched for the skipped
  // ones -- "keep the PDF's name as it is" is the actual requirement.
  const stillNamed = (await p.query(
    "SELECT filename_current, canonical_filename FROM files WHERE id = ANY($1)",
    [[files["scan_0042.pdf"].id, files["IMG_1234.pdf"].id]]
  )).rows;
  check("skipped files keep their original filename",
    stillNamed.every((r) => ["scan_0042.pdf", "IMG_1234.pdf"].includes(r.filename_current)),
    JSON.stringify(stillNamed.map((r) => r.filename_current)));
  check("skipped files have no canonical name written",
    stillNamed.every((r) => r.canonical_filename === null),
    JSON.stringify(stillNamed.map((r) => r.canonical_filename)));

  // And the reason has to be discoverable, not silent.
  const audit = (await p.query(
    `SELECT count(*)::int n FROM audit_logs
      WHERE action='rename.skipped_unreadable' AND entity_id = ANY($1)`,
    [[files["scan_0042.pdf"].id, files["IMG_1234.pdf"].id]]
  )).rows[0].n;
  check("the skip is recorded in the audit log, not silent", audit === 2, `${audit} entries`);

  // Named rather than counted: a bare count says "expected 3, got 4" and
  // leaves you to work out which file drifted, which is most of the debugging.
  const flagged = (await p.query(
    `SELECT f.filename_current FROM file_content fc JOIN files f ON f.id=fc.file_id
      WHERE f.storage_location_id=$1 AND fc.needs_ocr ORDER BY 1`, [locId])).rows.map((r) => r.filename_current);
  const expectedFlagged = ["IMG_1234.pdf", "scan_0042.pdf", "scan_with_ocr_description.pdf", "titled_scan.pdf"];
  check("exactly the files that would benefit from OCR are flagged for it",
    JSON.stringify(flagged) === JSON.stringify(expectedFlagged),
    flagged.join(", ") || "(none)");

  console.log("\na title read off the file itself is not an invented one:\n");

  const photo = await proposalsFor(files["holiday_photo.jpg"].id);
  check("a photo with a vision-derived title IS proposed for renaming",
    photo.length === 1 && /embracing/i.test(photo[0]?.proposed_filename || ""),
    photo.map((x) => x.proposed_filename).join(", ") || "(none -- photos are unnameable again)");

  const ocrDescribed = await proposalsFor(files["scan_with_ocr_description.pdf"].id);
  check("a scan described from its OWN noisy text is still NOT renamed",
    ocrDescribed.length === 0,
    ocrDescribed.map((x) => x.proposed_filename).join(", ") || "declined, correctly");

  const metadataDescribed = await proposalsFor(files["unreadable_blob.bin"].id);
  check("a file described only from metadata (no model) is still NOT renamed",
    metadataDescribed.length === 0,
    metadataDescribed.map((x) => x.proposed_filename).join(", ") || "declined, correctly");

  const photoRow = (await p.query(
    "SELECT filename_current, canonical_filename FROM files WHERE id=$1",
    [files["holiday_photo.jpg"].id])).rows[0];
  check("...and the photo's own file on disk is untouched, as always",
    photoRow.filename_current === "holiday_photo.jpg",
    `${photoRow.filename_current} (canonical: ${photoRow.canonical_filename || "not applied"})`);

  console.log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
  if (failed > 0) process.exitCode = 1;
})().catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; }).finally(cleanup);
