-- A global queue pause that cannot outlive the process that asked for it.
--
-- WHY
--
-- Migration 040 gave the queue a global pause switch, because the verify-*
-- scripts need one: they build files in deliberately odd states ("never
-- hashed", "last job failed") and a live worker would process those fixtures
-- out from under the assertions. That pause is correct and stays.
--
-- What was wrong is its LIFETIME. The pause was a plain boolean released by
-- the script's own cleanup:
--
--     })().catch(...).finally(cleanup);       -- cleanup calls resumeQueues()
--
-- and scripts/verify-all.js kills a script that overruns its timeout with
--
--     child.kill("SIGKILL");                  -- after 180s
--
-- SIGKILL cannot be caught, so `finally` never runs. The mechanism that exists
-- to stop one hung script from holding up a test run was therefore also the
-- mechanism that left ALL document processing globally halted, indefinitely,
-- with no resume and nothing to notice -- on a database holding a real
-- library. A verification tool must not be able to take production down by
-- timing out.
--
-- THE FIX: A LEASE, NOT A FLAG
--
-- `paused_until` makes the pause self-expiring. A fixture pause takes a short
-- lease and renews it with a heartbeat for as long as the script is alive; if
-- the script dies in any way at all -- SIGKILL, a power cut, a pulled network
-- cable -- the renewals stop and the lease lapses on its own. Nothing has to
-- run at cleanup time for the queue to come back, which is the only property
-- that actually survives SIGKILL.
--
-- A NULL `paused_until` still means "paused indefinitely". That is deliberate:
-- an operator pausing the queue by hand should stay paused until they say
-- otherwise, and should NOT be silently resumed by a timer. The two cases are
-- distinguished rather than merged --
--
--     paused = true, paused_until = <future>   a fixture holding a lease
--     paused = true, paused_until = NULL       a person meant it
--
-- -- so that "the queue is paused" can finally answer the question that
-- matters when you find it paused: is this a test that died, or did someone
-- do this on purpose?

ALTER TABLE queue_control
  ADD COLUMN IF NOT EXISTS paused_until timestamptz;

COMMENT ON COLUMN queue_control.paused_until IS
  'Lease expiry for a temporary pause. NULL = paused indefinitely (a human did it). A future value = a fixture pause that lapses on its own if the process holding it dies, which is what makes a SIGKILLed verify script unable to leave the live queue paused.';

COMMENT ON COLUMN queue_control.paused_by IS
  'Who or what paused the queue. Fixture pauses identify themselves as verify-script:<name> so an unexpected pause names its own cause.';

-- Any pause left over from before this migration is, by definition, one
-- nothing is renewing -- including the exact case this fixes, a verify script
-- SIGKILLed mid-run. Release it rather than inheriting a halt whose owner no
-- longer exists.
UPDATE queue_control
   SET paused = false, paused_at = NULL, paused_by = NULL, paused_until = NULL, updated_at = now()
 WHERE paused = true;
