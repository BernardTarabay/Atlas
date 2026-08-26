// Live check of the Postgres job queue (migration 040) against real Postgres.
//
// WHY THIS EXISTS
//
// Moving the queue off Redis replaced four behaviours that BullMQ used to
// provide, and every one of them fails silently if it is wrong:
//
//   claiming        two workers taking the same job runs it twice
//   retry/backoff   a lost retry budget means a transient failure is permanent
//   stale recovery  a job abandoned by a killed worker sits 'running' forever
//   pause           a pause that does not hold breaks every verify-* fixture
//
// None of those show up in unit tests, because all four are properties of
// concurrent access to a real database. So they are exercised here against the
// actual server, with synthetic rows.
//
// Uses synthetic processing_jobs rows and NEVER runs a processor: the point is
// the queue mechanics, not what a job does. Every row it creates is tagged and
// removed in the finally block.
//
//   node scripts/verify-pg-queue.js
require("dotenv").config();
const db = require("../src/config/database");
const pgQueue = require("../src/queues/pgQueue");

const TAG = `verify-pg-queue-${Date.now()}`;
// `replicate` is the one job_type in the enum with NO processor -- declared for
// the opt-in server-side copy in migration 030 and deliberately unimplemented
// (see jobs/index.js). The worker builds its lanes from Object.keys(PROCESSORS),
// so it can never claim one of these.
//
// That property is what makes this script safe to run against a LIVE worker.
// It used to use `hash`, and passed only while no worker happened to be up: the
// moment one was running it claimed the synthetic rows first and the script
// failed at "a queued job is claimed" -- reporting a queue bug that was really
// a test racing the system it was testing.
const JOB_TYPE = "replicate";
const created = [];

