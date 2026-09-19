// Version detection (docs/06-processing-pipeline.md §6.1, docs/01-domain-model.md
// §1.3). Two files are versions of one Document when they are the same
// underlying document captured at different times -- "Rapport_v1.docx" and
// "Rapport_v2.docx", or "Budget.xlsx" and "Budget (2).xlsx".
//
// WHAT THIS DOES NOT DO, on purpose: it never creates or mutates a
// `document_versions` row. docs/01 §1.3 is explicit that a Version
// relationship must never be auto-resolved above the "suggest" tier without
// a human confirming, and §1.5 caps LOW/MEDIUM confidence at "surfaced as a
// suggestion, never applied without explicit approval". Writing a version
// row here would be applying it.
//
// Instead it records the suggestion the same way every other automated
// judgement in this codebase does -- an audit_logs entry carrying the
// evidence -- so the finding is durable, reviewable and reversible without
// inventing a schema change or silently restructuring anyone's documents.
//
// PROMOTING A SUGGESTION IS NOT IMPLEMENTED, and this comment used to say
// otherwise -- it named documentVersionRepository.createCurrentVersion as the
// deliberate human action that turns a suggestion into a document_versions
// row, "left to the UI/API". There was no such UI and no such API: that
// repository had no caller anywhere in the codebase, `document_versions` has
// never held a row, and the whole `documents` model it belonged to was never
// populated by this pipeline (see subjectService and fileOrganizeService, both
// of which already say so). The repository has been removed rather than left
// as an unreachable implementation of a path nothing takes.
//
// So what this processor produces is the finding, in the audit log, and that
// is the end of the story today. Acting on one is a person reading it.
//
// Why filename alone is never enough: docs/01 §1.2 warns that a
// filename-pattern-only rule "will silently merge unrelated documents that
// merely share a filename pattern". So the filename supplies the candidate
// and extracted text has to corroborate it -- see similarityService
// .versionRelationship, which weights content at 0.7 and the filename at 0.3
// precisely so a name match alone can never clear the bar.
const fileRepository = require("../../repositories/fileRepository");
const fileContentRepository = require("../../repositories/fileContentRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");
const similarity = require("../../services/similarityService");
const { DetectionMethod } = require("../../models/enums");

async function handle({ fileId }) {
  const file = await fileRepository.findById(fileId);
  if (!file) return { skipped: true, reason: "file not found" };
  if (file.status !== "active") return { skipped: true, reason: "file not active" };

  const content = await fileContentRepository.findByFile(fileId);
  const text = content?.extracted_text || "";

  const candidates = await fileRepository.listSimilarityCandidates(file);
  const subject = {
    filename: file.filename_current || file.filename_original,
    text,
  };

  const findings = [];
  for (const candidate of candidates) {
    const result = similarity.versionRelationship(subject, {
      filename: candidate.filename_current || candidate.filename_original,
      text: candidate.extracted_text,
    });
    if (result.isVersionCandidate) {
      findings.push({ candidate, result });
    }
  }

  if (findings.length === 0) {
    return { candidatesCompared: candidates.length, versionCandidatesFound: 0 };
  }

  findings.sort((a, b) => b.result.score - a.result.score);

  await auditLogRepository.record({
    action: "version.suggested",
    entityType: "file",
    entityId: file.id,
    newState: {
      filename: subject.filename,
      versionNumber: similarity.extractVersionNumber(subject.filename),
      detectionMethod: DetectionMethod.FILENAME_HEURISTIC,
      candidates: findings.map((f) => ({
        fileId: f.candidate.id,
        filename: f.candidate.filename_current,
        versionNumber: f.result.versionNumbers.b,
        score: Number(f.result.score.toFixed(4)),
        confidenceLevel: f.result.confidenceLevel,
        reason: f.result.reason,
      })),
    },
    reason:
      "Possible versions of the same document (suggestion only -- no document_versions row is " +
      "created without explicit human confirmation, per docs/01-domain-model.md §1.3).",
  });

  return {
    candidatesCompared: candidates.length,
    versionCandidatesFound: findings.length,
    bestScore: Number(findings[0].result.score.toFixed(4)),
    bestConfidence: findings[0].result.confidenceLevel,
  };
}

module.exports = { handle };
