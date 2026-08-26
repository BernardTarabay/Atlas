// Proves `failed_retryable` is no longer a dead-end state.
//
// THE INCIDENT THIS ANSWERS
//
// On 2026-08-26 a since-removed daily AI cap failed the `describe` stage for
// 5,730 files in four minutes. Every one was correctly marked
// `failed_retryable` with one attempt spent of a budget of three -- a state
// that services/pipelineState.js documents as "a stage failed and retrying is
// still worth doing".
//
// Nothing retried them. Grepping src/ for the state returned one hit outside
// the state machine: the enum that defines it. The cap was then removed, the
// worker restarted with the fix, and the pipeline touched those same rows for
// another thirteen hours -- leaving all of them exactly where they were, while
// /api/health reported "ok". 72% of the library, waiting on a promise no code
// kept.
//
// WHAT MAKES THIS SCRIPT WORTH ANYTHING
//
// Asserting "the sweep requeued something" would pass just as happily if the
// sweep requeued a file forever, which is the failure that actually matters:
// an infinite retry loop is not recovery, it is the same file failing over and
// over with nobody told. So this checks BOTH directions -- that a file inside
// its budget comes back, and that a file out of budget is put somewhere
// terminal and stops being reconsidered.
//
//     node scripts/verify-file-recovery.js

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const env = require("../src/config/env");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const fileRecovery = require("../src/services/fileRecovery");
const pipelineState = require("../src/services/pipelineState");
const pgQueue = require("../src/queues/pgQueue");
const { closeAllQueues } = require("../src/queues");
const { dequeueFixtureJobs, pauseQueues, resumeQueues } = require("./_fixtureQueue");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

let root, locId, ownerId;

async function cleanup() {
  try {
    if (locId) {
      const ids = `(SELECT id::text FROM files WHERE storage_location_id='${locId}')`;
      // Jobs first: a file row cannot go while something still references it.
      // Both shapes, because a job may be tied to the file or to the location.
      await p.query(`DELETE FROM processing_jobs WHERE payload->>'fileId' IN ${ids}`);
      await p.query(`DELETE FROM processing_jobs WHERE storage_location_id='${locId}'`);
      await p.query(`DELETE FROM file_descriptions WHERE file_id::text IN ${ids}`).catch(() => {});
      await p.query(`DELETE FROM file_content WHERE file_id::text IN ${ids}`);
      await p.query(`DELETE FROM classification_results WHERE file_id::text IN ${ids}`);
      await p.query(`DELETE FROM files WHERE storage_location_id='${locId}'`);
      await p.query(`DELETE FROM storage_locations WHERE id='${locId}'`);
    }
  } catch (err) {
    console.error("cleanup:", err.message);
  }
  if (root) await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  await resumeQueues().catch(() => {});
  await p.end().catch(() => {});
  await closeAllQueues().catch(() => {});
}

/** Put a file into exactly the state the incident left 5,730 files in. */
async function strand(fileId, stage, attempts, reason) {
  await p.query(
    `UPDATE files
        SET pipeline_state = 'failed_retryable',
            pipeline_stage = $2,
            failure_stage  = $2,
            failure_reason = $4,
            retry_counts   = jsonb_build_object($2::text, $3::int),
            state_changed_at = now() - interval '1 hour'
      WHERE id = $1`,
    [fileId, stage, attempts, reason]
  );
}

const stateOf = async (fileId) => {
  const { rows } = await p.query(
    "SELECT pipeline_state, failure_stage, failure_reason, retry_counts FROM files WHERE id = $1",
    [fileId]
  );
  return rows[0];
};

const jobsFor = async (fileId) => {
  const { rows } = await p.query(
    "SELECT job_type, status FROM processing_jobs WHERE payload->>'fileId' = $1",
    [fileId]
  );
  return rows;
};

