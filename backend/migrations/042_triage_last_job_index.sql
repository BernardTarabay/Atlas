-- Make the Triage page answerable again.
--
-- THE SYMPTOM
--
-- `GET /api/triage/summary` stopped returning. Not "got slow" -- it exceeded
-- the 60s statement_timeout (config/database.js) and the page showed an error;
-- raised to 300s it was still running past two minutes. 25 timeouts in the API
-- error log. The Triage queue is where a user goes to find out what the
-- pipeline could not finish, so this failed exactly when the archive got big
-- enough to need it.
--
-- WHY
--
-- triageRepository's shared TRIAGED body carries a lateral that finds the most
-- recent job for each file:
--
--     LEFT JOIN LATERAL (
--       SELECT ... FROM processing_jobs pj
--        WHERE pj.payload->>'fileId' = f.id::text
--        ORDER BY pj.created_at DESC
--        LIMIT 1
--     ) lj ON true
--
-- There was no index that could serve it, for two near-misses:
--
--   idx_processing_jobs_active_file  is on (payload->>'fileId') but PARTIAL:
--                                    WHERE status IN ('queued','running'). The
--                                    sibling `active` lateral only looks at
--                                    live jobs and uses it happily. `lj` looks
--                                    at jobs of EVERY status -- the last job is
--                                    almost always a completed one -- so the
--                                    index excludes precisely the rows it needs.
--   idx_processing_jobs_payload_gin  is GIN over the whole payload. GIN answers
--                                    containment (payload @> '{...}'), not the
--                                    btree equality payload->>'fileId' = $1.
--
-- So the lateral fell back to a sequential scan of processing_jobs, per file.
-- At 7,260 triage-eligible files and 269,165 job rows that is on the order of
-- two billion row visits for one page load, and it grows with BOTH the library
-- and the job history -- the job table only ever accumulates.
--
-- THE FIX
--
-- One btree index shaped like the query: equality on the extracted fileId,
-- then created_at descending so the ORDER BY ... LIMIT 1 is satisfied by
-- walking one index entry rather than sorting a file's whole job history.
--
-- NOT partial on `payload ? 'fileId'`, deliberately. Only 662 of 269,165 rows
-- lack a fileId (repository-wide jobs: scan, bulk_rename, bulk_delete), so the
-- partial version saves nothing measurable -- and it would require the planner
-- to prove that `payload->>'fileId' = $1` implies `payload ? 'fileId'`, which
-- it does not reliably do. An index the planner declines to use is worse than
-- a slightly larger one it uses every time.
--
-- This also speeds up triageRepository.list and findOne, which share the same
-- body -- the summary was simply the first to exceed the timeout, because it
-- runs the lateral for every eligible file instead of one page of them.

CREATE INDEX IF NOT EXISTS processing_jobs_file_recent_idx
  ON processing_jobs ((payload->>'fileId'), created_at DESC);

COMMENT ON INDEX processing_jobs_file_recent_idx IS
  'Serves the "most recent job for this file" lateral in triageRepository (and anything else asking for a file''s job history newest-first). Covers ALL statuses, which is what distinguishes it from idx_processing_jobs_active_file.';

ANALYZE processing_jobs;
