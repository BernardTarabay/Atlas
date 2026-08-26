// Naming + folder-placement proposal stage. Reads the most recent
// classification result for a file and, if there's a real basis to act on
// it, writes a RenameProposal for human review -- never applies it. The
// proposal can carry a new filename, a new folder (proposed_relative_dir,
// migration 013), or both -- bulkRenameProcessor applies whichever fields
// are set once approved.
const path = require("path");
const db = require("../../config/database");
const fileRepository = require("../../repositories/fileRepository");
const fileMetadataRepository = require("../../repositories/fileMetadataRepository");
const fileContentRepository = require("../../repositories/fileContentRepository");
const fileDescriptionRepository = require("../../repositories/fileDescriptionRepository");
const descriptionService = require("../../services/descriptionService");
const { looksLikeMojibake } = require("../../services/extraction/ole/codePageString");
const classificationResultRepository = require("../../repositories/classificationResultRepository");
const subjectRepository = require("../../repositories/subjectRepository");
const documentTypeRepository = require("../../repositories/documentTypeRepository");
const renameProposalRepository = require("../../repositories/renameProposalRepository");
const storageLocationRepository = require("../../repositories/storageLocationRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");
const { buildCanonicalName, buildTargetRelativeDir } = require("../../services/namingService");
const pipelineState = require("../../services/pipelineState");
const { ConfidenceLevel, JobType } = require("../../models/enums");
const { enqueueJob } = require("../../queues");
const env = require("../../config/env");

// Filters out embedded document-title metadata that's technically present
// but useless as a filename -- Office/PDF tools love to default this field
// to something like "Document1" or leave it blank-but-not-null.
const JUNK_TITLE_PATTERN = /^(untitled|document\d*|new microsoft word document|presentation\d*|book\d*|slide\d*|model|normal|template|copy of .*)$/i;

/**
 * A title shared by at least this many files is the TEMPLATE's title, not the
 * document's.
 *
 * Measured on the live corpus before choosing the number: 403 files carry the
 * organisation's name as their title, 25 more carry its French translation,
 * 20 say "Secretariat General", and in total 758 of 1,368 titled files share
 * a title with at least four others. Meanwhile the genuinely descriptive
 * titles are almost all unique.
 *
 * Five is deliberately low. The cost of being wrong in each direction is not
 * symmetric: wrongly rejecting a real title leaves a file with the name a
 * person already gave it, while wrongly accepting boilerplate renames
 * hundreds of unrelated documents to the same string -- which is exactly what
 * was reported.
 */
const BOILERPLATE_TITLE_MIN_FILES = 5;

function isUsableTitle(title) {
  if (!title) return false;
  const trimmed = String(title).trim();
  if (trimmed.length < 2 || trimmed.length > 150) return false;
  if (JUNK_TITLE_PATTERN.test(trimmed)) return false;

  // A title decoded with the wrong code page is worse than no title: it is
  // confident, non-empty garbage that sails past every other check and ends
  // up proposed as a real document's new filename. The OLE reader now decodes
  // properly (see ole/codePageString.js), but this is the backstop -- any
  // future extractor that gets an encoding wrong fails safe, and the file
  // keeps the name a person gave it.
  if (looksLikeMojibake(trimmed)) return false;

  return true;
}

/**
 * Is this title shared with enough other files to be template boilerplate?
 *
 * Recorded in the audit log when it fires, because "why was this file not
 * renamed" is otherwise unanswerable -- and the answer is a genuinely useful
 * fact about the corpus: the template carries the organisation's name.
 */
async function isBoilerplateTitle(title, fileId) {
  const shared = await fileMetadataRepository.countFilesSharingTitle(title, {
    cap: BOILERPLATE_TITLE_MIN_FILES,
  });
  if (shared < BOILERPLATE_TITLE_MIN_FILES) return false;

  await auditLogRepository.record({
    action: "rename.boilerplate_title_ignored",
    entityType: "file",
    entityId: fileId,
    newState: { title, sharedWithAtLeast: shared },
    reason:
      `The embedded title "${title}" is shared with at least ${shared} other files, so it describes the ` +
      "template rather than this document. Ignored for naming; the file keeps its existing name unless " +
      "something else can describe it better.",
  });
  return true;
}

