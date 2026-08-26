// Every file gets a description, and the description is what you find it by.
//
// THE GUARANTEE
//
// After this stage has run, every active file has a row in file_descriptions.
// Not every row has a description -- some files genuinely cannot be described
// -- but every row says which, and why, in words. "No description" stops being
// a silence you cannot query and becomes a fact you can act on. That is the
// same bargain migration 032 struck for pipeline position, and it is what was
// missing from files.ai_summary: a NULL there could mean "not described yet",
// "AI is off", "the daily cap was reached", "nothing could read it", or "the
// stage crashed", and nothing distinguished them.
//
// WHERE A DESCRIPTION COMES FROM, IN ORDER OF PREFERENCE
//
//   inherited      a byte-identical twin was already described. Checked FIRST,
//                  before any evidence is gathered, because it is free.
//   image          the vision model looked at the picture. Usually already
//                  done on the OCR path, in which case it is adopted rather
//                  than re-requested.
//   video / audio  the multimodal model watched or listened.
//   document_text  a summary of text the document actually contained.
//   ocr_text       a summary of text OCR recovered from a scan.
//   metadata       nothing could read it. Built WITHOUT a model, from facts.
//
// The order is by how directly the evidence bears on what the file IS. Text
// the document contains beats text a machine guessed at from a picture of it,
// which beats the file's surroundings.
//
// WHAT IS NEVER DONE
//
// A description is never invented from a filename by a model. Where nothing
// can be read, the description is assembled here, in code, out of facts that
// are true by construction -- the type, the size, the folder, the date, and
// the words that are literally in the filename -- and its `source` says
// 'metadata' so the UI can present it as what it is. The reasoning is
// textQuality.js's and it applies with more force here: a description is not
// only displayed, it is embedded, and a confident invention becomes the thing
// the search matches on forever.
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const crypto = require("crypto");

const fileRepository = require("../repositories/fileRepository");
const fileContentRepository = require("../repositories/fileContentRepository");
const fileOcrRepository = require("../repositories/fileOcrRepository");
const fileDescriptionRepository = require("../repositories/fileDescriptionRepository");
const fileMetadataRepository = require("../repositories/fileMetadataRepository");
const classificationResultRepository = require("../repositories/classificationResultRepository");
const storageLocationRepository = require("../repositories/storageLocationRepository");
const subjectRepository = require("../repositories/subjectRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { getStorageServiceFor } = require("./storage/storageService");
const { streamToBuffer } = require("../utils/streamToBuffer");
const { resolveWithinRoot } = require("../utils/pathSafety");
const imageDetection = require("./imageDetection");
const pipelineState = require("./pipelineState");
const imageDescriber = require("./ai/imageDescriber");
const mediaDescriber = require("./ai/mediaDescriber");
const textSummariser = require("./ai/textSummariser");
const embeddingService = require("./ai/embeddingService");
const env = require("../config/env");

const STAGE = "describe";

/**
 * Every audit action that spends the same API key.
 *
 * There is deliberately NO ceiling on these (see the note on the removed
 * daily cap in config/env.js). The list is kept because "which of our actions
 * spend money" is a question worth being able to answer from the audit log,
 * and the dashboards read it. Reporting, not refusing.
 */
const BILLED_AI_ACTIONS = [
  "ai_description.called",
  "ai_classification.called",
  "ai_image_description.called",
];

// ---------------------------------------------------------------------------
// Facts, formatted for a person
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

/**
 * The words a filename actually contains, with the machinery stripped out.
 *
 * "WhatsApp Video 2026-07-16 at 00.16.15.mp4" carries exactly one useful word
 * and a timestamp. Separators become spaces, the extension goes, and long
 * digit runs go -- a date is already recorded properly on the file, and left
 * in the text it is noise that makes every file from the same day look alike
 * to the embedding.
 *
 * Returns null when nothing recognisable survives, which is the honest answer
 * for "IMG_0042" and is why the caller must handle a null.
 */
function humaniseFilename(filename) {
  const withoutExtension = String(filename || "").replace(/\.[a-z0-9]{1,8}$/i, "");

  // ORDER MATTERS, and getting it wrong is silent. Separators have to be
  // collapsed AFTER the date and time patterns are removed, not before:
  // turning "2026-07-16 at 00.16.15" into spaces first leaves eight loose
  // two-digit tokens that no later rule recognises as a timestamp, and the
  // "words" of the filename come out as "WhatsApp Video 07 16 at 00 16 15".
  const words = withoutExtension
    // Dates: 2026-07-16, 16/07/2026, 20260716
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b/g, " ")
    .replace(/\b\d{8,}\b/g, " ")
    // Times: 00.16.15, 13:20:57, 18h30
    .replace(/\b\d{1,2}[.:h]\d{2}(?:[.:]\d{2})?\b/g, " ")
    .replace(/[_\-.]+/g, " ")
    // Whatever numeric tokens are left standing alone. A number that survived
    // the patterns above is a counter or a timestamp fragment, not a word --
    // with one exception worth making: a bare four-digit YEAR is one of the
    // most useful things a filename can carry ("Tax Returns 2019"), and people
    // search by it. Numbers ATTACHED to a word ("cv2", "Q3") are always kept.
    .replace(/(^|\s)(\d+)(?=\s|$)/g, (match, _lead, digits) =>
      /^(19|20)\d{2}$/.test(digits) ? match : " ")
    .replace(/\s+/g, " ")
    .trim();

  // A leftover that is all digits says nothing. Length is NOT a useful test
  // beyond emptiness: "cv" is two characters and is the single most
  // identifying thing about cv.txt, which a minimum-length guard threw away.
  if (!words || /^\d+$/.test(words)) return null;
  return words;
}

