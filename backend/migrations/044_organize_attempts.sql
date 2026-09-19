-- Stop the organizer reconsidering the same unfilable files forever.
--
-- THE FAILURE THIS CLOSES
--
-- unfiledOrganizer takes the unfiled pile ordered by imported_at and plans the
-- first ~120. That is fine while it is filing them. It is a money leak the
-- moment it is not: a batch the planner cannot categorise is left unfiled, so
-- the NEXT run selects the identical 120 files, sends the identical prompt, and
-- gets the identical answer. The scheduler runs hourly. Nothing about that loop
-- terminates, and every lap costs a planning call.
--
-- It is not hypothetical -- it happened the first time the junk-name guard did
-- its job. The planner proposed "Placeholder Real Estate Documents" for a whole
-- batch, the guard refused it (correctly: a folder named for the fact that
-- nobody could read the contents is a junk drawer), and the pass filed zero of
-- 120. Left alone, that batch would have been re-planned every hour forever.
--
-- WHY A COUNT AND NOT A FLAG
--
-- "Could not be filed" is not permanent. The archive grows, the taxonomy grows,
-- and a document nothing could place in March may sit obviously inside a folder
-- that exists by June. A boolean would exclude it for good. A COUNT lets it be
-- reconsidered a few times -- against a genuinely different tree each time --
-- and then leaves it alone, which is the same shape as the per-stage retry
-- budget in services/pipelineState.js and for the same reason: after three
-- honest attempts at the same question, the answer is not going to change by
-- asking a fourth time.
--
-- Resetting these to 0 is the supported way to force a full re-examination
-- after the taxonomy has changed substantially.

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS organize_attempts    integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS organize_attempted_at timestamptz;

COMMENT ON COLUMN files.organize_attempts IS
  'How many times the unfiled organizer has considered this file and failed to place it. Compared against MAX_ORGANIZE_ATTEMPTS in services/unfiledOrganizer.js; set back to 0 to re-examine a file after the taxonomy has changed.';
COMMENT ON COLUMN files.organize_attempted_at IS
  'When the organizer last considered this file without placing it.';

-- The claim query is "unfiled, and not given up on", so the index carries only
-- files that are still candidates.
CREATE INDEX IF NOT EXISTS files_organize_candidates_idx
  ON files (owner_user_id, imported_at DESC)
  WHERE status = 'active' AND deleted_at IS NULL AND organize_attempts < 3;
