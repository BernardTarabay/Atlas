-- The job queue moves from Redis into this table.
--
-- WHY
--
-- BullMQ needs Redis, Redis is not native to Windows, and the Windows build
-- this deployment used (Memurai) enforces two things in its Developer licence:
-- a maximum uptime of ten days, and no production use. The first stopped the
-- entire pipeline every ten days -- once, silently, for two days, because
-- /api/health checked Postgres and not Redis. The second makes shipping it to
-- a client a licence violation, so it could not simply be lived with.
--
-- Every remaining Redis-on-Windows option carries its own licence or install
-- burden (paid Memurai, Docker Desktop, WSL2). Postgres is already a hard
-- requirement of this application, so moving the queue there removes a whole
-- service from the install story rather than swapping one problem for another.
--
-- WHY NOT pg-boss
--
-- pg-boss is the obvious library and was the first choice. It was rejected for
-- a specific reason: it keeps its own job table. That would reintroduce exactly
-- the split this codebase already fought once -- `processing_jobs` is the
-- source of truth (see queues/index.js), BullMQ held a second copy, and the two
-- could disagree. There is a comment in enqueueJob about a Redis blip leaving a
-- row 'queued' with nothing on any queue to ever move it, which is that split
-- producing a stranded file.
--
-- Claiming work directly out of `processing_jobs` collapses the two into one.
-- The queue IS the source of truth. A row cannot be enqueued-but-not-recorded,
-- or recorded-but-not-enqueued, because there is only one row and one write.
--
-- WHAT THIS ADDS
--
-- `attempts`   how many times a job has been claimed. BullMQ held this; now the
--              row does, so retry budget survives a worker restart.
-- `run_after`  the earliest time a job may be claimed. This is the whole of
--              scheduling: exponential backoff is a future `run_after`, and a
--              retry is just a job that goes back to 'queued' with a later one.
--
-- HOW CLAIMING WORKS
--
-- A worker claims with `SELECT ... FOR UPDATE SKIP LOCKED` inside the same
-- UPDATE that flips the row to 'running'. SKIP LOCKED is what makes this safe
-- for several workers at once: each transaction takes a different row instead
-- of blocking on the same one, so concurrency needs no external coordination.
--
-- `bullmq_job_id` is left in place and stops being written. Dropping it would
-- discard the only record tying historical rows to the queue that ran them, and
-- these migrations are forward-only.

ALTER TABLE processing_jobs
  ADD COLUMN IF NOT EXISTS attempts   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS run_after  timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN processing_jobs.attempts IS
  'Times this job has been claimed by a worker. Compared against the retry budget in queues/pgQueue.js.';
COMMENT ON COLUMN processing_jobs.run_after IS
  'Earliest time this job may be claimed. Future values implement retry backoff and scheduling.';
COMMENT ON COLUMN processing_jobs.bullmq_job_id IS
  'VESTIGIAL as of migration 040 -- the queue no longer runs on Redis. Retained so historical rows keep their BullMQ id; never written by new code.';

-- The claim query's exact shape: pending rows of a given type, oldest first.
--
-- Partial on status so the index only carries work that is actually waiting.
-- Completed rows are the overwhelming majority of this table and would
-- otherwise bloat an index that is read on every single poll.
CREATE INDEX IF NOT EXISTS processing_jobs_claimable_idx
  ON processing_jobs (job_type, run_after, created_at)
  WHERE status = 'queued';

-- Recovering jobs abandoned by a killed worker means finding rows stuck in
-- 'running' with an old started_at, so that lookup gets its own partial index.
CREATE INDEX IF NOT EXISTS processing_jobs_running_idx
  ON processing_jobs (started_at)
  WHERE status = 'running';

-- Jobs stranded by the Redis outage that prompted all this: rows left 'queued'
-- pointing at a queue that no longer exists. They are valid work and the new
-- claim query will pick them up on its own -- but only if they are claimable
-- now rather than at whatever run_after the DEFAULT gave them, which for
-- pre-existing rows is the moment this migration ran. That is already now(),
-- so this is belt and braces for clarity rather than repair.
UPDATE processing_jobs SET run_after = now() WHERE status = 'queued';

-- A global pause switch for the queue.
--
-- BullMQ had `queue.pause()`, and scripts/_fixtureQueue.js depends on it: the
-- verify-* scripts build files in deliberately odd states ("never hashed",
-- "last job failed") and a live worker would process those fixtures out from
-- under the assertions. Deleting the rows afterwards is not enough, because the
-- worker claims them in the same millisecond they are created.
--
-- One row, enforced by a boolean primary key with a CHECK -- there is exactly
-- one queue, so a table that can hold two rows would only invite the question
-- of which one is in charge.
CREATE TABLE IF NOT EXISTS queue_control (
  id          boolean     PRIMARY KEY DEFAULT true CHECK (id),
  paused      boolean     NOT NULL DEFAULT false,
  paused_at   timestamptz,
  paused_by   text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO queue_control (id, paused) VALUES (true, false)
  ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE queue_control IS
  'Single-row global pause for the Postgres job queue. Honoured by pgQueue.claimNext; used by scripts/_fixtureQueue.js so verify scripts can set up fixtures without a live worker consuming them.';
