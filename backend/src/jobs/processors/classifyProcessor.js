// Rule-based baseline classifier (spec §11). Keyword-matches filename +
// extracted text against the seeded taxonomy/document types. This is
// deliberately simple and transparent (every match is explainable in
// raw_output) rather than a black-box model -- a stronger classifier
// (ML/LLM) can be swapped in later behind the same ClassificationResult
// shape (method: 'ml'|'llm') without changing anything downstream, per
// Phase 1 §1.5's confidence-gating design.
const fileRepository = require("../../repositories/fileRepository");
const fileMetadataRepository = require("../../repositories/fileMetadataRepository");
const fileContentRepository = require("../../repositories/fileContentRepository");
const subjectRepository = require("../../repositories/subjectRepository");
const documentTypeRepository = require("../../repositories/documentTypeRepository");
const classificationResultRepository = require("../../repositories/classificationResultRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");
const { enqueueJob } = require("../../queues");
const { ConfidenceLevel, ClassificationMethod, JobType } = require("../../models/enums");
const env = require("../../config/env");
const geminiClassifier = require("../../services/ai/geminiClassifier");
const taxonomyMatcher = require("../../services/taxonomyMatcher");

const CONFIDENCE_ORDER = { low: 0, medium: 1, high: 2 };

/** Escalate when the rule-based pass landed below the configured confidence
 * floor (default "high" -- i.e. escalate low/medium only). Set
 * AI_ESCALATE_BELOW_CONFIDENCE=always to run Gemini on every file
 * regardless of rule-based confidence, as a second-opinion check even on
 * clean keyword matches -- generateNamesProcessor still only proposes a
 * rename from whichever classification_results row is most recent, so if
 * Gemini disagrees with (or is less confident than) a "high" rule-based
 * match, that disagreement correctly holds the rename back rather than
 * blindly trusting either pass alone. */
function shouldEscalateToAi(ruleConfidenceLevel) {
  if (env.ai.escalateBelowConfidence === "always") return true;
  const threshold = CONFIDENCE_ORDER[env.ai.escalateBelowConfidence] ?? CONFIDENCE_ORDER.high;
  return CONFIDENCE_ORDER[ruleConfidenceLevel] < threshold;
}

/**
 * The LLM escalation tier (docs/09-ai-classification.md). One cost lever
 * before ever calling out to Gemini: reuse a sibling file's AI result when
 * the content hash already matches one that's been classified, so duplicates
 * never cost a second call.
 *
 * There is deliberately no call cap here any more. The daily cap that used to
 * be the second lever is gone (config/env.js explains why -- it was counted
 * three inconsistent ways and stranded 5,730 files); spend is reported to the
 * audit log rather than refused.
 *
 * A failed or skipped AI pass never takes down the pipeline -- the rule-based
 * classification_results row created by handle() above already stands on its
 * own either way.
 */
