-- The index the health check itself needs.
--
-- WHY A HEALTH CHECK NEEDS AN INDEX AT ALL
--
-- services/pipelineHealth.js answers "is the pipeline doing redundant work" by
-- aggregating processing_jobs over the last 24 hours. That question is asked on
-- every /api/health call -- and restart-atlas.bat polls that endpoint with
-- `curl -f` on every start, so it sits in the path of the startup check.
--
-- Without an index on created_at the aggregate is a sequential scan of
-- processing_jobs. That is free on a healthy table of ~70,000 rows and was a
-- five-second scan of 7.9 million during the incident these ratios exist to
-- detect. Which is the trap: the check would have become slowest at exactly the
-- moment it had something to report, and a health endpoint that times out reads
-- as "the server is down" rather than "the pipeline is looping". A diagnostic
-- whose cost scales with the problem it diagnoses is not a diagnostic.
--
-- BRIN RATHER THAN BTREE
--
-- created_at correlates almost perfectly with physical row order -- rows are
-- appended and never updated in place -- which is the exact case BRIN is for.
-- It stores a summary per block range instead of an entry per row, so it is
-- a few dozen KB against tens of megabytes for the btree equivalent, and this
-- table's whole problem has been its size. The tradeoff is that BRIN is poor at
-- pinpointing individual rows, which does not matter here: every query it
-- serves is "everything since a timestamp", a contiguous range at the end of
-- the table.
CREATE INDEX IF NOT EXISTS processing_jobs_created_brin
  ON processing_jobs USING brin (created_at);

COMMENT ON INDEX processing_jobs_created_brin IS
  'Serves the 24h ratio aggregates in services/pipelineHealth.js. BRIN because created_at is physically ordered and this table must not carry a large index. See migration 046.';