/**
 * The description for a file whose contents nothing could read.
 *
 * A pure function of facts, deliberately: it is the one description path with
 * no model in it, it is the one most likely to be wrong if it speculates, and
 * being pure makes it directly testable without a network.
 *
 * It describes the file's SITUATION and says so. "A ZIP archive of 4.2 MB,
 * stored in Backups/2024" is true, useful for finding it, and cannot be
 * mistaken for a claim about what is inside.
 */
function buildMetadataDescription(file, { subjectPath = null, folder = null, reason = null } = {}) {
  const kind = describeKind(file);
  const size = formatBytes(file.size_bytes);
  const words = humaniseFilename(file.filename_current || file.filename_original);

  const facts = [kind, size].filter(Boolean).join(", ");
  const where = subjectPath
    ? `filed under ${subjectPath}`
    : folder
      ? `stored in ${folder}`
      : null;

  const opening = [facts, where].filter(Boolean).join(", ");
  const named = words ? ` Its filename reads "${words}".` : "";
  const dated = file.document_date
    ? ` Dated ${new Date(file.document_date).toISOString().slice(0, 10)}.`
    : "";

  const caveat = reason
    ? ` Nothing could read its contents (${reason}), so this describes where the file sits rather than what it says.`
    : " Nothing could read its contents, so this describes where the file sits rather than what it says.";

  return {
    caption: words ? `${kind}: ${words}` : kind,
    description: `${opening}.${named}${dated}${caveat}`,
  };
}

/** A plain-language name for the format, for the metadata description. */
function describeKind(file) {
  const ext = String(file.extension || "").toLowerCase().replace(/^\./, "");
  const KINDS = {
    zip: "ZIP archive", rar: "RAR archive", "7z": "7-Zip archive", tar: "TAR archive", gz: "Compressed archive",
    exe: "Windows program", msi: "Windows installer", dll: "Program library",
    pdf: "PDF document", doc: "Word document", docx: "Word document",
    xls: "Excel spreadsheet", xlsx: "Excel spreadsheet", ppt: "PowerPoint presentation", pptx: "PowerPoint presentation",
    txt: "Text file", csv: "CSV data file", json: "JSON data file", xml: "XML file",
    eml: "Email message", msg: "Email message",
  };
  if (KINDS[ext]) return KINDS[ext];
  if (imageDetection.isImage(file)) return `${ext.toUpperCase() || "Image"} image`;
  if (imageDetection.isVideo(file)) return `${ext.toUpperCase() || "Video"} video`;
  if (imageDetection.isAudio(file)) return `${ext.toUpperCase() || "Audio"} recording`;
  return ext ? `${ext.toUpperCase()} file` : "File";
}

/**
 * The exact text that gets embedded.
 *
 * Not the same string as the stored description, on purpose:
 *
 *   * The caption and the description are both included, because a caption is
 *     dense with exactly the words people search by.
 *   * The filename words and the folder are included, because people remember
 *     where a thing was as often as what it said.
 *   * A metadata description's BOILERPLATE is excluded. "Nothing could read
 *     its contents..." is identical on every such file, and embedding it makes
 *     all of them neighbours of each other -- a whole cluster of files that
 *     match every query equally, which is worse than not matching at all.
 */