async function handle({ fileId }) {
  const file = await fileRepository.findById(fileId);
  if (!file || file.status === "deleted" || file.status === "missing") {
    return { skipped: true, reason: "file not active" };
  }

  // generate_names is the LAST stage of the document pipeline, so whatever it
  // decides is this file's final machine-determined state. Every exit below
  // records one, because a file whose state never moves off 'discovered' looks
  // permanently unstarted no matter how much work was actually done to it.

  const [classifications, fileMetadata, content, description] = await Promise.all([
    classificationResultRepository.listProposedForFile(fileId),
    fileMetadataRepository.findByFile(fileId),
    fileContentRepository.findByFile(fileId),
    fileDescriptionRepository.findByFile(fileId),
  ]);
  const latest = classifications[0];

  // THE LAST LINE OF DEFENCE FOR A FILE'S EXISTING NAME.
  //
  // Reported from real use: scanned PDFs were being proposed for renaming
  // into gibberish, because the extractor returned noise, the AI tier read
  // the noise, and a confident title came back. The upstream stages now
  // refuse to use unusable text -- but a file can still arrive here with a
  // classification made purely from its own filename.
  //
  // Proposing a rename in that situation cannot improve anything: the only
  // information available IS the current name, so the "proposal" is at best
  // a reshuffle of it and at worst an invention. A name a person chose is
  // more trustworthy than one derived from an unreadable file, so when there
  // is no readable content and no embedded title, the file keeps its name.
  //
  // An embedded title still counts: that is metadata the author wrote, and
  // it survives even when the page content does not extract.
  //
  // AND SO DOES A TITLE THAT CAME FROM LOOKING AT THE FILE.
  //
  // The paragraph above reasons that with no readable content "the only
  // information available IS the current name". That was true when extracted
  // text was the only signal. It stopped being true when the describe stage
  // became multimodal: a photograph has no text because it is a photograph,
  // and the describer read the picture. "Two people embracing in a kitchen" is
  // not a reshuffle of "WhatsApp Image 2026-07-29 at 20.17.33.jpeg" and it is
  // not an invention -- it is the one genuinely new fact anyone has about that
  // file.
  //
  // Without this, every photo and video in an archive skipped naming while
  // holding a perfectly good title the pipeline had already paid for, and the
  // rename queue stayed empty on exactly the files whose names are worst.
  //
  // The original protection is untouched, because it turns on a different
  // question. A scanned PDF whose OCR returned noise is described from
  // `ocr_text`/`document_text`, never from `image`/`video`, so it still
  // declines -- see descriptionService.PERCEIVED_SOURCES for what does and
  // does not count, and why `metadata` (built in code, no model) does not.
  const textUnusable = Boolean(content?.text_quality) && content.text_quality !== "ok";
  const embeddedTitleRaw = fileMetadata?.metadata?.title;
  const perceivedTitle =
    descriptionService.isPerceivedDescription(description) && isUsableTitle(file.ai_short_title);
  if (textUnusable && !isUsableTitle(embeddedTitleRaw) && !perceivedTitle) {
    await auditLogRepository.record({
      action: "rename.skipped_unreadable",
      entityType: "file",
      entityId: fileId,
      newState: { textQuality: content.text_quality, needsOcr: content.needs_ocr === true },
      reason:
        `Keeping the existing filename: this file's text came back as "${content.text_quality}", so any ` +
        "proposed name would be invented rather than read from the document." +
        (content.needs_ocr ? " OCR would likely make it nameable." : ""),
    });
    // A person has to name this one -- the machine has correctly declined to
    // invent a name from noise. NEEDS_USER, not failed: nothing went wrong.
    await pipelineState.markNeedsUser(
      fileId, "generate_names",
      content.needs_ocr
        ? "The text could not be read. OCR would probably make this nameable."
        : "The text came back unusable, so Atlas will not invent a name. Name it yourself."
    );
    return {
      skipped: true,
      reason: `text unusable (${content.text_quality}); keeping the original filename`,
      needsOcr: content.needs_ocr === true,
    };
  }

  // Best available real title, most to least authoritative:
  //   1. The document's own embedded title (docProps/core.xml dc:title,
  //      PDF Info Title) -- literally what the author named it.
  //   2. Gemini's short_title -- its own understanding of the content,
  //      from the AI escalation tier (file.ai_short_title, migration 012).
  // Gemini's confidence field reflects how sure it is about the
  // subject/document_type PICK, not about short_title -- it can
  // legitimately say "low" on the pick (nothing in our taxonomy fits)
  // while still having read the document correctly enough to title it.
  const embeddedTitle = fileMetadata?.metadata?.title;

  // An embedded title only counts if it is about THIS document. A title that
  // hundreds of other files also carry came from the Word template, and using
  // it renames all of them to the organisation's name.
  const embeddedIsUsable =
    isUsableTitle(embeddedTitle) && !(await isBoilerplateTitle(embeddedTitle, fileId));

  const titleSource = embeddedIsUsable
    ? "embedded"
    : isUsableTitle(file.ai_short_title)
      ? "ai"
      : null;
  const bestTitle = titleSource === "embedded" ? embeddedTitle : titleSource === "ai" ? file.ai_short_title : null;

  if (!latest || (latest.confidence_level === ConfidenceLevel.LOW && !bestTitle)) {
    // Settled: it keeps the name it has. That is a finished outcome, not a
    // pending one -- see the note on rejected proposals in renameProposalService.
    await pipelineState.markCompleted(fileId, "generate_names");
    return { skipped: true, reason: "no sufficiently confident classification to name from" };
  }

  const [subject, documentType] = await Promise.all([
    latest.classified_subject_id ? subjectRepository.findById(latest.classified_subject_id) : null,
    latest.classified_document_type_id ? documentTypeRepository.findById(latest.classified_document_type_id) : null,
  ]);

  // Nothing to name from AND nowhere to file it -- there is no proposal to
  // make. (A subject with no title is still worth a proposal: the move.)
  if (!subject && !bestTitle) {
    await pipelineState.markCompleted(fileId, "generate_names");
    return { skipped: true, reason: "no usable title and no subject to file under; keeping the original name" };
  }

  // NO TITLE MEANS NO RENAME.
  //
  // Without a real title the only thing left to build a name from is the
  // taxonomy bucket, which produces "Academic.pdf" and "Finance.docx" --
  // technically a name, and worse than what the file already had. It also
  // collides: every unnamed file in a subject wants the same one.
  //
  // The existing filename was chosen by a person and is usually fine, so it
  // stands. Filing the document under its subject is still worthwhile and
  // still happens below -- naming and placement are separate decisions, and
  // failing at one is no reason to skip the other.
  const canRename = Boolean(bestTitle);

  // file.ai_entities comes from the AI escalation tier when it extracted
  // party/date/identifier from the actual content -- used to lightly
  // disambiguate the title (e.g. an identifier not already in the title
  // text), not to replace it. See namingService.js for the full priority
  // order.
  const proposedFilename = canRename
    ? buildCanonicalName({
        subject,
        documentType,
        filenameOriginal: file.filename_original,
        extension: file.extension,
        entities: file.ai_entities || null,
        shortTitle: bestTitle,
      })
    : file.filename_current;

  // Folder placement: the classified Subject determines where the file
  // should live (e.g. "Finance/Budgets"), independent of what it's named --
  // this is the other half of "store it under Finance, but don't repeat
  // that in the filename too." Only proposed when it's an actual change
  // from where the file already is, and only when there's a confident
  // Subject to place it under (never invents a folder any more than the
  // naming side invents a category).
  const currentRelativeDir = path.dirname(file.current_path) === "." ? "" : path.dirname(file.current_path);
  let proposedRelativeDir = null;
  if (subject) {
    const ancestorChain = await subjectRepository.getAncestorChain(subject.id);
    const targetDir = buildTargetRelativeDir(ancestorChain) || "";
    if (targetDir && targetDir !== currentRelativeDir) proposedRelativeDir = targetDir;
  }

  const nameUnchanged = proposedFilename === file.filename_current;
  const noMoveNeeded = !proposedRelativeDir;
  if (nameUnchanged && noMoveNeeded) {
    // Nothing to change: the file already has the name and place the
    // classifier would propose. Finished, not pending.
    await pipelineState.markCompleted(fileId, "generate_names");
    return { skipped: true, reason: "proposed name and folder both match the current state" };
  }

  // Bug fix: don't blindly recreate a proposal the user already rejected.
  // Without this, rescanning/re-touching a file (e.g. removing it and
  // re-uploading the exact same content) regenerated the identical
  // rename proposal in Pending, making the earlier rejection meaningless.
  // A proposal with a genuinely different proposed_filename/folder (real
  // content or classification change) is unaffected -- this only
  // suppresses an exact repeat of both fields together.
  const rejectedMatch = await renameProposalRepository.findRejectedMatch(fileId, proposedFilename, proposedRelativeDir);
  if (rejectedMatch) {
    await auditLogRepository.record({
      action: "rename.reproposal_skipped",
      entityType: "file",
      entityId: fileId,
      reason: `Identical rename/move to "${proposedFilename}"${proposedRelativeDir ? ` in "${proposedRelativeDir}"` : ""} was already rejected (proposal ${rejectedMatch.id}); not re-proposing without a real change.`,
    });
    // The user already declined exactly this suggestion. Their decision
    // stands and the file is settled -- see renameProposalService.review.
    await pipelineState.markCompleted(fileId, "generate_names");
    return { skipped: true, reason: "identical rename/move already rejected", rejectedProposalId: rejectedMatch.id };
  }

  // Bug fix (real-world report): 40 files produced 78 pending proposals.
  // Nothing here checked whether this file already had a pending proposal
  // before inserting a new one -- if generate_names ran twice for the same
  // file for any reason (a BullMQ retry after a transient failure partway
  // through the job, a duplicate enqueue), it just stacked a second
  // proposal on top. There should only ever be one pending proposal per
  // file: an exact repeat of the same suggestion is skipped outright; a
  // genuinely different suggestion (newer/better classification) replaces
  // the stale one instead of sitting alongside it.
  const existingPending = await renameProposalRepository.findPendingForFile(fileId);
  const identicalPending = existingPending.find(
    (p) => p.proposed_filename === proposedFilename && (p.proposed_relative_dir || null) === (proposedRelativeDir || null)
  );
  if (identicalPending) {
    // A proposal is already waiting on the Rename proposals page. The
    // PIPELINE is done with this file; the outstanding decision lives in that
    // queue, not in triage.
    await pipelineState.markCompleted(fileId, "generate_names");
    return { skipped: true, reason: "identical proposal already pending", pendingProposalId: identicalPending.id };
  }
  const namingReason = bestTitle
    ? `named from ${titleSource === "embedded" ? "the document's own embedded title" : "the AI tier's read of the content"} ("${bestTitle}")`
    : "keeping the existing filename (no title describes this document well enough to improve on it)";
  const moveReason = proposedRelativeDir ? `; move into "${proposedRelativeDir}" per its classified subject` : "";
  const reason = `${nameUnchanged ? "Name unchanged; " : ""}${namingReason}${moveReason} ` +
    `(classification result ${latest.id}, method ${latest.method}, confidence ${latest.confidence_level})`;

  // SUPERSEDE THE OLD PROPOSAL AND CREATE THE NEW ONE ATOMICALLY.
  //
  // These used to be separate autocommitted statements: every stale pending
  // proposal was rejected in its own transaction, and only then was the
  // replacement inserted. A worker killed between the two -- or an insert
  // that failed on any of the constraints below it -- left the file with its
  // previous suggestion REJECTED and no new one in its place. The file simply
  // lost its pending proposal, silently, and nothing would generate another
  // until its classification changed again.
  //
  // Rejecting the old one is only correct as part of replacing it, so the two
  // belong in the same transaction. The audit rows join it for the same
  // reason: a trace of a supersede that did not happen is worse than none.
  const proposal = await db.withTransaction(async (client) => {
    for (const stale of existingPending) {
      await renameProposalRepository.review(stale.id, { status: "rejected", reviewedBy: null, client });
      await auditLogRepository.record({
        action: "rename.superseded",
        entityType: "rename_proposal",
        entityId: stale.id,
        previousState: { status: "pending", proposedFilename: stale.proposed_filename },
        newState: { status: "rejected", supersededByProposedFilename: proposedFilename },
        reason: "Automatically superseded by a freshly generated proposal for the same file",
        client,
      });
    }

    const created = await renameProposalRepository.create({
      fileId,
      currentFilename: file.filename_current,
      proposedFilename,
      proposedRelativeDir,
      reason,
      metadataUsed: {
        classificationResultId: latest.id,
        subjectId: subject?.id || null,
        documentTypeId: documentType?.id || null,
        titleSource,
        currentRelativeDir,
      },
      confidenceLevel: latest.confidence_level,
      confidenceScore: latest.confidence_score,
      client,
    });

    await auditLogRepository.record({
      action: "rename.proposed",
      entityType: "file",
      entityId: fileId,
      newState: { proposedFilename },
      reason: "Generated from classification result",
      client,
    });

    return created;
  });

  const autoApplied = await autoDecide(proposal, file, latest);

  // The machine is done with this document either way.
  //
  // Either way the decision has already been made by autoDecide -- applied or
  // rejected -- so there is no outstanding human step and nothing to leave the
  // file looking unprocessed for. Marking it needs_user here would put it in
  // triage for a question nobody is going to be asked.
  await pipelineState.markCompleted(fileId, "generate_names");

  return { renameProposalId: proposal.id, proposedFilename, proposedRelativeDir, autoApplied };
}

