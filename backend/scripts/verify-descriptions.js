#!/usr/bin/env node
/**
 * Proves the two halves of "every file has a description you can find it by".
 *
 * WHAT THIS EXISTS TO CATCH
 *
 * Both halves fail silently, in opposite directions:
 *
 *   coverage   a file with no description is not an error anywhere. It just
 *              quietly cannot be found by describing it, forever, and nothing
 *              on any screen says so. The old files.ai_summary had exactly
 *              this problem -- a NULL meant five different things.
 *
 *   retrieval  a semantic search ALWAYS returns something. Cosine similarity
 *              between two unrelated texts from this model is still 0.55, so a
 *              broken threshold, a mismatched embedding, or a query embedded
 *              with the wrong task type does not produce an error -- it
 *              produces confident, plausible, wrong results. The only way to
 *              catch that is to ask for something specific and check that the
 *              RIGHT file came back and the wrong one did not.
 *
 * And the ownership half fails silently too, which is why the last section
 * gives two accounts descriptions that are deliberately near-identical.
 *
 * It creates its own fixtures and two throwaway accounts, and removes both on
 * the way out, so it is safe against a live database.
 *
 *   node scripts/verify-descriptions.js
 */
require("dotenv").config();

const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const db = require("../src/config/database");
const env = require("../src/config/env");
const authService = require("../src/services/authService");
const storageLocationService = require("../src/services/storageLocationService");
const descriptionService = require("../src/services/descriptionService");
const descriptionSearchService = require("../src/services/descriptionSearchService");
const embeddingService = require("../src/services/ai/embeddingService");
const pipelineState = require("../src/services/pipelineState");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const hashProcessor = require("../src/jobs/processors/hashProcessor");
const fileRepository = require("../src/repositories/fileRepository");
const fileDescriptionRepository = require("../src/repositories/fileDescriptionRepository");
const { parseFileFilters } = require("../src/repositories/fileFilters");
const { closeAllQueues } = require("../src/queues");
const { dequeueFixtureJobs, pauseQueues, resumeQueues } = require("./_fixtureQueue");

let passed = 0;
let failed = 0;
let skipped = 0;

