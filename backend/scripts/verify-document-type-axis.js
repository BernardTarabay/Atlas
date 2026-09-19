// Proves the document-type axis is no longer (a) assigned on noise and
// (b) erased by ordinary use.
//
// WHAT WENT WRONG, as found in the live database:
//
//   13 document types were seeded. Exactly ONE was ever assigned by the rule
//   tier -- "Book", to a 36,000-character personal narrative, scoring 2 on the
//   substrings inside "playbook" and "fantasy books". And the one file that
//   ever carried a type no longer had it, because a later row erased it.
//
// Three separate defects produced that, and this script covers all three:
//
//   1. The keyword list was [name, code], which for every single-word type is
//      the SAME WORD TWICE, so one occurrence scored 2 -- exactly the
//      threshold classifyProcessor requires for MEDIUM, and which its own
//      comment describes as needing "two independent body matches".
//   2. Matching was substring, so "book" hit inside "playbook"/"notebook".
//   3. Subject and document type share one row and every reader takes the
//      LATEST row, so any writer that passed null for the axis it wasn't
//      changing deleted that axis. Filing a document under a subject -- the
//      most common action in the app -- erased its document type.
//
//     node scripts/verify-document-type-axis.js
//
// Reads the real corpus for (1) and (2). For (3) it creates one fixture file
// row, exercises the repository invariant, and deletes it. It writes no files
// to disk and enqueues no jobs, so it does not need the worker stopped -- but
// it does write to the database, like the other verify-* scripts.
//
// A fourth section checked that the Types browse page's per-type counts agreed
// with the file list they linked to. That page is gone and so is its endpoint;
// the axis itself, which is what the three defects above were actually about,
// is still here and still checked.
const { Pool } = require("pg");
const env = require("../src/config/env");
const taxonomyMatcher = require("../src/services/taxonomyMatcher");
const classificationResultRepository = require("../src/repositories/classificationResultRepository");
const { ConfidenceLevel, ClassificationMethod } = require("../src/models/enums");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

let fixtureFileId = null;
let fixtureLocationId = null;

async function cleanup() {
  try {
    if (fixtureFileId) {
      await p.query("DELETE FROM classification_results WHERE file_id = $1", [fixtureFileId]);
      await p.query("DELETE FROM files WHERE id = $1", [fixtureFileId]);
    }
    // No storage location to remove: the fixture borrows an existing one.
  } catch (e) {
    console.log(`   (cleanup) ${e.message}`);
  }
}

async function realCorpusChecks() {
  console.log("\n1. The real text that produced the bogus classification");

  const docTypes = (await p.query("SELECT id, code, name FROM document_types")).rows;
  check("document types are seeded", docTypes.length > 0, `${docTypes.length} types`);

  const rows = (await p.query(
    `SELECT f.filename_original, f.filename_current, fc.extracted_text
       FROM files f JOIN file_content fc ON fc.file_id = f.id
      WHERE fc.extracted_text IS NOT NULL AND length(fc.extracted_text) > 500`
  )).rows;

  if (!rows.length) {
    console.log("   SKIP  no extracted text in this database to test against");
    return;
  }

  // Every real file, scored exactly the way the processor now scores it:
  // filename and extension only, body deliberately withheld.
  const typed = [];
  for (const row of rows) {
    const filenameText = `${row.filename_original} ${row.filename_current}`.toLowerCase();
    const m = taxonomyMatcher.bestMatch(docTypes, { filenameText, bodyText: "" });
    const ext = taxonomyMatcher.typeFromExtension((row.filename_current.split(".").pop() || ""), docTypes);
    if (ext || m.entity) typed.push(`${row.filename_original} -> ${(ext || m.entity).code}`);
  }
  console.log(`   (${rows.length} files with extracted text; ${typed.length} typed from name/extension)`);
  typed.forEach((t) => console.log(`     ${t}`));

  const narrative = rows.find((r) => /architecture of almost/i.test(r.filename_original));
  if (narrative) {
    const body = narrative.extracted_text.toLowerCase().slice(0, 20000);

    // What the processor actually passes now.
    const asProcessed = taxonomyMatcher.bestMatch(docTypes, {
      filenameText: `${narrative.filename_original} ${narrative.filename_current}`.toLowerCase(),
      bodyText: "",
    });
    check(
      'the narrative that was typed "Book" now gets no type at all',
      asProcessed.entity === null && taxonomyMatcher.typeFromExtension("docx", docTypes) === null,
      asProcessed.entity ? `still ${asProcessed.entity.code}` : "no type, as it should be"
    );

    // The old substring bug specifically: "playbook" must not match "Book".
    const bookOnly = taxonomyMatcher.bestMatch(docTypes.filter((d) => d.code === "Book"), {
      filenameText: "",
      bodyText: body,
    });
    check(
      '"playbook" and "fantasy books" no longer match the type Book',
      bookOnly.entity === null,
      bookOnly.entity ? `matched ${bookOnly.matchedTerms.join(", ")}` : "no match, correctly"
    );

    // And show WHY body text is withheld rather than merely tightened: real
    // whole words are in there, correctly matched, and still the wrong answer.
    const bodyScored = taxonomyMatcher.bestMatch(docTypes, { filenameText: "", bodyText: body });
    check(
      "...and the body's real type words are ignored by policy, not by luck",
      bodyScored.entity !== null,
      bodyScored.entity
        ? `body says "${bodyScored.matchedTerms.join(", ")}" (${bodyScored.entity.code}) -- about, not is`
        : "no type words in body"
    );
  }

  // The extension route: the one signal that cannot be wrong about KIND.
  check(
    "a .pptx is typed Presentation from its extension alone",
    taxonomyMatcher.typeFromExtension("pptx", docTypes)?.code === "Presentation"
  );
  check(
    "a .docx is deliberately not typed from its extension",
    taxonomyMatcher.typeFromExtension("docx", docTypes) === null
  );

  // The other half: a document whose type IS stated must still be found.
  const invoice = taxonomyMatcher.bestMatch(docTypes, {
    filenameText: "acme-invoice-2024-114.pdf",
    bodyText: "invoice number inv-2024-114. payment due within 30 days.",
  });
  check("a real invoice is still typed Invoice", invoice.entity?.code === "Invoice", `score ${invoice.score}`);
}