/**
 * Decide the proposal's fate immediately, without a review queue.
 *
 * WHY THERE IS NO LONGER A PENDING STATE TO SIT IN
 *
 * A proposal used to be created `pending` and wait on the Rename Proposals
 * page for somebody to click approve. That page is gone: if the system is 90%
 * confident about a filename, asking a person to confirm it adds friction
 * without adding judgement, and 410 pending proposals is not a worklist
 * anybody works.
 *
 *   score >= 0.90   approve and apply
 *   score <  0.90   reject, and move on
 *
 * Rejecting is the honest low-confidence outcome, not a deferral. It rejects
 * THE NAME and never the file -- the document keeps its classification and its
 * place, exactly as renameProposalService.review documents.
 *
 * SCORE, NOT LEVEL. This used to compare confidence LEVELS (high/medium/low),
 * which cannot express 0.90: 'high' covers a range, and the boundary the user
 * actually wants sits inside it.
 *
 * WHAT THIS DOES TO A WRITABLE LOCATION
 *
 * On a READ-ONLY location, applying writes `files.canonical_filename` and
 * rebuilds a shortcut; the original is untouched. On a WRITABLE one,
 * bulkRenameProcessor calls `storageService.rename()` and the real file on
 * disk is renamed, unattended.
 *
 * That was refused here for a while, and the refusal was lifted deliberately:
 * automating a decision the system is 90% sure of is the whole point, and
 * carving out an exception for the case where it matters most is not much of
 * an automation. What makes it defensible is what bulkRenameProcessor already
 * guarantees -- a name that collides is suffixed rather than overwriting
 * anything, the database writes are one transaction, a failed transaction
 * renames the file BACK, and every rename records its previous path and
 * filename in the audit log. Nothing is destroyed and every step is traceable.
 *
 * Below 0.90 nothing is touched at all.
 */