(async () => {
  await pauseQueues();

  root = await fsp.mkdtemp(path.join(os.tmpdir(), "atlas-recovery-"));
  for (const name of ["alpha.txt", "beta.txt", "gamma.txt", "delta.txt"]) {
    await fsp.writeFile(path.join(root, name), `contents of ${name}\n`, "utf8");
  }

  const { rows: users } = await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1");
  ownerId = users[0].id;

  const loc = await storageLocationService.create(
    { name: "__verify_file_recovery__", rootPath: root, isReadOnly: true },
    ownerId
  );
  locId = loc.id;

  await scanProcessor.handle({ storageLocationId: locId }, { updateProgress: async () => {} });
  await dequeueFixtureJobs(p, locId);

  const { rows: files } = await p.query(
    "SELECT id, filename_current FROM files WHERE storage_location_id=$1 ORDER BY filename_current",
    [locId]
  );
  const [alpha, beta, gamma, delta] = files;

  console.log(`\nfixture: ${files.length} files in a read-only location\n`);

  // -----------------------------------------------------------------
  console.log("1. A file inside its retry budget is put back into the pipeline");
  await strand(alpha.id, "describe", 1, "Daily AI call cap (500) reached.");
  const before = await stateOf(alpha.id);
  check("the fixture really is stranded", before.pipeline_state === "failed_retryable",
    `state=${before.pipeline_state} stage=${before.failure_stage} attempts=${before.retry_counts.describe}`);

  const r1 = await fileRecovery.recoverStranded({ limit: 50, storageLocationId: locId });
  const afterAlpha = await stateOf(alpha.id);
  const alphaJobs = await jobsFor(alpha.id);
  check("the sweep requeued it", r1.requeued >= 1, `requeued ${r1.requeued}, byStage ${JSON.stringify(r1.byStage)}`);
  check("...as the stage that actually failed, not a guess",
    alphaJobs.some((j) => j.job_type === "describe"),
    alphaJobs.map((j) => `${j.job_type}:${j.status}`).join(" ") || "no jobs");
  check("...and the file left the dead-end state",
    afterAlpha.pipeline_state === "processing", `now ${afterAlpha.pipeline_state}`);

  // -----------------------------------------------------------------
  console.log("\n2. Retrying is not infinite -- an exhausted budget ends in a terminal state");
  await strand(beta.id, "describe", pipelineState.MAX_RETRIES_PER_STAGE, "Failed every time.");
  const r2 = await fileRecovery.recoverStranded({ limit: 50, storageLocationId: locId });
  const afterBeta = await stateOf(beta.id);
  check("it was NOT requeued", (await jobsFor(beta.id)).length === 0, `exhausted ${r2.exhausted}`);
  check("...it was moved to failed_terminal instead",
    afterBeta.pipeline_state === "failed_terminal", `now ${afterBeta.pipeline_state}`);
  check("...and the reason says the machine gave up, in words",
    /gave up after \d+ attempts/i.test(afterBeta.failure_reason || ""),
    afterBeta.failure_reason);

  const r2b = await fileRecovery.recoverStranded({ limit: 50, storageLocationId: locId });
  check("...and a terminal file is never reconsidered again",
    !(await jobsFor(beta.id)).length && r2b.exhausted === 0,
    "second sweep left it alone");

  // -----------------------------------------------------------------
  console.log("\n3. A stage no worker can re-run is admitted, not retried forever");
  await strand(gamma.id, "teleport", 0, "Something impossible failed.");
  const r3 = await fileRecovery.recoverStranded({ limit: 50, storageLocationId: locId });
  const afterGamma = await stateOf(gamma.id);
  check("an unknown stage is not enqueued as undefined",
    (await jobsFor(gamma.id)).length === 0, `unrecoverable ${r3.unrecoverable}`);
  check("...the file is terminal and says why",
    afterGamma.pipeline_state === "failed_terminal" && /no job re-runs/i.test(afterGamma.failure_reason || ""),
    afterGamma.failure_reason);

  // -----------------------------------------------------------------
  console.log("\n4. A file already being worked on is not enqueued twice");
  await strand(delta.id, "describe", 1, "Transient failure.");
  await p.query(
    `INSERT INTO processing_jobs (job_type, status, payload, owner_user_id, storage_location_id, created_at)
     VALUES ('describe', 'queued', jsonb_build_object('fileId', $1::text), $2, $3, now())`,
    [delta.id, ownerId, locId]
  );
  const r4 = await fileRecovery.recoverStranded({ limit: 50, storageLocationId: locId });
  const deltaJobs = await jobsFor(delta.id);
  check("the live job is left to run rather than duplicated",
    deltaJobs.length === 1, `${deltaJobs.length} job(s) for it`);
  check("...and the sweep did not touch the file",
    (await stateOf(delta.id)).pipeline_state === "failed_retryable",
    `scanned ${r4.scanned}, requeued ${r4.requeued}`);

  // -----------------------------------------------------------------
  console.log("\n5. The backlog is reported, not silent");
  await strand(delta.id, "describe", 1, "Transient failure.");
  const summary = await fileRecovery.strandedSummary();
  check("strandedSummary counts files awaiting recovery",
    summary.retryable >= 1, `retryable=${summary.retryable} terminal=${summary.terminal}`);
  check("...and counts the ones it gave up on separately",
    summary.terminal >= 2, `terminal=${summary.terminal}`);

  // -----------------------------------------------------------------
  console.log("\n6. A fixture pause cannot outlive the process holding it");
  const paused = await pgQueue.pauseState();
  check("this script's own pause is a LEASE, not an indefinite halt",
    paused.effective && paused.kind === "lease",
    `kind=${paused.kind} by=${paused.by} leaseLeft=${paused.leaseSecondsLeft}s`);
  check("...so a SIGKILLed script releases the live queue by expiry, with no cleanup",
    paused.leaseSecondsLeft > 0 && paused.leaseSecondsLeft <= 60,
    `${paused.leaseSecondsLeft}s left`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})()
  .catch((err) => { console.error("\nFAILED:", err); process.exitCode = 1; })
  .finally(cleanup);
