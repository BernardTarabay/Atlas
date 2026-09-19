// JS-side mirrors of the Postgres enum types defined in
// backend/migrations/001_extensions.sql. Centralizing these avoids magic
// strings scattered across services/controllers/validators.

const UserStatus = Object.freeze({ ACTIVE: "active", SUSPENDED: "suspended", INVITED: "invited" });

const ConfidenceLevel = Object.freeze({ HIGH: "high", MEDIUM: "medium", LOW: "low" });

const StorageType = Object.freeze({
  LOCAL: "local", NAS: "nas", SERVER: "server", MANAGED: "managed", CLOUD: "cloud",
});

const StorageAccessMode = Object.freeze({ DIRECT: "direct", AGENT: "agent" });

const AgentStatus = Object.freeze({ ONLINE: "online", OFFLINE: "offline" });

const FileStatus = Object.freeze({
  ACTIVE: "active", MISSING: "missing", MOVED: "moved",
  CHANGED: "changed", DELETED: "deleted", ARCHIVED: "archived",
});

/** migration 032. The pipeline position of a file -- see services/pipelineState.js. */
const FilePipelineState = Object.freeze({
  DISCOVERED: "discovered", PROCESSING: "processing", NEEDS_USER: "needs_user",
  COMPLETED: "completed", FAILED_RETRYABLE: "failed_retryable",
  FAILED_TERMINAL: "failed_terminal", ARCHIVED: "archived",
});

/** migration 032. */
const OcrStatus = Object.freeze({
  NOT_NEEDED: "not_needed", PENDING: "pending", QUEUED: "queued", RUNNING: "running",
  COMPLETED: "completed", FAILED: "failed", UNAVAILABLE: "unavailable",
});

/** migration 030. */
const DeviceStatus = Object.freeze({
  ONLINE: "online", OFFLINE: "offline", NEVER_CONNECTED: "never_connected", REVOKED: "revoked",
});

/** migration 030. Where a file's bytes are, and whether they are current. */
const ReplicaState = Object.freeze({
  PRESENT: "present", MISSING: "missing", STALE: "stale", PENDING: "pending", FAILED: "failed",
});

const ProcessingStatus = Object.freeze({
  PENDING: "pending", PROCESSING: "processing", COMPLETED: "completed",
  FAILED: "failed", SKIPPED: "skipped",
});

const DocumentStatus = Object.freeze({ ACTIVE: "active", ARCHIVED: "archived", DELETED: "deleted" });

const VersionStatus = Object.freeze({ DRAFT: "draft", CONFIRMED: "confirmed", SUPERSEDED: "superseded" });

const DetectionMethod = Object.freeze({
  MANUAL: "manual", FILENAME_HEURISTIC: "filename_heuristic",
  CONTENT_SIMILARITY: "content_similarity", METADATA: "metadata",
  HASH: "hash", USER_CONFIRMED: "user_confirmed",
});

const RelevanceType = Object.freeze({ PRIMARY: "primary", SECONDARY: "secondary" });

const AssignedByType = Object.freeze({ SYSTEM: "system", USER: "user" });

const RelatedDocRelationship = Object.freeze({
  RELATED: "related", SUPERSEDES: "supersedes", REFERENCES: "references",
});

const DuplicateGroupType = Object.freeze({ EXACT: "exact", PROBABLE: "probable" });

const DuplicateGroupStatus = Object.freeze({ OPEN: "open", REVIEWED: "reviewed", RESOLVED: "resolved" });