const AUTO_APPLY_MIN_SCORE = 0.9;

async function autoDecide(proposal, file, classification) {
  const score = Number(proposal.confidence_score ?? classification.confidence_score ?? 0);

  if (score < AUTO_APPLY_MIN_SCORE) {
    await renameProposalRepository.review(proposal.id, { status: "rejected", reviewedBy: null });
    await auditLogRepository.record({
      action: "rename.auto_rejected",
      entityType: "file",
      entityId: file.id,
      newState: { proposalId: proposal.id, confidenceScore: score },
      reason:
        `Proposed name scored ${score.toFixed(2)}, below the ${AUTO_APPLY_MIN_SCORE} needed to rename ` +
        "without review. The name was rejected; the file keeps its classification and its place.",
    });
    return false;
  }

  const location = await storageLocationRepository.findById(file.storage_location_id);
  const writesToDisk = Boolean(location && !location.is_read_only);

  // reviewedBy stays null: nobody reviewed it. Recording a user here would
  // put a person's name against a decision they never made.
  await renameProposalRepository.review(proposal.id, { status: "approved", reviewedBy: null });
  await enqueueJob(
    JobType.BULK_RENAME,
    { proposalIds: [proposal.id] },
    { storageLocationId: file.storage_location_id, progressTotal: 1 }
  );

  await auditLogRepository.record({
    action: "rename.auto_applied",
    entityType: "file",
    entityId: file.id,
    newState: {
      proposalId: proposal.id,
      confidenceScore: score,
      // Recorded explicitly, because the two cases have genuinely different
      // consequences and "it was auto-applied" alone does not say which
      // happened. Anyone reading this log later needs to know whether a file
      // on disk moved.
      renamedOnDisk: writesToDisk,
    },
    reason:
      `Auto-applied without review: the proposed name scored ${score.toFixed(2)}, at or above ` +
      `${AUTO_APPLY_MIN_SCORE}. ` +
      (writesToDisk
        ? `"${location.name}" is WRITABLE, so the file itself is renamed on disk. The previous path and ` +
          "filename are recorded on the file.renamed entry, which is what makes this reversible."
        : "The original file is not renamed -- only the canonical name and the shortcut mirror change."),
  });

  return true;
}

module.exports = { handle, AUTO_APPLY_MIN_SCORE };
