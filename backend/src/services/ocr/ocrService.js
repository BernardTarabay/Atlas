// OCR for one file, end to end: decide whether it is needed, get the bytes,
// rasterise if the format requires it, recognise, and record the result.
//
// WHERE THE RESULT GOES, AND WHY NOT INTO file_content
//
// OCR text is written to `file_ocr`, NOT to `file_content.extracted_text`.
// They are different claims: one is text the document actually contained, the
// other is a machine's reading of a picture. Collapsing them would let the
// naming pipeline treat a 42%-confidence guess at a blurry receipt as if it
// were an embedded text layer, and this codebase already learned that lesson
// the hard way -- see textQuality.js and the note in NEXT-SESSION.md about
// never letting the AI name a file from unreadable text.
//
// What OCR text IS used for: search, display in the Photos workspace, and as
// context the user can read before deciding where a document belongs. Naming
// from it requires the confidence to clear a bar, and even then it is offered
// as a proposal rather than applied.
const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");

const fileRepository = require("../../repositories/fileRepository");
const fileOcrRepository = require("../../repositories/fileOcrRepository");
const storageLocationRepository = require("../../repositories/storageLocationRepository");
const { getStorageServiceFor } = require("../storage/storageService");
const { streamToBuffer } = require("../../utils/streamToBuffer");
const { resolveWithinRoot } = require("../../utils/pathSafety");
const ocrEngine = require("./ocrEngine");
const pdfRasterizer = require("./pdfRasterizer");
const pipelineState = require("../pipelineState");
const imageDescriber = require("../ai/imageDescriber");
const subjectRepository = require("../../repositories/subjectRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");
const { enqueueJob } = require("../../queues");
const { JobType } = require("../../models/enums");
const env = require("../../config/env");

/**
 * Below this, the OCR text is kept and shown but is NOT offered to the naming
 * or classification pipeline.
 *
 * 0.55 is deliberately not a tuned number -- it is a stated policy. Tesseract's
 * per-word confidence on a clean scan sits well above it and on a photograph
 * of a crumpled receipt well below, and the consequence of being wrong in each
 * direction is asymmetric: too low a bar produces documents named after
 * nonsense, too high a bar produces documents the user has to name by hand.
 * The second is annoying; the first is the failure this project has explicitly
 * decided to avoid.
 */
const NAMING_CONFIDENCE_FLOOR = Number(process.env.OCR_NAMING_CONFIDENCE || "0.55");

/**
 * Does this file need OCR at all?
 *
 * An image always does -- there is no other way to get text out of one. A PDF
 * does only when extraction already produced nothing usable, because a PDF
 * with a real text layer is both cheaper and more accurate to read directly.
 */
function needsOcr(file, content) {
  if (file.is_image) return true;
  const ext = String(file.extension || "").toLowerCase();
  if (ext !== "pdf") return false;
  const text = content?.extracted_text || "";
  return content?.needs_ocr === true || text.trim().length < 100;
}

/**
 * Fetch the bytes to a real path on this disk.
 *
 * Tesseract is a separate process that reads a file, so a stream is not
 * enough. For a `direct` location the original path is used as-is -- copying
 * hundreds of megabytes to a temp file to read it would be absurd. For an
 * agent-brokered location the bytes arrive over the agent channel and are
 * written to a temp file, which the caller deletes.
 */
async function materialize(file, storageLocation) {
  if (storageLocation.access_mode === "direct") {
    return { localPath: resolveWithinRoot(storageLocation.root_path, file.current_path), temporary: false };
  }

  const storageService = getStorageServiceFor(storageLocation);
  const buffer = await streamToBuffer(storageService.readStream(file.current_path));
  const ext = file.extension ? `.${file.extension}` : "";
  const tmp = path.join(os.tmpdir(), `atlas-ocr-src-${crypto.randomBytes(8).toString("hex")}${ext}`);
  await fsp.writeFile(tmp, buffer);
  return { localPath: tmp, temporary: true };
}

/**
 * Run OCR on one file and record what happened.
 *
 * Always writes a `file_ocr` row, including on failure. A file that was
 * supposed to be OCR'd and has no row is indistinguishable from one that was
 * never queued, and "silently lost the file" is precisely what the
 * requirements forbid.
 */