async function carryForwardChecks() {
  console.log("\n2. Writing one axis must not erase the other");

  // Reuses an existing storage location rather than creating one: this fixture
  // needs a valid FK and nothing else, and inventing a location row means
  // inventing an owner for it too. The file row is deleted in cleanup; no
  // bytes are written to disk and the location is left exactly as found.
  const existingLocation = (await p.query("SELECT id FROM storage_locations ORDER BY created_at LIMIT 1")).rows[0];
  if (!existingLocation) {
    console.log("   SKIP  no storage location in this database to hang a fixture file on");
    return;
  }

  const uniquePath = `__verify_doctype_axis__/${Date.now()}.pdf`;
  const file = await p.query(
    `INSERT INTO files (storage_location_id, filename_original, filename_current,
                        size_bytes, original_path, current_path, status)
     VALUES ($1, 'fixture.pdf', 'fixture.pdf', 1, $2, $2, 'active') RETURNING id`,
    [existingLocation.id, uniquePath]
  );
  fixtureFileId = file.rows[0].id;

  const subjectId = (await p.query("SELECT id FROM subjects LIMIT 1")).rows[0]?.id;
  const typeIds = (await p.query("SELECT id, code FROM document_types ORDER BY code LIMIT 2")).rows;
  if (!subjectId || typeIds.length < 2) {
    console.log("   SKIP  taxonomy not seeded in this database");
    return;
  }
  const [typeA, typeB] = typeIds;

  const latest = async () => {
    const r = await classificationResultRepository.findLatestForFile(fixtureFileId);
    return { subject: r?.classified_subject_id || null, type: r?.classified_document_type_id || null };
  };

  // A human sets a document type from the Files page.
  await classificationResultRepository.createPartial({
    fileId: fixtureFileId,
    classifiedDocumentTypeId: typeA.id,
    confidenceLevel: ConfidenceLevel.HIGH,
    confidenceScore: 1.0,
    method: ClassificationMethod.MANUAL,
    rawOutput: { reason: "fixture: type set by hand" },
  });
  check("setting a type records it", (await latest()).type === typeA.id);

  // Then the file is filed under a subject. THIS is what used to wipe it.
  await classificationResultRepository.createPartial({
    fileId: fixtureFileId,
    classifiedSubjectId: subjectId,
    confidenceLevel: ConfidenceLevel.HIGH,
    confidenceScore: 1.0,
    method: ClassificationMethod.MANUAL,
    rawOutput: { reason: "fixture: filed under a subject" },
  });
  const afterMove = await latest();
  check("filing under a subject keeps the document type", afterMove.type === typeA.id);
  check("filing under a subject records the subject", afterMove.subject === subjectId);

  // And the mirror image: setting a type must not drop the subject.
  await classificationResultRepository.createPartial({
    fileId: fixtureFileId,
    classifiedDocumentTypeId: typeB.id,
    confidenceLevel: ConfidenceLevel.HIGH,
    confidenceScore: 1.0,
    method: ClassificationMethod.MANUAL,
    rawOutput: { reason: "fixture: type changed by hand" },
  });
  const afterRetype = await latest();
  check("changing the type keeps the subject", afterRetype.subject === subjectId);
  check("changing the type records the new type", afterRetype.type === typeB.id);

  // A classifier pass that recognises nothing must not undo human work.
  await classificationResultRepository.createPartial({
    fileId: fixtureFileId,
    confidenceLevel: ConfidenceLevel.LOW,
    confidenceScore: 0,
    method: ClassificationMethod.RULE,
    rawOutput: { reason: "fixture: no keyword matches" },
  });
  const afterRule = await latest();
  check("a no-match classifier pass preserves both axes", afterRule.subject === subjectId && afterRule.type === typeB.id);

  // Clearing must still be possible -- carry-forward must not become a trap.
  await classificationResultRepository.createPartial({
    fileId: fixtureFileId,
    classifiedDocumentTypeId: null,
    confidenceLevel: ConfidenceLevel.HIGH,
    confidenceScore: 1.0,
    method: ClassificationMethod.MANUAL,
    rawOutput: { reason: "fixture: type explicitly cleared" },
  });
  const afterClear = await latest();
  check("an explicit null still clears the type", afterClear.type === null);
  check("clearing the type leaves the subject alone", afterClear.subject === subjectId);
}

(async () => {
  console.log("Verifying the document-type axis\n" + "=".repeat(38));
  try {
    await realCorpusChecks();
    await carryForwardChecks();
  } catch (e) {
    failed += 1;
    console.log(`\n   ERROR ${e.stack}`);
  } finally {
    await cleanup();
    await p.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
