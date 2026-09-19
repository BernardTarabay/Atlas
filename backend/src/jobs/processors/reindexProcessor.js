// Reindex (docs/06-processing-pipeline.md §6.1). Re-runs the analysis half
// of the pipeline over files that are ALREADY known to the database, without
// re-walking the filesystem.
//
// This is the operation you want after changing something that affects how
// files are interpreted rather than what files exist -- turning on
// GEMINI_API_KEY, adding an extractor (the OLE-CFB one, say), editing the
// taxonomy, or changing AI_ESCALATE_BELOW_CONFIDENCE. A `scan` would not
// help: nothing on disk changed, so scan would correctly find nothing new
// and re-analyse nothing.
//
// It generalizes a one-off re-classification script (since removed), which only
// re-enqueued `classify`. The stages are opt-in via the payload so a
// re-extraction (expensive -- reads and parses every file) can be requested
// separately from a re-classification (cheap by comparison).
//
// Idempotency: every stage this enqueues is itself idempotent (docs/06
// §6.3) -- extraction upserts, classification appends a new result row,
// naming supersedes rather than mutates. Running reindex twice costs time,
// never correctness.
const fileRepository = require("../../repositories/fileRepository");
const processingJobItemRepository = require("../../repositories/processingJobItemRepository");
const processingJobRepository = require("../../repositories/processingJobRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");
const { enqueueJob } = require("../../queues");
const { JobType } = require("../../models/enums");

const BATCH_SIZE = 200;

// Order matters: extraction feeds classification, which feeds naming. They
// are enqueued (not awaited to completion) in this order so the queues drain
// roughly in dependency order; each stage also re-chains its own successor,
// so requesting only `extractText` still ends up re-running classification.
const STAGE_JOBS = {
  extractMetadata: JobType.EXTRACT_METADATA,
  extractText: JobType.EXTRACT_TEXT,
  classify: JobType.CLASSIFY,
  detectDuplicates: JobType.DETECT_DUPLICATES,
  detectVersions: JobType.DETECT_VERSIONS,
  generateNames: JobType.GENERATE_NAMES,
};

const DEFAULT_STAGES = ["extractMetadata", "extractText"];

/**
 * @param {object} payload
 * @param {string}   [payload.storageLocationId] - limit to one location; omit for every active file
 * @param {string[]} [payload.fileIds]           - limit to specific files (takes precedence)
 * @param {string[]} [payload.stages]            - keys of STAGE_JOBS; defaults to re-extraction,
 *                                                 which re-chains classification and naming itself
 * @param {string}   [payload.actorUserId]
 */
async function handle({ storageLocationId = null, fileIds = null, stages = null, actorUserId = null, ownerUserId = null }, bullJob) {
  const requestedStages = (stages && stages.length ? stages : DEFAULT_STAGES).filter((s) => STAGE_JOBS[s]);
  if (requestedStages.length === 0) {
    throw new Error(
      `No valid reindex stages requested. Valid stages: ${Object.keys(STAGE_JOBS).join(", ")}`
    );
  }

  const processingJobId = bullJob?.data?.processingJobId || null;
  const summary = { filesProcessed: 0, jobsEnqueued: 0, failed: 0, stages: requestedStages };

  // Every reindex acts on exactly one account's files. Resolved once, here,
  // and passed down rather than re-derived per file: a reindex that silently
  // widened its scope mid-run would re-enqueue the whole pipeline for
  // documents its requester cannot see.
  const owner = ownerUserId || actorUserId;
  if (!owner) throw new Error("reindex requires the owner whose files are being reprocessed.");

  const targets = await resolveTargets({ storageLocationId, fileIds, ownerUserId: owner });
  if (processingJobId) {
    // The total is only knowable here, after resolving which files this run
    // covers -- enqueueJob's progressTotal is set too early for that.
    await processingJobRepository.updateProgressTotal(processingJobId, targets.length);
    await processingJobRepository.updateProgress(processingJobId, 0);
  }

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);

    for (const file of batch) {
      const jobItem = processingJobId
        ? await processingJobItemRepository.create({ jobId: processingJobId, fileId: file.id, status: "pending" })
        : null;
      try {
        for (const stage of requestedStages) {
          const jobType = STAGE_JOBS[stage];
          const payload =
            jobType === JobType.DETECT_DUPLICATES
              ? { fileId: file.id, phase: "probable" }
              : { fileId: file.id };
          await enqueueJob(jobType, payload, {
            storageLocationId: file.storage_location_id,
            createdBy: actorUserId,
            ownerUserId: owner,
          });
          summary.jobsEnqueued += 1;
        }
        summary.filesProcessed += 1;
        if (jobItem) {
          await processingJobItemRepository.complete(jobItem.id, {
            status: "succeeded",
            result: { stages: requestedStages },
          });
        }
      } catch (err) {
        summary.failed += 1;
        if (jobItem) {
          await processingJobItemRepository.complete(jobItem.id, { status: "failed", errorMessage: err.message });
        }
      }
    }

    if (processingJobId) {
      await processingJobRepository.updateProgress(processingJobId, summary.filesProcessed);
    }
  }

  await auditLogRepository.record({
    userId: actorUserId,
    action: "repository.reindexed",
    entityType: "storage_location",
    entityId: storageLocationId,
    newState: summary,
    reason: `Reindex re-enqueued ${requestedStages.join(", ")} for ${summary.filesProcessed} file(s)`,
  });

  return summary;
}

async function resolveTargets({ storageLocationId, fileIds, ownerUserId }) {
  if (fileIds && fileIds.length) {
    // Owner-scoped lookup, so an id list carrying somebody else's file simply
    // yields nothing for it rather than reprocessing it.
    return (await fileRepository.listByIdsForOwner(fileIds, ownerUserId))
      .filter((f) => f.status === "active");
  }

  // Paginate rather than SELECT *: a reindex over a large repository must
  // not pull every row into memory at once (spec §30).
  const all = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = await fileRepository.listByStatus("active", ownerUserId, { limit: pageSize, offset });
    const filtered = storageLocationId
      ? page.filter((f) => f.storage_location_id === storageLocationId)
      : page;
    all.push(...filtered);
    if (page.length < pageSize) break;
  }
  return all;
}

module.exports = { handle, STAGE_JOBS, DEFAULT_STAGES };
