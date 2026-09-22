// Faults in the thing that lists a folder (Phase 8 of docs/18-v2-reliability-audit.md).
// A dead share does not answer and does not fail: it simply stops mid-listing, which is
// the one case Phase 4 could not produce on demand. ATLAS_WALKER puts a stand-in lister
// in the real one's place (test/_walker-faults.ts).
//
// The settings are read once, when the modules load, so they are set here BEFORE the
// modules that read them are imported - hence the dynamic imports.
import "./_env.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ATLAS_WALKER = path.join(import.meta.dirname, "_walker-faults.ts");
process.env.ATLAS_SCAN_STALL_S = "2";

const { Db } = await import("../src/db/db.ts");
const { scanRoot } = await import("../src/scan/scanner.ts");
const { S } = await import("../src/pipeline/states.ts");

const cleanup: (() => void)[] = [];
after(() => { for (const f of cleanup.reverse()) try { f(); } catch { /* best effort */ } });

function fixture(name: string, files: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-${name}-`));
  for (const f of files) fs.writeFileSync(path.join(dir, f), `the contents of ${f}`);
  const db = new Db(path.join(process.env.ATLAS_HOME!, `${name}.db`));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }), () => db.close());
  db.run("INSERT INTO roots(path, created) VALUES (?, ?)", dir, Date.now());
  return { dir, db };
}
const rows = (db: InstanceType<typeof Db>) => db.all<{ path: string; state: number; missed: number | null }>(
  "SELECT path, state, missed FROM files ORDER BY path");

test("a share that stops answering mid-listing: the scan gives up and concludes nothing", async () => {
  const { db } = fixture("walk-hang", ["a.txt", "b.txt", "c.txt", "d.txt"]);
  // A faithful listing first, so there is something to wrongly call missing later.
  process.env.ATLAS_WALKER_FAULT = "none";
  const real = await scanRoot(db, 1);
  assert.equal(real.complete, true, "a listing that reaches its end is complete");
  assert.equal(real.files, 4);

  process.env.ATLAS_WALKER_FAULT = "hang";
  const t0 = Date.now();
  const stalled = await scanRoot(db, 1);
  const took = Date.now() - t0;
  assert.equal(stalled.complete, false, "a listing that stopped answering is not a complete listing");
  assert.ok(took < 30_000, `the scan returned instead of waiting for ever (${took} ms)`);
  assert.equal(stalled.missing, 0, "and nothing was concluded from it");
  assert.equal(stalled.suspect, 0);
  for (const r of rows(db)) {
    assert.equal(r.missed, null, `${r.path} was not suspected of being gone`);
    assert.notEqual(r.state, S.MISSING, `${r.path} was not marked missing`);
  }
});

test("a listing that ends early is not mistaken for a folder that lost its files", async () => {
  const { db } = fixture("walk-half", ["a.txt", "b.txt", "c.txt", "d.txt"]);
  process.env.ATLAS_WALKER_FAULT = "none";
  await scanRoot(db, 1);
  process.env.ATLAS_WALKER_FAULT = "halfway"; // lists 2 of 4 files, then exits 0
  const half = await scanRoot(db, 1);
  assert.equal(half.complete, false, "no end-of-listing mark: not complete, whatever the exit code");
  assert.equal(half.suspect + half.missing, 0);
  assert.equal(rows(db).filter((r) => r.missed != null).length, 0, "the two files it never got to are not suspected");
  // And a faithful listing afterwards still sees all four.
  process.env.ATLAS_WALKER_FAULT = "none";
  const again = await scanRoot(db, 1);
  assert.equal(again.files, 4);
  assert.equal(again.missing, 0);
});

test("a share that never answers at all: the scan still returns", async () => {
  const { db } = fixture("walk-silent", ["a.txt", "b.txt"]);
  process.env.ATLAS_WALKER_FAULT = "silent";
  const t0 = Date.now();
  const r = await scanRoot(db, 1);
  assert.ok(Date.now() - t0 < 30_000, "it gave up rather than waiting for ever");
  assert.equal(r.complete, false);
  assert.equal(r.files, 0);
  assert.equal(rows(db).length, 0, "and wrote nothing about a folder it never saw");
});