let failures = 0;
function check(ok, label, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function makeJob({ status = "queued", attempts = 0, runAfter = "now()", startedAt = null } = {}) {
  const { rows } = await db.query(
    `INSERT INTO processing_jobs (job_type, status, payload, attempts, run_after, started_at)
     VALUES ($1, $2::job_status, $3::jsonb, $4, ${runAfter}, $5)
     RETURNING *`,
    [JOB_TYPE, status, JSON.stringify({ tag: TAG }), attempts, startedAt]
  );
  created.push(rows[0].id);
  return rows[0];
}

/** Only ever claims rows this script made, so a live worker cannot confuse it. */
async function claimOurs() {
  for (let i = 0; i < 20; i += 1) {
    const row = await pgQueue.claimNext([JOB_TYPE]);
    if (!row) return null;
    if (row.payload?.tag === TAG) return row;
    // Someone else's real job: put it straight back rather than running it.
    await db.query(
      "UPDATE processing_jobs SET status='queued', started_at=NULL, attempts=attempts-1 WHERE id=$1",
      [row.id]
    );
  }
  return null;
}

async function main() {
  // Pausing for the whole run keeps a live worker from racing us for the
  // synthetic rows. It is also the first thing under test.
  await pgQueue.setPaused(true, TAG);

  console.log("\n1. pause actually stops claiming");
  await makeJob();
  check((await pgQueue.claimNext([JOB_TYPE])) === null, "a paused queue hands out nothing");
  check((await pgQueue.isPaused()) === true, "isPaused reports the pause");

  await pgQueue.setPaused(false);
  console.log("\n2. claim moves queued -> running, exactly once");
  const claimed = await claimOurs();
  check(!!claimed, "a queued job is claimed");
  check(claimed?.status === "running", "claimed row is 'running'", `got ${claimed?.status}`);
  check(claimed?.attempts === 1, "attempts incremented to 1", `got ${claimed?.attempts}`);
  check(!!claimed?.started_at, "started_at was stamped by the claim");
  // The same job must not be claimable again -- this is the double-processing
  // guard that SKIP LOCKED plus the status flip is there to provide.
  const { rows: reclaim } = await db.query(
    "SELECT id FROM processing_jobs WHERE id=$1 AND status='queued'", [claimed.id]
  );
  check(reclaim.length === 0, "a claimed job is no longer claimable");

  console.log("\n3. concurrent claims never collide (FOR UPDATE SKIP LOCKED)");
  await Promise.all([makeJob(), makeJob(), makeJob(), makeJob()]);
  const concurrent = await Promise.all([claimOurs(), claimOurs(), claimOurs(), claimOurs()]);
  const ids = concurrent.filter(Boolean).map((r) => r.id);
  check(ids.length === 4, "four parallel claims returned four jobs", `got ${ids.length}`);
  check(new Set(ids).size === ids.length, "no job was handed to two claimants", `${new Set(ids).size} unique of ${ids.length}`);

  console.log("\n4. failure retries with exponential backoff, then gives up");
  const failing = await makeJob();
  const first = await claimOurs();
  const retried = await pgQueue.releaseFailed(first, "boom");
  check(retried === true, "first failure schedules a retry");
  const { rows: afterRetry } = await db.query("SELECT * FROM processing_jobs WHERE id=$1", [failing.id]);
  check(afterRetry[0].status === "queued", "retried job returns to 'queued'", `got ${afterRetry[0].status}`);
  check(new Date(afterRetry[0].run_after) > new Date(), "run_after is in the future (backoff)");
  check(afterRetry[0].error_message === "boom", "the failure reason is kept");
  check(afterRetry[0].started_at === null, "started_at cleared so the stale sweep ignores it");

  check(pgQueue.backoffMs(1) === 5000, "backoff attempt 1 = 5s", `got ${pgQueue.backoffMs(1)}`);
  check(pgQueue.backoffMs(2) === 10000, "backoff attempt 2 = 10s", `got ${pgQueue.backoffMs(2)}`);
  check(pgQueue.backoffMs(3) === 20000, "backoff attempt 3 = 20s", `got ${pgQueue.backoffMs(3)}`);

  const exhausted = await makeJob({ attempts: pgQueue.MAX_ATTEMPTS });
  const gaveUp = await pgQueue.releaseFailed(exhausted, "final boom");
  check(gaveUp === false, "a job out of attempts is not retried");
  const { rows: dead } = await db.query("SELECT * FROM processing_jobs WHERE id=$1", [exhausted.id]);
  check(dead[0].status === "failed", "exhausted job ends 'failed'", `got ${dead[0].status}`);
  check(!!dead[0].finished_at, "failed job is stamped finished_at");

  console.log("\n5. jobs abandoned by a dead worker are recovered");
  const abandoned = await makeJob({
    status: "running",
    attempts: 1,
    startedAt: new Date(Date.now() - pgQueue.STALE_RUNNING_MS - 60_000),
  });
  const fresh = await makeJob({ status: "running", attempts: 1, startedAt: new Date() });
  const recovered = await pgQueue.recoverStale();
  const recoveredIds = recovered.map((r) => r.id);
  check(recoveredIds.includes(abandoned.id), "a long-'running' job is recovered");
  check(!recoveredIds.includes(fresh.id), "a job that just started is left alone");
  const { rows: back } = await db.query("SELECT status FROM processing_jobs WHERE id=$1", [abandoned.id]);
  check(back[0].status === "queued", "recovered job is claimable again", `got ${back[0].status}`);

  const doomed = await makeJob({
    status: "running",
    attempts: pgQueue.MAX_ATTEMPTS,
    startedAt: new Date(Date.now() - pgQueue.STALE_RUNNING_MS - 60_000),
  });
  await pgQueue.recoverStale();
  const { rows: doomedAfter } = await db.query("SELECT status FROM processing_jobs WHERE id=$1", [doomed.id]);
  check(doomedAfter[0].status === "failed", "a job that keeps killing workers fails instead of looping",
    `got ${doomedAfter[0].status}`);

  console.log("\n6. NOTIFY does not throw and does not block an enqueue");
  await pgQueue.notifyJobAvailable();
  check(true, "notifyJobAvailable completed");
}

main()
  .catch((err) => {
    console.error("\nverify-pg-queue crashed:", err);
    failures += 1;
  })
  .finally(async () => {
    // Always hand the queue back. A queue left paused looks exactly like a
    // broken worker, and would be a genuinely nasty thing for a check to leave
    // behind.
    await pgQueue.setPaused(false).catch(() => {});
    if (created.length) {
      await db.query("DELETE FROM processing_jobs WHERE id = ANY($1::uuid[])", [created]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
    console.log(
      failures === 0
        ? `\nAll checks passed. Cleaned up ${created.length} synthetic job row(s).`
        : `\n${failures} check(s) FAILED.`
    );
    process.exit(failures === 0 ? 0 : 1);
  });