async function runAiEscalation({ file, bodyText, allSubjects, allDocTypes, embeddedTitle }) {
  try {
    // Nothing to read. With no usable text and no embedded title the model
    // would be guessing from a filename alone -- which is precisely how a
    // scanned "IMG_0042.pdf" acquires an authoritative-sounding invented
    // title. Skipping also saves an API call per unreadable file, and on a
    // drive full of scans that is most of them.
    if (!String(bodyText || "").trim() && !embeddedTitle) {
      await auditLogRepository.record({
        action: "ai_classification.skipped",
        entityType: "file",
        entityId: file.id,
        reason:
          "No usable text and no embedded title -- the AI tier had nothing to read, so it was not called. " +
          "The file keeps its existing name.",
      });
      return;
    }

    if (file.sha256_hash) {
      const sibling = await fileRepository.findClassifiedSiblingByHash(
        file.sha256_hash, file.id, file.owner_user_id
      );
      if (sibling) {
        await fileRepository.updateAiEnrichment(file.id, {
          shortTitle: sibling.ai_short_title,
          summary: sibling.ai_summary,
          entities: sibling.ai_entities,
        });
        const siblingResults = await classificationResultRepository.listProposedForFile(sibling.id);
        const siblingLlmResult = siblingResults.find((r) => r.method === ClassificationMethod.LLM);
        if (siblingLlmResult) {
          await classificationResultRepository.create({
            fileId: file.id,
            classifiedSubjectId: siblingLlmResult.classified_subject_id,
            classifiedDocumentTypeId: siblingLlmResult.classified_document_type_id,
            confidenceLevel: siblingLlmResult.confidence_level,
            confidenceScore: siblingLlmResult.confidence_score,
            method: ClassificationMethod.LLM,
            rawOutput: {
              reusedFromFileId: sibling.id,
              reason: "identical content hash (exact duplicate) -- reused sibling's AI classification instead of calling Gemini again",
            },
          });
        }
        return;
      }
    }

    const classified = await geminiClassifier.classify({
      filename: file.filename_current,
      bodyText,
      subjects: allSubjects,
      documentTypes: allDocTypes,
      embeddedTitle,
    });

    // `?.id` without a `|| null` fallback on purpose: it yields undefined when
    // the model declined to pick, and createPartial reads undefined as "not
    // speaking to this axis". The prompt explicitly tells the model to answer
    // null rather than force a bad match, so declining is the DESIGNED
    // behaviour and happens often -- writing that null through would have let
    // the AI tier erase a type a human had set by hand. "I don't know" is not
    // "it is nothing".
    await classificationResultRepository.createPartial({
      fileId: file.id,
      classifiedSubjectId: classified.subject?.id,
      classifiedDocumentTypeId: classified.documentType?.id,
      confidenceLevel: classified.confidenceLevel,
      confidenceScore: { low: 0.3, medium: 0.6, high: 0.9 }[classified.confidenceLevel],
      method: ClassificationMethod.LLM,
      rawOutput: {
        shortTitle: classified.shortTitle,
        summary: classified.summary,
        entities: classified.entities,
        // The model's literal taxonomy picks, stored whether or not they
        // resolved -- see geminiClassifier.classify. A code that does not
        // match the candidate list is a prompt/seed-data problem worth
        // seeing, not something to drop on the floor.
        picks: classified.picks,
        usage: classified.usage,
        interactionId: classified.interactionId,
      },
    });

    await fileRepository.updateAiEnrichment(file.id, {
      shortTitle: classified.shortTitle,
      summary: classified.summary,
      entities: classified.entities,
    });

    await auditLogRepository.record({
      action: "ai_classification.called",
      entityType: "file",
      entityId: file.id,
      newState: { usage: classified.usage },
      status: "success",
    });
  } catch (err) {
    await auditLogRepository.record({
      action: "ai_classification.called",
      entityType: "file",
      entityId: file.id,
      reason: err.message,
      status: "failed",
    });

    // Swallowing is correct for an UPSTREAM failure -- Gemini being down, a
    // timeout, a 429 -- because the rule-based result already stands and the
    // file is classified either way. That is what this catch was written for.
    //
    // It was swallowing more than that. The try block also covers the three
    // database writes above, so a failure to store a classification the API
    // call had already been billed for, or to write the AI enrichment fields,
    // was recorded as "ai_classification failed" and the job then reported
    // SUCCESS. Nothing retried, and the money was spent for a result that was
    // never saved.
    //
    // A DB error is not an AI-tier problem: rethrow it and let BullMQ retry,
    // which is exactly the case retries exist for.
    const isUpstreamFailure =
      err instanceof geminiClassifier.GeminiClassificationError ||
      err.name === "AbortError" ||
      err.code === "ETIMEDOUT" ||
      err.code === "ECONNRESET" ||
      err.code === "ENOTFOUND";

    if (!isUpstreamFailure) throw err;
  }
}

// Keyword scoring lives in services/taxonomyMatcher.js: it is pure, it is the
// part that was silently wrong for the whole document-type axis, and it is now
// unit-tested (tests/taxonomyMatcher.test.js) rather than only reachable
// through a job that needs Postgres and Redis to run.