async function runForFile(fileId, { languages, force = false } = {}) {
  const file = await fileRepository.findById(fileId);
  if (!file) return { skipped: true, reason: "file not found" };
  if (file.status !== "active") {
    await fileOcrRepository.upsert(fileId, {
      status: "failed",
      errorMessage: `The file is ${file.status}, so there are no bytes to read.`,
    });
    await fileRepository.setOcrStatus(fileId, "failed");
    return { skipped: true, reason: file.status };
  }

  const existing = await fileOcrRepository.findByFile(fileId);
  if (existing && existing.status === "completed" && !force) {
    // Reconcile the denormalised column before returning.
    //
    // Re-running the pipeline (a rescan, a manual re-queue) sets
    // files.ocr_status to 'queued' on the way in. Returning here without
    // putting it back left every already-read photo displaying "Queued"
    // forever on the Photos page, while file_ocr said 'completed' -- two
    // columns describing the same fact and disagreeing, which is exactly what
    // denormalisation costs when a code path forgets to pay it.
    await fileRepository.setOcrStatus(fileId, "completed");
    return { skipped: true, reason: "already done", text: existing.text };
  }

  await fileOcrRepository.upsert(fileId, { status: "running", startedAt: new Date() });
  await fileRepository.setOcrStatus(fileId, "running");
  await pipelineState.markProcessing(fileId, "ocr");

  const storageLocation = await storageLocationRepository.findById(file.storage_location_id);
  let materialized = null;

  try {
    materialized = await materialize(file, storageLocation);
    const ext = String(file.extension || "").toLowerCase();

    let pages = [];
    let rasterTemp = null;

    if (ocrEngine.isDirectlyReadable(ext)) {
      pages = [materialized.localPath];
    } else if (ext === "pdf") {
      const raster = await pdfRasterizer.rasterize(materialized.localPath);
      if (!raster.ok) return await fail(fileId, raster.reason, raster.permanent);
      pages = raster.pages;
      rasterTemp = raster.cleanup;
    } else {
      // Not an image and not a PDF -- OCR is not the right tool, and saying so
      // is better than producing an empty result that looks like a failure.
      return await fail(
        fileId,
        `OCR does not apply to .${ext} files -- it reads pictures of text, and this format is not one. ` +
        "If the file has no readable text, it needs a different extractor rather than OCR.",
        true
      );
    }

    const results = [];
    for (const page of pages) {
      results.push(await ocrEngine.recognizeImage(page, { languages }));
    }
    if (rasterTemp) await rasterTemp().catch(() => {});

    const succeeded = results.filter((r) => r.ok);
    if (succeeded.length === 0) {
      const first = results[0] || { reason: "OCR produced no result." };
      // "Engine not installed" gets its own status so the UI can offer the
      // install instructions instead of a generic failure, and so the file is
      // not counted as a document that cannot be read.
      if (first.unavailable) {
        await fileOcrRepository.upsert(fileId, { status: "unavailable", errorMessage: first.reason });
        await fileRepository.setOcrStatus(fileId, "unavailable");
        await pipelineState.markNeedsUser(fileId, "ocr", "No OCR engine is installed.");
        return { ok: false, unavailable: true, reason: first.reason };
      }
      return await fail(fileId, first.reason, first.permanent);
    }

    const text = succeeded.map((r) => r.text).filter(Boolean).join("\n\n").trim();
    const confidences = succeeded.map((r) => r.confidence).filter((c) => typeof c === "number");
    const confidence = confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : null;

    await fileOcrRepository.upsert(fileId, {
      status: "completed",
      engine: succeeded[0].engine,
      engineVersion: succeeded[0].engineVersion,
      languages: succeeded[0].languages,
      confidence,
      pageCount: pages.length,
      text,
      errorMessage: null,
      completedAt: new Date(),
    });
    await fileRepository.setOcrStatus(fileId, "completed");

    // Deliberately NEEDS_USER rather than COMPLETED when the text is thin or
    // the confidence is low. The machine has done its part; whether the result
    // is any good is a judgement that needs eyes on the picture, and the
    // Photos workspace exists precisely to make that quick.
    // What the picture is OF, alongside what it SAYS. Runs for genuine images
    // only -- a rasterised PDF page is a document and the text is the point.
    // Never allowed to fail the OCR job: a description is an enhancement, and
    // losing the text because the description call timed out would be a poor
    // trade.
    let described = null;
    if (file.is_image) {
      described = await describeImage(file, materialized.localPath).catch((err) => ({
        skipped: true, reason: err.message,
      }));
    }

    const usable = text.length >= 20 && (confidence === null || confidence >= NAMING_CONFIDENCE_FLOOR);
    if (usable) {
      await pipelineState.markCompleted(fileId, "ocr");
    } else {
      await pipelineState.markNeedsUser(
        fileId, "ocr",
        described?.ok
          // The far more useful message for a photograph: no text is the
          // EXPECTED answer, and the description is what identifies it.
          ? `A picture of ${described.caption.replace(/^(a|an|the)\s+/i, "")}. No text to read, so it needs filing by hand.`
          : confidence !== null && confidence < NAMING_CONFIDENCE_FLOOR
            ? `OCR read this at ${(confidence * 100).toFixed(0)}% confidence, below the ${(NAMING_CONFIDENCE_FLOOR * 100).toFixed(0)}% bar for naming from it. Have a look at the image.`
            : "OCR found very little text. Have a look at the image and name it yourself if needed."
      );
    }

    // Hand off to the describe stage last, once both halves of "what is this
    // image?" are on record.
    //
    // It is enqueued rather than called: it needs no bytes (it adopts the
    // description written just above, or summarises the OCR text for a
    // rasterised document) and its real work is the embedding, which is a
    // second network call this job should not wait on. It runs for scanned
    // DOCUMENTS too, not only photos -- OCR text is the only readable thing
    // such a file has, and without this pass it would never be described.
    await enqueueJob(JobType.DESCRIBE, { fileId }, { storageLocationId: file.storage_location_id })
      .catch((err) => console.warn(`[ocr] could not queue describe for ${fileId}: ${err.message}`));

    return {
      ok: true, fileId, confidence, pageCount: pages.length,
      caption: described?.caption || null,
      textLength: text.length, usableForNaming: usable,
    };
  } catch (err) {
    return await fail(fileId, err.message, false);
  } finally {
    if (materialized?.temporary) await fsp.rm(materialized.localPath, { force: true }).catch(() => {});
  }
}


