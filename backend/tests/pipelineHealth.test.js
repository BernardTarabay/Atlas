// The ratio signals, and the thresholds that decide when they speak.
//
// These are the checks that would have caught the scan-recovery loop, so what
// matters most is not that they fire, but that they fire at the right MARGIN.
// A threshold set too tight cries wolf on a normal busy day and gets ignored,
// at which point it is not a check at all -- which is the same failure as
// having none, arrived at by a different route.
//
// The database-backed query is exercised in tests/bodyLimits-style integration
// only where it is cheap; here the arithmetic and the threshold decisions are
// tested directly, because those are the parts that are easy to get wrong and
// impossible to notice being wrong in production until an incident.
const test = require("node:test");
const assert = require("node:assert");

const pipelineHealth = require("../src/services/pipelineHealth");
const pgQueue = require("../src/queues/pgQueue");
const pipelineState = require("../src/services/pipelineState");

test("the per-file threshold sits above every legitimate retry path", () => {
  // A file can legitimately be re-run by two independent budgets stacking:
  // the queue retries a failing job (MAX_ATTEMPTS) and the pipeline re-runs a
  // failing stage (MAX_RETRIES_PER_STAGE). The worst honest case is their
  // product; a person re-running by hand adds a little more.
  const worstLegitimate = pgQueue.MAX_ATTEMPTS * pipelineState.MAX_RETRIES_PER_STAGE;

  assert.ok(
    pipelineHealth.MAX_RUNS_PER_FILE_PER_DAY >= worstLegitimate,
    `threshold ${pipelineHealth.MAX_RUNS_PER_FILE_PER_DAY} must not fire on the worst legitimate ` +
    `case of ${worstLegitimate} (${pgQueue.MAX_ATTEMPTS} job attempts x ${pipelineState.MAX_RETRIES_PER_STAGE} stage retries)`
  );
});

test("the per-file threshold sits far below what the incident produced", () => {
  // The loop ran one stage 1,379 times for one file in 37 hours. A threshold
  // anywhere near that would have been useless; the point of this assertion is
  // that the gap between "legitimate" and "broken" is enormous, so the
  // threshold is easy to place and hard to trip by accident.
  const observedDuringIncident = 1379;
  assert.ok(
    pipelineHealth.MAX_RUNS_PER_FILE_PER_DAY < observedDuringIncident / 100,
    "the threshold should be at least two orders of magnitude below the observed loop"
  );
});

test("the scan multiplier allows a busy day but not a runaway", () => {
  // 60-minute cadence => ~24 scans/day expected. Event-driven scans push that
  // up legitimately whenever someone is actually saving files, so the ceiling
  // has to be a multiple rather than the bare expectation.
  const expectedPerDay = 24;
  const ceiling = expectedPerDay * pipelineHealth.SCAN_RATE_MULTIPLIER;
  const observedDuringIncident = 1549;

  assert.ok(ceiling > 100, "a day of real editing must not trip this");
  assert.ok(
    ceiling < observedDuringIncident,
    `ceiling ${ceiling} must be below the ${observedDuringIncident} scans/day the loop produced`
  );
});

test("ratios() reports the shape /api/health depends on", async () => {
  // A contract test, not a value test: app.js reads these keys by name and a
  // rename would silently turn the health payload's `pipeline` block into
  // undefineds rather than failing anywhere visible.
  const r = await pipelineHealth.ratios();

  for (const key of [
    "jobs24h", "activeFiles", "jobsPerFile", "worstFile", "worstLocation",
    "expectedScansPerDay", "operationalBytes", "operationalBytesPerFile", "warnings",
  ]) {
    assert.ok(key in r, `ratios() must report "${key}"`);
  }
  assert.ok(Array.isArray(r.warnings), "warnings must be an array so app.js can spread it");
  assert.ok(typeof r.jobsPerFile === "number" && Number.isFinite(r.jobsPerFile));
});

test("ratios() does not divide by zero on an empty library", async () => {
  // activeFiles is a denominator twice. On a fresh install it is 0, and the
  // health endpoint must not answer NaN or Infinity -- restart-atlas.bat polls
  // it with `curl -f` on every start, including the very first one.
  const r = await pipelineHealth.ratios();
  assert.ok(Number.isFinite(r.jobsPerFile), "jobsPerFile must be finite");
  assert.ok(Number.isFinite(r.operationalBytesPerFile), "operationalBytesPerFile must be finite");
});

test("worstFile is null or fully populated, never half-built", async () => {
  // app.js passes this straight into the JSON response. A partially-filled
  // object would render as a warning with "undefined" in it, which reads as a
  // bug in the checker rather than in the pipeline.
  const r = await pipelineHealth.ratios();
  if (r.worstFile !== null) {
    assert.ok(r.worstFile.fileId, "worstFile.fileId");
    assert.ok(r.worstFile.stage, "worstFile.stage");
    assert.ok(Number.isInteger(r.worstFile.runs) && r.worstFile.runs > 0, "worstFile.runs");
  }
  if (r.worstLocation !== null) {
    assert.ok(r.worstLocation.storageLocationId, "worstLocation.storageLocationId");
    assert.ok(Number.isInteger(r.worstLocation.scans) && r.worstLocation.scans > 0);
  }
});
