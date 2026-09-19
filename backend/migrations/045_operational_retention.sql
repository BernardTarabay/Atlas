-- Retention for the two tables that grow with WORK rather than with content.
--
-- WHY THESE TWO TABLES NEEDED A POLICY AND THE OTHERS DID NOT
--
-- Everything else in this schema grows with the archive: one row per file, per
-- classification, per duplicate group. `processing_jobs` and `audit_logs` grow
-- with the number of times something HAPPENED, which is unbounded and unrelated
-- to how many documents the user actually has.
--
-- Nothing anywhere deleted from either. The only DELETE against audit_logs in
-- the whole codebase was a full-table wipe in db/resetData.js, and there was no
-- DELETE against processing_jobs at all. There was a purge job for the Trash --
-- for FILES, which are the thing that does not grow without bound -- and none
-- for the two tables that do.
--
-- The bill for that, measured on this installation:
--
--     processing_jobs   7,885,175 rows   4,647 MB
--     audit_logs        2,040,488 rows     623 MB
--     files                 7,260 rows      48 MB
--
-- 5.2 GB of a 5.4 GB database, for a library of 7,260 documents. A scan-recovery
-- loop (fixed separately, see fileRepository.listUnprocessed) produced most of
-- it, but the loop is only why it happened so fast. Without retention a healthy
-- pipeline still writes ~9 job rows and ~9 audit rows per file on first ingest
-- and keeps every one of them forever, so a 1M-file archive carries ~9M rows of
-- operational history it will never read.
--
-- WHAT IS DELETED AND WHAT IS NEVER DELETED
--
-- The distinction is not age, it is PURPOSE. `audit_logs` currently holds two
-- different things under one name:
--
--   telemetry   "this file was hashed". Mechanical, high-volume, and of no
--               interest a week later. 1.94M of the 2.04M rows.
--   the record  "this user signed in", "this file was downloaded", "this file
--               was renamed". Low-volume, and the reason an audit log exists.
--
-- Only the first is purgeable, and only by an EXPLICIT ALLOWLIST of action
-- names (see jobs/processors/purgeOperationalProcessor.js). A denylist would
-- silently start purging any new action someone adds, which is exactly the
-- mistake that turns an audit trail into a cache.
--
-- WHY NOT PARTITIONING
--
-- The obvious answer to a 7.8M-row table is monthly partitions and DROP
-- PARTITION instead of DELETE. It is deferred deliberately: converting a live
-- table requires a full rewrite and a swap, and once retention is actually
-- running the table stays small enough that an indexed incremental DELETE is
-- cheap. Partitioning solves a problem this table will no longer have. Revisit
-- if a single owner's steady-state job count ever justifies it.

-- The purge itself, as a job_type, for the same reason purge_trash is one
-- (migration 038): a scheduler that deleted rows outside enqueueJob would be
-- the one destructive operation with no record of having run. It appears on the
-- Processing Jobs page, it is claimed by the ordinary queue, and it is
-- audit-logged -- with an action name that is NOT itself purgeable.
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'purge_operational';

-- The purge's own access path.
--
-- Without this, deleting completed jobs older than N days is a sequential scan
-- of the whole table -- which is the one thing a retention job must not be,
-- since it runs precisely when the table is large. Partial on 'completed'
-- because that is the only status the sweep deletes in bulk; failed jobs are
-- kept far longer and are three orders of magnitude rarer.
CREATE INDEX IF NOT EXISTS processing_jobs_retention_idx
  ON processing_jobs (owner_user_id, finished_at)
  WHERE status = 'completed';

-- Same access path for the audit sweep: by owner, by age, filtered to the
-- handful of action names the allowlist permits. `action` leads because it is
-- the most selective of the three once telemetry is a minority of the table.
CREATE INDEX IF NOT EXISTS audit_logs_retention_idx
  ON audit_logs (action, created_at);

COMMENT ON INDEX processing_jobs_retention_idx IS
  'Supports the purge_operational sweep. See migration 045.';
COMMENT ON INDEX audit_logs_retention_idx IS
  'Supports the purge_operational sweep over telemetry actions. See migration 045.';