function buildEmbeddingInput(file, { caption, description, source, subjectPath, keywords = [] }) {
  const parts = [];
  if (caption) parts.push(caption);

  if (description && source !== "metadata") parts.push(description);
  else if (source === "metadata") parts.push(describeKind(file));

  const words = humaniseFilename(file.filename_current || file.filename_original);
  if (words) parts.push(`Filename: ${words}`);
  if (subjectPath) parts.push(`Filed under: ${subjectPath}`);
  if (keywords.length) parts.push(keywords.join(", "));

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Getting at the bytes
// ---------------------------------------------------------------------------

/**
 * A real path on this disk for the file's bytes.
 *
 * Same shape as ocrService.materialize, and for the same reason: the describers
 * hand a path to something that opens a file (or streams it to an upload), so a
 * stream is not enough. A `direct` location is used in place; an agent-brokered
 * one is fetched to a temp file the caller must delete.
 */
async function materialize(file, storageLocation) {
  if (!storageLocation) throw new Error("The file's storage location no longer exists.");
  if (storageLocation.access_mode === "direct") {
    return { localPath: resolveWithinRoot(storageLocation.root_path, file.current_path), temporary: false };
  }
  const storageService = getStorageServiceFor(storageLocation);
  const buffer = await streamToBuffer(storageService.readStream(file.current_path));
  const ext = file.extension ? `.${file.extension}` : "";
  const tmp = path.join(os.tmpdir(), `atlas-describe-${crypto.randomBytes(8).toString("hex")}${ext}`);
  await fsp.writeFile(tmp, buffer);
  return { localPath: tmp, temporary: true };
}

async function ownerFolders(ownerUserId) {
  const rows = await subjectRepository.listForOwnerTree(ownerUserId);
  return rows.map((row) => row.materialized_path).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Producing the description
// ---------------------------------------------------------------------------

/**
 * Text the extraction stage judged usable, or "".
 *
 * The quality gate is not optional and not a nicety. textQuality.js exists
 * because this corpus produces confident-sounding garbage out of scanned and
 * legacy formats, and a description generated from that garbage is worse than
 * no description: it reads as authoritative, it is stored, and it is embedded.
 */
function usableText(content) {
  if (!content) return "";
  const quality = content.text_quality;
  if (quality && quality !== "ok") return "";
  return String(content.extracted_text || "").trim();
}

async function produceDescription(file, { storageLocation, subjectPath, folders }) {
  const isImage = file.is_image || imageDetection.isImage(file);
  const isMedia = imageDetection.isVideo(file) || imageDetection.isAudio(file);

  // --- images ------------------------------------------------------------
  //
  // The OCR path already describes pictures (ocrService.describeImage) and
  // writes the result to files.ai_summary. Where that has happened, adopt it:
  // asking the same model the same question about the same bytes to get the
  // same answer is money spent on nothing.
  if (isImage) {
    if (file.ai_summary && file.ai_entities?.source === "gemini-vision") {
      return {
        source: "image",
        caption: file.ai_short_title || null,
        description: file.ai_summary,
        detail: { adoptedFrom: "ocr-stage image description", describedAt: file.ai_classified_at },
      };
    }

    let materialized = null;
    try {
      materialized = await materialize(file, storageLocation);
      await auditLogRepository.record({
        action: "ai_description.called",
        entityType: "file", entityId: file.id,
        reason: "Sent the image to Gemini to describe what it shows.",
      });
      const result = await imageDescriber.describe(materialized.localPath, {
        extension: file.extension, folders,
      });
      if (!result.ok) {
        return { source: "failed", failureReason: result.reason, retryable: !result.permanent };
      }
      return {
        source: "image",
        caption: result.caption || null,
        description: result.summary || result.caption || null,
        detail: { kind: result.kind, containsText: result.containsText, confidence: result.confidence, model: env.ai.model },
      };
    } finally {
      if (materialized?.temporary) await fsp.rm(materialized.localPath, { force: true }).catch(() => {});
    }
  }

  // --- video and audio ---------------------------------------------------
  if (isMedia) {
    if (!mediaDescriber.isMedia(file.extension)) {
      return {
        source: "metadata",
        ...buildMetadataDescription(file, { subjectPath, folder: path.dirname(file.current_path || ""), reason: `${file.extension} is not a format the model can play` }),
        detail: { reason: "unsupported media format" },
      };
    }

    let materialized = null;
    try {
      materialized = await materialize(file, storageLocation);
      await auditLogRepository.record({
        action: "ai_description.called",
        entityType: "file", entityId: file.id,
        reason: "Sent the recording to Gemini to describe what it contains.",
      });
      const result = await mediaDescriber.describe(materialized.localPath, {
        extension: file.extension, folders,
      });
      if (!result.ok) {
        // A permanent media failure (too big, unplayable) still leaves a file
        // that has to be findable, so it falls back to the facts rather than
        // to nothing.
        if (result.permanent) {
          return {
            source: "metadata",
            ...buildMetadataDescription(file, { subjectPath, folder: path.dirname(file.current_path || ""), reason: result.reason }),
            detail: { attempted: "media", failure: result.reason },
          };
        }
        return { source: "failed", failureReason: result.reason, retryable: true };
      }
      return {
        source: result.mediaType === "audio" ? "audio" : "video",
        caption: result.caption || null,
        description: result.summary || result.caption || null,
        detail: {
          kind: result.kind, hasSpeech: result.hasSpeech, spokenLanguage: result.spokenLanguage,
          confidence: result.confidence, model: env.ai.model, usage: result.usage,
        },
      };
    } finally {
      if (materialized?.temporary) await fsp.rm(materialized.localPath, { force: true }).catch(() => {});
    }
  }

  // --- documents ---------------------------------------------------------
  const [content, ocr, metadata] = await Promise.all([
    fileContentRepository.findByFile(file.id),
    fileOcrRepository.findByFile(file.id),
    fileMetadataRepository.findByFile(file.id),
  ]);

  const embeddedTitle = metadata?.metadata?.title || "";
  const body = usableText(content);
  const ocrText = ocr?.status === "completed" ? String(ocr.text || "").trim() : "";

  // The classifier's summary, where it produced one, is a description of this
  // document's text by the same model this stage would ask. Adopt it.
  if (body && file.ai_summary && file.ai_classified_at) {
    return {
      source: "document_text",
      caption: file.ai_short_title || null,
      description: file.ai_summary,
      detail: {
        adoptedFrom: "classification AI tier",
        describedAt: file.ai_classified_at,
        entities: file.ai_entities || null,
      },
    };
  }

  const evidence = body || ocrText;
  if (evidence) {
    await auditLogRepository.record({
      action: "ai_description.called",
      entityType: "file", entityId: file.id,
      reason: body
        ? "Sent the document's extracted text to Gemini for a description."
        : "Sent the document's OCR text to Gemini for a description.",
    });

    const result = await textSummariser.summarise(evidence, {
      filename: file.filename_current, embeddedTitle,
    });
    if (!result.ok) {
      return { source: "failed", failureReason: result.reason, retryable: !result.permanent };
    }
    return {
      source: body ? "document_text" : "ocr_text",
      caption: result.caption || null,
      description: result.summary || result.caption || null,
      keywords: Array.isArray(result.keywords) ? result.keywords : [],
      detail: {
        confidence: result.confidence,
        documentLanguage: result.documentLanguage || null,
        evidenceChars: evidence.length,
        ocrConfidence: body ? null : ocr?.confidence ?? null,
        model: env.ai.model,
        usage: result.usage,
      },
    };
  }

  // --- nothing could be read --------------------------------------------
  const reason = content?.extraction_status === "failed"
    ? content.extraction_error || "text extraction failed"
    : content && content.text_quality && content.text_quality !== "ok"
      ? `the extracted text was judged ${content.text_quality}`
      : ocr && ocr.status === "failed"
        ? ocr.error_message || "OCR failed"
        : "no extractor could read this format";

  return {
    source: "metadata",
    ...buildMetadataDescription(file, {
      subjectPath, folder: path.dirname(file.current_path || ""), reason,
    }),
    detail: { reason, extractionStatus: content?.extraction_status || null, ocrStatus: ocr?.status || null },
  };
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/**
 * Give one file a description, and an embedding of it.
 *
 * @param {string} fileId
 * @param {object} [opts]
 * @param {boolean} [opts.force] - redo it even if a description already exists
 * @returns {Promise<object>} what happened, for the job result
 */
async function describeFile(fileId, { force = false } = {}) {
  const file = await fileRepository.findById(fileId);
  if (!file) return { skipped: true, reason: "file not found" };
  if (file.status === "deleted" || file.status === "missing") {
    return { skipped: true, reason: `the file is ${file.status}` };
  }

  const existing = await fileDescriptionRepository.findByFile(fileId);
  if (existing && !force && existing.source !== "failed") {
    // The description stands; the embedding might still be missing, because
    // the two are written separately and the second one can fail on its own.
    const embedded = await ensureEmbedding(file, existing);
    return { skipped: true, reason: "already described", source: existing.source, embedded };
  }

  // Where the file was BEFORE this stage touched it. Describing a file says
  // nothing about whether it has been dealt with, so this stage must not
  // improve its lifecycle position -- see restoreState below.
  const previousState = file.pipeline_state;

  await pipelineState.markProcessing(fileId, STAGE);

  try {
    // Free before anything else: identical bytes are the same document.
    const twin = await fileDescriptionRepository.findDescribedTwin(
      file.sha256_hash, file.id, file.owner_user_id
    );
    if (twin && !force) {
      const row = await fileDescriptionRepository.upsert(fileId, {
        ownerUserId: file.owner_user_id,
        description: twin.description,
        caption: twin.caption,
        source: "inherited",
        detail: { inheritedFrom: twin.file_id, originalSource: twin.source },
      });
      // The twin's vector describes the same text, so it is copied rather
      // than recomputed -- an embedding call saved on every duplicate.
      if (twin.embedding) {
        await fileDescriptionRepository.setEmbedding(fileId, {
          buffer: twin.embedding,
          dims: twin.embedding_dims,
          model: twin.embedding_model,
          input: twin.embedding_input,
        });
      }
      await mirrorToFile(file, row);
      await restoreState(fileId, previousState);
      return { ok: true, source: "inherited", inheritedFrom: twin.file_id };
    }

    const [storageLocation, subject, folders] = await Promise.all([
      storageLocationRepository.findById(file.storage_location_id),
      classificationResultRepository.findLatestSubjectForFile(file.id),
      ownerFolders(file.owner_user_id),
    ]);
    const subjectPath = subject?.materialized_path || null;

    const produced = await produceDescription(file, { storageLocation, subjectPath, folders });

    if (produced.source === "failed") {
      await fileDescriptionRepository.upsert(fileId, {
        ownerUserId: file.owner_user_id,
        source: "failed",
        failureReason: produced.failureReason,
        detail: produced.detail || {},
      });
      const outcome = produced.retryable
        ? await pipelineState.markFailed(fileId, STAGE, produced.failureReason)
        : await pipelineState.markFailed(fileId, STAGE, produced.failureReason, { permanent: true });
      return { ok: false, reason: produced.failureReason, terminal: outcome.terminal };
    }

    const row = await fileDescriptionRepository.upsert(fileId, {
      ownerUserId: file.owner_user_id,
      description: produced.description,
      caption: produced.caption,
      source: produced.source,
      detail: produced.detail || {},
    });

    await mirrorToFile(file, row);

    const embeddingInput = buildEmbeddingInput(file, {
      caption: produced.caption,
      description: produced.description,
      source: produced.source,
      subjectPath,
      keywords: produced.keywords || [],
    });
    const embedded = await embed(fileId, embeddingInput);

    await auditLogRepository.record({
      action: "ai_description.recorded",
      entityType: "file", entityId: fileId,
      newState: { source: produced.source, caption: produced.caption, embedded: embedded.ok },
      reason:
        produced.source === "metadata"
          ? "Described from the file's own facts -- nothing could read its contents, and nothing was invented."
          : `Described from ${produced.source.replace("_", " ")}.`,
    });

    await restoreState(fileId, previousState);
    return {
      ok: true, source: produced.source, caption: produced.caption,
      embedded: embedded.ok, embeddingReason: embedded.reason,
    };
  } catch (err) {
    await fileDescriptionRepository.upsert(fileId, {
      ownerUserId: file.owner_user_id,
      source: "failed",
      failureReason: err.message,
      detail: { threw: true },
    }).catch(() => { /* the original error is the one worth reporting */ });
    await pipelineState.markFailed(fileId, STAGE, err.message);
    throw err;
  }
}

/**
 * Put the file back in the lifecycle state this stage found it in.
 *
 * Describing a file is not progress through the pipeline -- it says what the
 * file IS, not whether anyone has dealt with it. Marking it `completed` on the
 * way out would be actively destructive:
 *
 *   * A photo rests at needs_user ("have a look and file it"). Describing it
 *     does not file it, and completing it would quietly remove it from the
 *     Photos backlog nobody had reviewed.
 *   * A document sitting in triage rests at needs_user for a reason that is
 *     still true after it acquires a description. Completing it would empty
 *     the triage queue without anyone deciding anything -- exactly the bounce
 *     migration 032's state machine was written to stop, in reverse.
 *
 * So only a file that was genuinely mid-pipeline (discovered/processing) is
 * completed here. Anything else goes back where it was.
 */
async function restoreState(fileId, previousState) {
  const { State } = pipelineState;
  if (!previousState || previousState === State.PROCESSING || previousState === State.DISCOVERED) {
    return pipelineState.markCompleted(fileId, STAGE);
  }
  return pipelineState.transition(fileId, previousState, { stage: STAGE });
}

/**
 * Mirror into files.ai_short_title / files.ai_summary.
 *
 * The Files page, the file detail modal, the preview pane, the Photos
 * workspace and the duplicate comparison all already read those columns.
 * Writing them keeps every one of those surfaces working with no change,
 * which is why this table could be added without touching them.
 *
 * A metadata description does NOT overwrite an existing ai_summary. That
 * column is presented as a description of CONTENT, and replacing "a scanned
 * invoice from Acme" with "a PDF document, 240 KB, stored in Scans" would be a
 * downgrade dressed as an update. It fills an empty one, because something
 * true beats nothing.
 *
 * Uses mirrorDescription rather than updateAiEnrichment so `ai_classified_at`
 * is left alone -- see the note on that repository method for why stamping it
 * here would eventually poison the adopt-instead-of-repay checks.
 */
async function mirrorToFile(file, row) {
  if (!row?.description) return;
  if (row.source === "metadata" && file.ai_summary) return;

  await fileRepository.mirrorDescription(file.id, {
    shortTitle: row.caption || null,
    summary: row.description,
  });
}

async function embed(fileId, input) {
  if (!input?.trim()) return { ok: false, reason: "nothing to embed" };
  const result = await embeddingService.embedDocument(input);
  if (!result.ok) return { ok: false, reason: result.reason };
  await fileDescriptionRepository.setEmbedding(fileId, {
    buffer: result.buffer, dims: result.dims, model: result.model, input,
  });
  return { ok: true };
}

/**
 * A description that exists but was never embedded -- because the API was
 * down, or the key was missing, or the cap was reached -- is invisible to the
 * semantic half of search. Re-checking on every visit is what lets those files
 * heal without a separate reconciliation job.
 */
async function ensureEmbedding(file, row) {
  if (row.embedding) return true;
  if (!row.description) return false;
  if (!embeddingService.available()) return false;

  const subject = await classificationResultRepository.findLatestSubjectForFile(file.id);
  const input = row.embedding_input || buildEmbeddingInput(file, {
    caption: row.caption,
    description: row.description,
    source: row.source,
    subjectPath: subject?.materialized_path || null,
  });
  const result = await embed(file.id, input);
  return result.ok;
}

/**
 * Sources where a model actually PERCEIVED the content, rather than reading
 * text someone else extracted from it.
 *
 * The distinction matters outside this module. `generateNamesProcessor` refuses
 * to propose a name when a file's text is unusable, on the reasoning that the
 * only information left is the filename, so any name would be invented. That
 * was true when extracted text was the only signal. It is not true of a
 * photograph: there is no text because it is a picture, and the describer
 * looked at it. "Two people embracing in a kitchen" was read off the image, not
 * hallucinated from noise.
 *
 * Deliberately NOT included:
 *   metadata       built in code from size/extension/date with no model at all
 *   document_text  text, which is exactly what the text-quality check governs
 *   ocr_text       ditto, and OCR noise is the original reason that check exists
 *   failed         no description was produced
 */
const PERCEIVED_SOURCES = Object.freeze(new Set(["image", "video", "audio"]));

/**
 * Did this description come from something looking at the file's content?
 *
 * @param {object|null} row - a file_descriptions row
 *
 * An inherited description is resolved to the source it was copied FROM: the
 * twin has byte-identical content, so a vision description of one is a vision
 * description of the other. Without this, the second copy of a photo would be
 * treated as unnameable purely because it arrived second.
 */
function isPerceivedDescription(row) {
  if (!row || !row.description) return false;
  const source =
    row.source === "inherited" ? row.detail?.originalSource || null : row.source;
  return PERCEIVED_SOURCES.has(source);
}

module.exports = {
  describeFile,
  // exported for tests and for the search layer's query-side reuse
  buildMetadataDescription, buildEmbeddingInput, humaniseFilename,
  describeKind, formatBytes, usableText,
  isPerceivedDescription, PERCEIVED_SOURCES,
  STAGE, BILLED_AI_ACTIONS,
};