const JobType = Object.freeze({
  SCAN: "scan", HASH: "hash", EXTRACT_METADATA: "extract_metadata",
  EXTRACT_TEXT: "extract_text", CLASSIFY: "classify",
  DETECT_DUPLICATES: "detect_duplicates", DETECT_VERSIONS: "detect_versions",
  GENERATE_NAMES: "generate_names", BULK_RENAME: "bulk_rename",
  BULK_MOVE: "bulk_move", REINDEX: "reindex", BULK_DELETE: "bulk_delete",
  AUTO_RESOLVE_DUPLICATES: "auto_resolve_duplicates", EMAIL_SYNC: "email_sync",
  SYNC_MIRROR: "sync_mirror",
  // migration 031. OCR is implemented (jobs/processors/ocrProcessor.js);
  // REPLICATE is declared but has no processor -- see jobs/index.js.
  OCR: "ocr", REPLICATE: "replicate",
  // migration 034. One plain-language description per file, and the embedding
  // that makes it findable by describing it -- services/descriptionService.js.
  DESCRIBE: "describe",
  // migration 038. Empties the Trash on a timer -- the only job that removes
  // rows for good. See jobs/processors/purgeTrashProcessor.js for what makes
  // that safe to run unattended.
  PURGE_TRASH: "purge_trash",
  // migration 043. Files the unfiled pile, creating the folders it needs --
  // services/unfiledOrganizer.js.
  ORGANIZE_UNFILED: "organize_unfiled",
  // migration 045. Retention for finished jobs and pipeline telemetry -- the
  // counterpart to PURGE_TRASH, which bounds files rather than history. See
  // jobs/processors/purgeOperationalProcessor.js for the allowlist that makes
  // it safe to run unattended.
  PURGE_OPERATIONAL: "purge_operational",
});

const JobStatus = Object.freeze({
  QUEUED: "queued", RUNNING: "running", COMPLETED: "completed",
  FAILED: "failed", CANCELLED: "cancelled", RETRYING: "retrying",
});

const JobItemStatus = Object.freeze({
  PENDING: "pending", SUCCEEDED: "succeeded", FAILED: "failed", SKIPPED: "skipped",
});

const ProposalStatus = Object.freeze({
  PENDING: "pending", APPROVED: "approved", REJECTED: "rejected",
  APPLIED: "applied", SUPERSEDED: "superseded",
});

const ClassificationStatus = Object.freeze({
  PROPOSED: "proposed", CONFIRMED: "confirmed", REJECTED: "rejected",
});

const ClassificationMethod = Object.freeze({ RULE: "rule", ML: "ml", LLM: "llm", MANUAL: "manual" });

const AuditStatus = Object.freeze({ SUCCESS: "success", FAILED: "failed" });

const SubjectLevel = Object.freeze({ SUBJECT: "subject", CATEGORY: "category", SUBCATEGORY: "subcategory" });

// Gmail only. The Outlook/Microsoft Graph provider was removed -- see
// services/emailAccountService.js. The Postgres enum still carries 'outlook'
// as a value (dropping a value from an enum in place is not supported and
// would break any historical row), but nothing accepts it: assertValidProvider
// checks against THIS object, so an 'outlook' connection can no longer be
// created, refreshed or synced.
const EmailProvider = Object.freeze({ GMAIL: "gmail" });

const EmailAccountStatus = Object.freeze({ CONNECTED: "connected", DISCONNECTED: "disconnected", ERROR: "error" });

const InboxMessageClassification = Object.freeze({ IMPORTANT: "important", JUNK: "junk" });

const InboxMessageStatus = Object.freeze({ KEPT: "kept", DELETED: "deleted" });

module.exports = {
  UserStatus, ConfidenceLevel, StorageType, StorageAccessMode, AgentStatus,
  FileStatus, FilePipelineState, OcrStatus, DeviceStatus, ReplicaState, ProcessingStatus, DocumentStatus, VersionStatus, DetectionMethod,
  RelevanceType, AssignedByType, RelatedDocRelationship, DuplicateGroupType,
  DuplicateGroupStatus, JobType, JobStatus, JobItemStatus, ProposalStatus,
  ClassificationStatus, ClassificationMethod, AuditStatus, SubjectLevel,
  EmailProvider, EmailAccountStatus, InboxMessageClassification, InboxMessageStatus,
};
