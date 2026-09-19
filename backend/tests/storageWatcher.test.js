const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

// env is read at module load for MIRROR_ROOT, so it is set before the require.
// The watcher itself is not started by any test here -- splitWatchable is a
// pure function over rows, which is the whole reason it was extracted.
const MIRROR = path.resolve(path.sep, "atlas", "Organized");
process.env.MIRROR_ROOT = MIRROR;

const { splitWatchable } = require("../src/jobs/storageWatcher");

const loc = (name, rootPath) => ({ id: name, name, root_path: rootPath });
const names = (list) => list.map((l) => l.name).sort();
const sweptNames = (list) => list.map((e) => e.location.name).sort();

test("an ordinary location is watched", () => {
  const docs = loc("Docs", path.resolve(path.sep, "atlas", "Docs"));
  const { watch, sweepOnly } = splitWatchable([docs]);
  assert.deepStrictEqual(names(watch), ["Docs"]);
  assert.deepStrictEqual(sweepOnly, []);
});

test("the mirror root is never watched", () => {
  // THE ACTUAL INCIDENT: the folder the application writes into was registered
  // with watch_enabled, so every write queued a scan and every scan caused the
  // next write -- 1,549 scans in one day against a 60-minute interval.
  const organized = loc("Organized", MIRROR);
  const { watch, sweepOnly } = splitWatchable([organized]);
  assert.deepStrictEqual(watch, []);
  assert.deepStrictEqual(sweptNames(sweepOnly), ["Organized"]);
  assert.match(sweepOnly[0].why, /MIRROR_ROOT/);
});

test("a folder INSIDE the mirror root is never watched either", () => {
  const nested = loc("Finance", path.join(MIRROR, "Finance"));
  const { watch, sweepOnly } = splitWatchable([nested]);
  assert.deepStrictEqual(watch, []);
  assert.deepStrictEqual(sweptNames(sweepOnly), ["Finance"]);
});

test("a folder CONTAINING the mirror root is never watched either", () => {
  // Registering the desktop while the mirror lives on it is the easiest way to
  // recreate the loop by accident, and it is the direction a one-sided
  // containment check would miss.
  const desktop = loc("Desktop", path.resolve(path.sep, "atlas"));
  const { watch, sweepOnly } = splitWatchable([desktop]);
  assert.deepStrictEqual(watch, []);
  assert.deepStrictEqual(sweptNames(sweepOnly), ["Desktop"]);
});

test("when two locations overlap, the OUTER one keeps the watch", () => {
  const outer = loc("Archive", path.resolve(path.sep, "data", "Archive"));
  const inner = loc("Invoices", path.resolve(path.sep, "data", "Archive", "2019", "Invoices"));

  // Supplied inner-first to prove the result comes from the depth sort rather
  // than from input order.
  const { watch, sweepOnly } = splitWatchable([inner, outer]);
  assert.deepStrictEqual(names(watch), ["Archive"]);
  assert.deepStrictEqual(sweptNames(sweepOnly), ["Invoices"]);
  assert.match(sweepOnly[0].why, /Archive/);
});

test("locations with a shared name prefix are both watched", () => {
  const a = loc("Data", path.resolve(path.sep, "data", "Docs"));
  const b = loc("DataArchive", path.resolve(path.sep, "data", "Docs-Archive"));
  const { watch, sweepOnly } = splitWatchable([a, b]);
  assert.deepStrictEqual(names(watch), ["Data", "DataArchive"]);
  assert.deepStrictEqual(sweepOnly, []);
});

test("every excluded location still reaches the sweep", () => {
  // The loop fix must not become a coverage hole: a folder that is not watched
  // is still indexed, just on the timer instead of on events.
  const organized = loc("Organized", MIRROR);
  const docs = loc("Docs", path.resolve(path.sep, "atlas", "Docs"));
  const { watch, sweepOnly } = splitWatchable([organized, docs]);
  const covered = [...watch.map((l) => l.name), ...sweepOnly.map((e) => e.location.name)];
  assert.deepStrictEqual(covered.sort(), ["Docs", "Organized"]);
});