/**
 * Ask the vision model what the picture is OF.
 *
 * WHY THIS LIVES ON THE OCR PATH
 *
 * They answer the two halves of the same question -- "what is this image?" --
 * and they run on the same file, at the same moment, from the same bytes.
 * Splitting them into separate jobs would mean materialising an
 * agent-brokered image twice and two round trips through the queue for one
 * document.
 *
 * They stay clearly distinct in the DATA, which is what actually matters:
 *   file_ocr.text        words that ARE in the picture (machine-read)
 *   files.ai_short_title what the picture is OF (machine-described)
 *   files.ai_summary     a fuller description, for deciding where to file it
 *
 * COST
 *
 * One Gemini call per image. There is no daily ceiling: the call is still
 * recorded as `ai_image_description.called` so spend remains auditable, but
 * nothing refuses it.
 */
async function describeImage(file, localPath) {
  if (!env.ai.enabled || !env.ai.apiKey) return { skipped: true, reason: "AI disabled" };

  // The folder list is the user's OWN tree, so a suggestion can only ever
  // point somewhere they actually have.
  const folders = (await subjectRepository.listForOwnerTree(file.owner_user_id))
    .map((row) => row.materialized_path);

  await auditLogRepository.record({
    action: "ai_image_description.called",
    entityType: "file",
    entityId: file.id,
    reason: "Sent the image to Gemini to describe what it shows.",
  });

  const result = await imageDescriber.describe(localPath, {
    extension: file.extension,
    folders,
  });
  if (!result.ok) return { skipped: true, reason: result.reason };

  // A suggested folder is only trusted if it is one we offered. The model is
  // asked for an exact path and usually gives one, but a hallucinated path
  // would otherwise be stored as a real placement.
  const suggested = result.suggestedSubject && folders.includes(result.suggestedSubject)
    ? result.suggestedSubject
    : null;

  await fileRepository.updateAiEnrichment(file.id, {
    shortTitle: result.caption || null,
    summary: result.summary || null,
    entities: {
      kind: result.kind,
      containsText: result.containsText,
      suggestedSubject: suggested,
      // Kept even when rejected, so "why did it suggest nothing" is answerable.
      suggestedSubjectRaw: result.suggestedSubject || null,
      confidence: result.confidence,
      source: "gemini-vision",
    },
  });

  await auditLogRepository.record({
    action: "ai_image_description.recorded",
    entityType: "file",
    entityId: file.id,
    newState: { caption: result.caption, kind: result.kind, suggestedSubject: suggested },
    reason:
      `Described as "${result.caption}". This is what the picture SHOWS -- distinct from any text ` +
      "OCR read out of it, and never used to identify individual people.",
  });

  return { ok: true, caption: result.caption, kind: result.kind, suggestedSubject: suggested };
}

async function fail(fileId, reason, permanent = false) {
  await fileOcrRepository.upsert(fileId, {
    status: "failed", errorMessage: reason, completedAt: new Date(),
  });
  await fileRepository.setOcrStatus(fileId, "failed");
  const outcome = await pipelineState.markFailed(fileId, "ocr", reason, { permanent });
  return { ok: false, reason, terminal: outcome.terminal };
}

module.exports = { needsOcr, runForFile, NAMING_CONFIDENCE_FLOOR };
