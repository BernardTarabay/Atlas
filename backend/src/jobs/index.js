// job_type -> processor module registry. Adding a new stage is: write a
// processor exposing handle(payload, bullJob), add one line here, and (if it
// should be independently queued) confirm the job_type enum value exists in
// migration 001. Nothing else needs to change.
const { JobType } = require("../models/enums");

const scanProcessor = require("./processors/scanProcessor");
const hashProcessor = require("./processors/hashProcessor");
const extractMetadataProcessor = require("./processors/extractMetadataProcessor");
const extractTextProcessor = require("./processors/extractTextProcessor");
const classifyProcessor = require("./processors/classifyProcessor");
const detectDuplicatesProcessor = require("./processors/detectDuplicatesProcessor");
const generateNamesProcessor = require("./processors/generateNamesProcessor");
const bulkRenameProcessor = require("./processors/bulkRenameProcessor");
const bulkDeleteProcessor = require("./processors/bulkDeleteProcessor");
const bulkMoveProcessor = require("./processors/bulkMoveProcessor");
const autoResolveDuplicatesProcessor = require("./processors/autoResolveDuplicatesProcessor");
const emailSyncProcessor = require("./processors/emailSyncProcessor");
const detectVersionsProcessor = require("./processors/detectVersionsProcessor");
const reindexProcessor = require("./processors/reindexProcessor");
const syncMirrorProcessor = require("./processors/syncMirrorProcessor");
const ocrProcessor = require("./processors/ocrProcessor");
const describeProcessor = require("./processors/describeProcessor");
const purgeTrashProcessor = require("./processors/purgeTrashProcessor");
const organizeUnfiledProcessor = require("./processors/organizeUnfiledProcessor");
const purgeOperationalProcessor = require("./processors/purgeOperationalProcessor");

// `bulk_move` IS implemented now (processors/bulkMoveProcessor.js).
//
// It used to be noted here as superseded, on the reasoning that "filing a
// document under a subject is a database-only operation handled synchronously
// by fileOrganizeService, so it never needed a queue". That was true while
// every caller arrived with a hand-picked list of files. It stopped being true
// with move-by-filter: a filter has no size the user can see before running it,
// so the same sentence can match nine files or ninety thousand, and that has to
// be watchable work rather than a request that appears to hang.
//
// `replicate` remains the one job_type with no processor. It exists in the enum
// for the opt-in server-side copy described in migration 030, and is NOT
// implemented. Enqueuing it sits queued and unpicked rather than silently
// pretending to run -- an honest failure mode.
const PROCESSORS = {
  [JobType.SCAN]: scanProcessor,
  [JobType.HASH]: hashProcessor,
  [JobType.EXTRACT_METADATA]: extractMetadataProcessor,
  [JobType.EXTRACT_TEXT]: extractTextProcessor,
  [JobType.CLASSIFY]: classifyProcessor,
  [JobType.DETECT_DUPLICATES]: detectDuplicatesProcessor,
  [JobType.DETECT_VERSIONS]: detectVersionsProcessor,
  [JobType.REINDEX]: reindexProcessor,
  [JobType.SYNC_MIRROR]: syncMirrorProcessor,
  [JobType.OCR]: ocrProcessor,
  [JobType.DESCRIBE]: describeProcessor,
  [JobType.PURGE_TRASH]: purgeTrashProcessor,
  [JobType.ORGANIZE_UNFILED]: organizeUnfiledProcessor,
  [JobType.PURGE_OPERATIONAL]: purgeOperationalProcessor,
  [JobType.GENERATE_NAMES]: generateNamesProcessor,
  [JobType.BULK_RENAME]: bulkRenameProcessor,
  [JobType.BULK_DELETE]: bulkDeleteProcessor,
  [JobType.BULK_MOVE]: bulkMoveProcessor,
  [JobType.AUTO_RESOLVE_DUPLICATES]: autoResolveDuplicatesProcessor,
  [JobType.EMAIL_SYNC]: emailSyncProcessor,
};

module.exports = { PROCESSORS };