async function handle({ fileId }) {
  const file = await fileRepository.findById(fileId);
  if (!file || file.status === "deleted" || file.status === "missing") {
    return { skipped: true, reason: "file not active" };
  }

  const [metadata, content, allSubjects, allDocTypes] = await Promise.all([
    fileMetadataRepository.findByFile(fileId),
    fileContentRepository.findByFile(fileId),
    // THIS USER'S folders, not every folder in the database.
    //
    // Was `subjectRepository.list({ limit: 1000 })`, which is the base
    // repository's unscoped `SELECT * FROM subjects LIMIT 1000`. Subjects are
    // per-account (they carry owner_user_id), so on any instance with more
    // than one user that offered every account's folders as candidates for
    // every file: one person's document could be classified into another
    // person's folder, and their folder names were sent to Gemini inside a
    // stranger's prompt. Latent on a single-user install and a data leak on
    // any other -- and it gets worse the moment folders carry descriptions,
    // which is exactly what the line below now sends.
    //
    // Document types are deliberately NOT scoped: that table has no
    // owner_user_id. They are a shared vocabulary, not personal folders.
    subjectRepository.listForOwnerTree(file.owner_user_id),
    documentTypeRepository.list({ limit: 1000 }),
  ]);

  const filenameText = `${file.filename_original} ${file.filename_current}`.toLowerCase();

  // Text the extraction stage judged unusable is treated as absent, not as
  // content. Keyword-matching noise produces accidental hits, and -- far
  // worse -- sending it to the AI tier gets back a fluent, confident title
  // invented from nothing, which becomes a rename proposal against a real
  // document. See services/extraction/textQuality.js.
  const textIsUsable = !content?.text_quality || content.text_quality === "ok";
  const usableText = textIsUsable ? content?.extracted_text || "" : "";
  const bodyText = usableText.toLowerCase().slice(0, 20000);

  // Filename matches count more -- a match in the name itself is much
  // stronger signal than an incidental word appearing somewhere in the body.
  const subjectMatch = taxonomyMatcher.bestMatch(allSubjects, { filenameText, bodyText });

  /**
   * DOCUMENT TYPE IS NOT READ FROM THE BODY TEXT. This is the asymmetry that
   * makes the axis mean anything, and it is not an oversight.
   *
   * Subject asks "what is this about", and prose answers that honestly -- a
   * document that discusses budgets at length probably is about Finance.
   * Document type asks "what KIND of thing is this" (docs/03-taxonomy.md
   * §3.4), and prose does not answer that at all. The narrative that broke
   * this axis says "presentation" four times, every one of them about a person
   * giving one. Word-boundary matching does not help: the words are real
   * words, correctly matched, and the conclusion is still wrong. There is no
   * lexical rule that separates "mentions a presentation" from "is a
   * presentation", so the rule tier stops guessing and leaves the axis to the
   * two signals that can actually carry it -- the filename a person chose, and
   * an extension that settles the question outright -- plus the AI tier, which
   * reads the document, and a human, who can set it from the Files page.
   *
   * Consequence, stated plainly: the rule tier now assigns FEWER types. On a
   * French/Arabic corpus with an English seed list it will usually assign
   * none. An empty axis is recoverable; an axis full of confident nonsense
   * teaches people not to trust the filter, which is not.
   */
  const docTypeMatch = taxonomyMatcher.bestMatch(allDocTypes, { filenameText, bodyText: "" });
  const extensionType = taxonomyMatcher.typeFromExtension(file.extension, allDocTypes);

  const bestSubject = subjectMatch.entity;
  const bestSubjectScore = subjectMatch.score;
  const bestSubjectInFilename = subjectMatch.inFilename;

  // The extension outranks the filename keyword: "quarterly-report.pptx" is a
  // Presentation that happens to contain a report, and the container is the
  // thing the type axis names.
  const bestDocType = extensionType || docTypeMatch.entity;
  const bestDocTypeScore = extensionType ? 3 : docTypeMatch.score;
  const bestDocTypeInFilename = Boolean(extensionType) || docTypeMatch.inFilename;

  if (!bestSubject && !bestDocType) {
    // Carries both axes forward rather than nulling them: "the keyword tier
    // recognised nothing" is a statement about the keyword tier, not about the
    // file. Re-running classification on a file a human had already filed and
    // typed must not quietly undo that work.
    const result = await classificationResultRepository.createPartial({
      fileId,
      confidenceLevel: ConfidenceLevel.LOW,
      confidenceScore: 0,
      method: ClassificationMethod.RULE,
      rawOutput: { reason: "no keyword matches against seeded taxonomy" },
    });

    // A total keyword miss is exactly the case the AI tier exists for --
    // always eligible to escalate regardless of the configured threshold.
    if (env.ai.enabled) {
      await runAiEscalation({ file, bodyText: usableText, allSubjects, allDocTypes, embeddedTitle: metadata?.metadata?.title || null });
    }
    // generateNamesProcessor re-reads the latest classification_results row
    // itself and no-ops if it's still low confidence, so it's always safe
    // to enqueue here rather than duplicating that decision.
    await enqueueJob(JobType.GENERATE_NAMES, { fileId }, {});
    // Describing happens after classification, not before, so it can adopt the
    // AI tier's summary where that ran instead of paying for a second one.
    await enqueueJob(JobType.DESCRIBE, { fileId }, {});

    return { classificationResultId: result.id, confidenceLevel: "low" };
  }

  const inFilename = bestSubjectInFilename || bestDocTypeInFilename;
  const totalScore = bestSubjectScore + bestDocTypeScore;
  // Bug fix (real-world report): a file got confidently renamed after a
  // SINGLE incidental keyword hit somewhere in 20,000 characters of body
  // text (totalScore=1 was enough for "medium", which was enough for
  // generateNamesProcessor to propose a rename). A lone body-only mention
  // is noise, not signal -- now MEDIUM requires either an actual filename
  // hit (a much stronger signal) or at least two independent body matches.
  const confidenceLevel = inFilename && totalScore >= 4
    ? ConfidenceLevel.HIGH
    : (inFilename || totalScore >= 2)
      ? ConfidenceLevel.MEDIUM
      : ConfidenceLevel.LOW;
  const confidenceScore = Math.min(0.99, totalScore / 10);

  const result = await classificationResultRepository.createPartial({
    fileId,
    // undefined where there was no match, so an axis this pass says nothing
    // about keeps its current value instead of being cleared.
    classifiedSubjectId: bestSubject?.id,
    classifiedDocumentTypeId: bestDocType?.id,
    confidenceLevel,
    confidenceScore,
    method: ClassificationMethod.RULE,
    rawOutput: {
      // `terms` is what actually matched. Without it a stored score of 2 is
      // unfalsifiable after the fact -- which is how "Book" survived on the
      // strength of "playbook" until someone went looking for the text.
      subjectMatch: bestSubject
        ? { id: bestSubject.id, name: bestSubject.name, score: bestSubjectScore, terms: subjectMatch.matchedTerms }
        : null,
      documentTypeMatch: bestDocType
        ? {
            id: bestDocType.id,
            code: bestDocType.code,
            score: bestDocTypeScore,
            source: extensionType ? "extension" : "filename",
            terms: extensionType ? [file.extension] : docTypeMatch.matchedTerms,
          }
        : null,
      matchedInFilename: inFilename,
    },
  });

  if (env.ai.enabled && shouldEscalateToAi(confidenceLevel)) {
    await runAiEscalation({ file, bodyText: usableText, allSubjects, allDocTypes, embeddedTitle: metadata?.metadata?.title || null });
  }

  await enqueueJob(JobType.GENERATE_NAMES, { fileId }, {});
  await enqueueJob(JobType.DESCRIBE, { fileId }, {});

  return { classificationResultId: result.id, confidenceLevel };
}

module.exports = { handle };