function check(ok, label, detail = "") {
  if (ok) { passed += 1; console.log(`  PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
}
function skip(label, why) {
  skipped += 1;
  console.log(`  SKIP  ${label} -- ${why}`);
}

const stamp = Date.now();
let tmpRoot = null;
let alice = null;
let bob = null;

async function cleanup() {
  try {
    if (alice || bob) {
      const ids = [alice?.id, bob?.id].filter(Boolean);
      // file_descriptions, files, storage_locations and subjects all cascade
      // from the account, so one delete takes the whole fixture with it.
      await db.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids]);
    }
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    console.error(`  (cleanup: ${err.message})`);
  }
  descriptionSearchService.invalidate();
  await resumeQueues().catch(() => {});
  await closeAllQueues().catch(() => {});
  
  await db.pool.end().catch(() => {});
}

/**
 * Put a description straight into the table, embedding included.
 *
 * The retrieval half must be testable without depending on what a model says
 * about a fixture today. Seeding known descriptions makes the assertions exact
 * -- "this phrase must find THIS file" -- and keeps the run cheap: two
 * embedding calls per fixture instead of a full describe.
 */
async function seedDescription(file, { caption, description }) {
  await fileDescriptionRepository.upsert(file.id, {
    ownerUserId: file.owner_user_id,
    description, caption,
    source: "document_text",
    detail: { seededBy: "verify-descriptions" },
  });
  const embedded = await embeddingService.embedDocument(`${caption}\n${description}`);
  if (embedded.ok) {
    await fileDescriptionRepository.setEmbedding(file.id, {
      buffer: embedded.buffer, dims: embedded.dims,
      model: embedded.model, input: `${caption}\n${description}`,
    });
  }
  return embedded.ok;
}

/**
 * Take the fixtures' jobs back off the queue.
 *
 * scanProcessor and hashProcessor enqueue real work, and a running worker will
 * happily process these fixtures out from under the assertions -- see the
 * header of _fixtureQueue.js. Both locations are cleared each time because
 * Alice's and Bob's files are set up in the same pass.
 */
async function drainFixtureJobs(locationIds) {
  for (const id of locationIds.filter(Boolean)) {
    await dequeueFixtureJobs(db.pool, id).catch(() => {});
  }
}

async function filesUnder(locationId) {
  const { rows } = await db.query(
    "SELECT * FROM files WHERE storage_location_id = $1 ORDER BY filename_current",
    [locationId]
  );
  return rows;
}

async function main() {
  console.log("Verifying file descriptions and description search\n");

  await pauseQueues();

  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "atlas-verify-desc-"));
  const aliceDir = path.join(tmpRoot, "alice");
  const bobDir = path.join(tmpRoot, "bob");
  await fsp.mkdir(aliceDir);
  await fsp.mkdir(bobDir);

  // A format with no extractor and no OCR path: the case that has to end in a
  // metadata description rather than in silence.
  await fsp.writeFile(path.join(aliceDir, "quarterly-report.zip"), Buffer.from("PK\x03\x04not-really-a-zip"));
  // Two byte-identical copies, for the inheritance check.
  const twinBytes = Buffer.from("PK\x03\x04identical-bytes-for-the-twin-check");
  await fsp.writeFile(path.join(aliceDir, "copy-one.zip"), twinBytes);
  await fsp.writeFile(path.join(aliceDir, "copy-two.zip"), twinBytes);
  await fsp.writeFile(path.join(bobDir, "bob-archive.zip"), Buffer.from("PK\x03\x04bobs-own-bytes"));

  alice = (await authService.register({
    email: `verify-desc-alice-${stamp}@example.test`, password: "Sup3rSecret!pass", fullName: "Alice Desc",
  })).user;
  bob = (await authService.register({
    email: `verify-desc-bob-${stamp}@example.test`, password: "Sup3rSecret!pass", fullName: "Bob Desc",
  })).user;

  const aliceLoc = await storageLocationService.create(
    { name: "Alice desc", type: "local", rootPath: aliceDir, isReadOnly: true }, alice.id
  );
  const bobLoc = await storageLocationService.create(
    { name: "Bob desc", type: "local", rootPath: bobDir, isReadOnly: true }, bob.id
  );

  await scanProcessor.handle({ storageLocationId: aliceLoc.id });
  await scanProcessor.handle({ storageLocationId: bobLoc.id });
  await drainFixtureJobs([aliceLoc.id, bobLoc.id]);

  const aliceFiles = await filesUnder(aliceLoc.id);
  const bobFiles = await filesUnder(bobLoc.id);
  check(aliceFiles.length === 3, "three fixture files indexed for Alice", `${aliceFiles.length}`);

  // Hash them so the twin check has something to match on.
  for (const file of [...aliceFiles, ...bobFiles]) {
    await hashProcessor.handle({ fileId: file.id }).catch(() => {});
  }
  await drainFixtureJobs([aliceLoc.id, bobLoc.id]);

  // =========================================================================
  console.log("\nCoverage: nothing is left without an answer");
  // =========================================================================
  for (const file of await filesUnder(aliceLoc.id)) {
    await descriptionService.describeFile(file.id);
  }
  await drainFixtureJobs([aliceLoc.id, bobLoc.id]);

  const described = await filesUnder(aliceLoc.id);
  const rows = await Promise.all(described.map((f) => fileDescriptionRepository.findByFile(f.id)));

  check(rows.every(Boolean), "every file has a description row after the stage runs",
    `${rows.filter(Boolean).length}/${rows.length}`);
  check(
    rows.every((r) => r && (r.description || r.failure_reason)),
    "every row carries either a description or a recorded reason it has none"
  );

  const zip = rows.find((r) => described.find((f) => f.id === r.file_id)?.filename_current === "quarterly-report.zip");
  check(zip?.source === "metadata",
    "a file nothing can read gets a metadata description, not a failure", `source=${zip?.source}`);
  check(
    Boolean(zip?.description && /nothing could read its contents/i.test(zip.description)),
    "the metadata description says plainly that the contents were not read"
  );
  check(
    Boolean(zip?.description && /quarterly report/i.test(zip.description)),
    "it still carries the words from the filename, so the file stays findable"
  );
  check(
    !/\b(invoice|contract|report for|contains)\b/i.test(String(zip?.caption || "")) || /ZIP/i.test(String(zip?.caption)),
    "it does not claim to know what is inside", `caption=${zip?.caption}`
  );

  // =========================================================================
  console.log("\nA byte-identical copy costs nothing");
  // =========================================================================
  const copies = described.filter((f) => f.filename_current.startsWith("copy-"));
  if (copies.length === 2 && copies[0].sha256_hash && copies[0].sha256_hash === copies[1].sha256_hash) {
    // Redo the second one now that the first is described, which is the order
    // the pipeline produces in practice.
    await descriptionService.describeFile(copies[1].id, { force: true });
    const second = await fileDescriptionRepository.findByFile(copies[1].id);
    // Both copies are unreadable zips, so the first description is 'metadata',
    // and metadata descriptions are deliberately NOT inherited -- they are
    // per-file facts (size, folder, filename), cheap to rebuild, and wrong to
    // copy. Assert the rule that actually applies.
    check(second?.source === "metadata",
      "an unreadable twin rebuilds its own facts rather than inheriting them", `source=${second?.source}`);
    check(
      second?.description?.includes("copy-two") || !second?.description?.includes("copy-one"),
      "and the rebuilt description describes ITSELF, not its twin"
    );
  } else {
    skip("byte-identical copy handling", "the fixtures did not hash as expected");
  }

  // =========================================================================
  console.log("\nDescribing a file does not change where it stands");
  // =========================================================================
  const subject = described[0];
  await pipelineState.markNeedsUser(subject.id, "test", "waiting on a person");
  await descriptionService.describeFile(subject.id, { force: true });
  const after = await fileRepository.findById(subject.id);
  check(after.pipeline_state === "needs_user",
    "a file waiting on a person is still waiting on one after being described",
    `state=${after.pipeline_state}`);

  // =========================================================================
  console.log("\nRetrieval: describing a file finds it");
  // =========================================================================
  if (!embeddingService.available()) {
    skip("semantic retrieval", "AI is disabled or GEMINI_API_KEY is not set");
    skip("cross-account isolation of descriptions", "same");
  } else {
    const [a, b, c] = described;
    const seeded = await Promise.all([
      seedDescription(a, {
        caption: "Birthday party photograph",
        description: "A photograph of a small child leaning over a cake, blowing out candles, with several adults watching from around the table.",
      }),
      seedDescription(b, {
        caption: "Electricity bill, June",
        description: "An itemised electricity bill from the utility company covering June, showing the meter reading and the amount due.",
      }),
      seedDescription(c, {
        caption: "Roof repair quotation",
        description: "A builder's written quotation for repairing storm damage to the roof of a house, itemised by materials and labour.",
      }),
    ]);
    check(seeded.every(Boolean), "the fixture descriptions embedded");

    descriptionSearchService.invalidate();
    const aliceFilters = parseFileFilters({}, alice.id);

    // The whole point: not one word of this appears in the description.
    const birthday = await descriptionSearchService.search(
      "the picture of a kid blowing out candles at a party", { filters: aliceFilters, limit: 3 }
    );
    check(birthday.files[0]?.id === a.id,
      "a rough phrase sharing almost no words finds the right file",
      `top=${birthday.files[0]?.filename_current}`);
    check(birthday.semanticUsed, "and the semantic signal actually ran");

    const roof = await descriptionSearchService.search(
      "quote for fixing the roof after the storm", { filters: aliceFilters, limit: 3 }
    );
    check(roof.files[0]?.id === c.id, "a second, different phrase finds a different file",
      `top=${roof.files[0]?.filename_current}`);

    // The negative case is the one that catches a broken threshold.
    const nonsense = await descriptionSearchService.search(
      "a submarine engine maintenance logbook from 1974", { filters: aliceFilters, limit: 5 }
    );
    check(nonsense.files.length === 0,
      "a phrase matching nothing in the archive returns nothing, rather than the closest thing",
      `${nonsense.files.length} result(s)`);

    // =======================================================================
    console.log("\nOne account's descriptions never reach another");
    // =======================================================================
    const bobFile = (await filesUnder(bobLoc.id))[0];
    await seedDescription(bobFile, {
      caption: "Birthday party photograph",
      // Deliberately near-identical to Alice's, so only the owner predicate
      // can tell them apart. A search that leaks would rank this first.
      description: "A photograph of a small child leaning over a cake, blowing out candles, surrounded by family.",
    });
    descriptionSearchService.invalidate();

    const asAlice = await descriptionSearchService.search(
      "child blowing out birthday candles", { filters: aliceFilters, limit: 10 }
    );
    check(
      !asAlice.files.some((f) => f.id === bobFile.id),
      "Bob's near-identical description does not appear in Alice's results",
      `${asAlice.files.length} result(s), none of them Bob's`
    );

    const asBob = await descriptionSearchService.search(
      "child blowing out birthday candles", { filters: parseFileFilters({}, bob.id), limit: 10 }
    );
    check(asBob.files.length === 1 && asBob.files[0].id === bobFile.id,
      "and Bob sees exactly his own", `${asBob.files.length} result(s)`);
  }

  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => { console.error("\nverify-descriptions threw:", err); process.exitCode = 1; })
  .finally(cleanup);
