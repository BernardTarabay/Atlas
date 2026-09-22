// Apply (Phase 6 of docs/18-v2-reliability-audit.md), on throwaway folders only:
// the real native helper, real files, real locks. Every test states what must be
// true on disk afterwards - including, for every refusal, that nothing moved.
import "./_env.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/db/db.ts";
import { Engine } from "../src/pipeline/engine.ts";
import { scanRoot } from "../src/scan/scanner.ts";
import { planApply, runBatch, planUndo, cancelBatch, ApplyError } from "../src/apply/apply.ts";
import { nativeFsOps, type FsOps } from "../src/apply/fsops.ts";
import { acquireLock } from "../src/lock.ts";
import { S, OP } from "../src/pipeline/states.ts";

const cleanup: (() => void)[] = [];
after(() => { for (const f of cleanup.reverse()) try { f(); } catch { /* best effort */ } });
const fx = nativeFsOps();
cleanup.push(() => fx.close());
const OLD = new Date("2021-03-04T05:06:07Z");
const BORN = Date.UTC(2019, 0, 2, 3, 4, 5);

/** A processed library: a source folder with files, an empty library folder, everything planned. */
async function library(name: string, files: Record<string, string>) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-${name}-`));
  cleanup.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const src = path.join(base, "Inbox");
  const lib = path.join(base, "Library");
  fs.mkdirSync(src);
  fs.mkdirSync(lib);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(src, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    fs.utimesSync(p, OLD, OLD);
  }
  const db = new Db(path.join(process.env.ATLAS_HOME!, `${name}.db`));
  cleanup.push(() => db.close());
  db.run("INSERT INTO roots(path, role, created) VALUES (?, 'source', ?)", src, Date.now());
  db.run("INSERT INTO roots(path, role, created) VALUES (?, 'library', ?)", lib, Date.now());
  const eng = new Engine(db);
  eng.start();
  eng.requestScan();
  for (let i = 0; i < 800; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const pending = db.get<{ n: number }>(`SELECT count(*) AS n FROM files WHERE state < ${S.DONE}`)!.n;
    if (i > 4 && !pending && eng.pool.busy === 0 && eng.scanState.scanning == null && !eng.scanState.queued.length) break;
  }
  await eng.stop();
  return { src, lib, db };
}
const row = (db: Db, p: string) => db.get<{ id: number; root: number; path: string; plan: string; fid: string | null; content: number }>(
  "SELECT id, root, path, plan, fid, content FROM files WHERE path = ? OR plan = ? ORDER BY root LIMIT 1", p, p)!;
const ops = (db: Db, batch: number) => db.all<{ id: number; state: number; err: string | null; step: string | null; src: string; dst: string }>(
  "SELECT id, state, err, step, src, dst FROM ops WHERE batch = ? ORDER BY id", batch);
const read = (p: string) => fs.readFileSync(p, "utf8");

test("planning writes the journal only; preview writes nothing", async () => {
  const { src, db } = await library("plan", { "notes.txt": "some notes", "Report final.pdf": "%PDF-1.4 fake report" });
  const before = fs.readdirSync(src).sort();
  const preview = await planApply(db, 2, { dryRun: true });
  assert.equal(preview.batch, null);
  assert.equal(preview.ops, 2);
  assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM ops")!.n, 0, "a preview writes nothing");
  const p = await planApply(db, 2);
  assert.equal(p.ops, 2);
  assert.equal(p.renames, 2, "one disk: renames");
  const o = db.get<{ state: number; fid: string; sha: Uint8Array; mode: string; size: number }>("SELECT state, fid, sha, mode, size FROM ops LIMIT 1")!;
  assert.equal(o.state, OP.PLANNED);
  assert.ok(o.fid && o.sha.length === 32 && o.mode === "rename", "the journal says what must be true to move it");
  assert.deepEqual(fs.readdirSync(src).sort(), before, "no file has moved");
  await assert.rejects(planApply(db, 2), /not finished/, "one batch at a time");
  await assert.rejects(planApply(db, 1), ApplyError, "only into a library folder");
});

test("same disk: renamed into place, the index follows, a rescan finds nothing to change", async () => {
  const { src, lib, db } = await library("rename", { "notes.txt": "some notes", "sub/Report final.pdf": "%PDF-1.4 fake report" });
  const n = row(db, "notes.txt");
  db.run("UPDATE files SET pin = 'Mine' WHERE id = ?", n.id); // a choice made before Apply stays
  db.run(`UPDATE files SET state = ${S.IDENT} WHERE id = ?`, n.id);
  const eng = new Engine(db); eng.reloadRoots();
  const { planBatch } = await import("../src/plan/planner.ts");
  planBatch(db, 100, new Set());
  const planned = row(db, "notes.txt");
  const p = await planApply(db, 2);
  const r = await runBatch(db, p.batch!, fx);
  assert.deepEqual({ done: r.done, failed: r.failed, review: r.review }, { done: 2, failed: 0, review: 0 });
  const moved = db.get<{ root: number; path: string; fid: string; pin: string }>("SELECT root, path, fid, pin FROM files WHERE id = ?", n.id)!;
  assert.equal(moved.root, 2);
  assert.equal(moved.path, planned.plan);
  assert.equal(moved.fid, n.fid, "same file: a rename");
  assert.equal(moved.pin, "Mine");
  assert.equal(read(path.join(lib, ...planned.plan.split("/"))), "some notes");
  assert.equal(fs.existsSync(path.join(src, "notes.txt")), false);
  assert.ok(ops(db, p.batch!).every((o) => o.state === OP.DONE));
  // The name index follows too: the file is found by its new place.
  const byName = db.all<{ rowid: number }>("SELECT rowid FROM fts_name WHERE fts_name MATCH ?", '"mine"').map((x) => x.rowid);
  assert.ok(byName.includes(n.id), "found under its new path");
  // The next scans of both folders agree with what Apply recorded: nothing new, nothing missing.
  const a = await scanRoot(db, 1);
  const b = await scanRoot(db, 2);
  assert.equal(a.suspect + b.suspect, 0);
  assert.equal(db.get<{ n: number }>(`SELECT count(*) AS n FROM files WHERE state < ${S.DONE}`)!.n, 0, "nothing to read again");
  const again = await planApply(db, 2, { dryRun: true });
  assert.equal(again.ops, 0);
  assert.equal(again.inPlace, 2, "everything is where the plan says");
});

test("across disks (the copy protocol): proven by hash, dates kept, the original removed only after", async () => {
  const { src, lib, db } = await library("copy", { "photo.jpg": "not really a jpeg but bytes all the same", "a.txt": "alpha" });
  for (const f of ["photo.jpg", "a.txt"]) {
    await fx.setCreated(path.join(src, f), BORN);
    fs.utimesSync(path.join(src, f), OLD, OLD);
  }
  await scanRoot(db, 1);
  const plan = row(db, "photo.jpg").plan;
  const p = await planApply(db, 2, { mode: "copy" });
  assert.equal(p.copies, 2);
  const r = await runBatch(db, p.batch!, fx);
  assert.equal(r.done, 2, JSON.stringify(ops(db, p.batch!)));
  const dst = path.join(lib, ...plan.split("/"));
  const st = fs.statSync(dst);
  assert.equal(read(dst), "not really a jpeg but bytes all the same");
  assert.equal(st.mtimeMs, OLD.getTime(), "modified date kept");
  assert.equal(Math.round(st.birthtimeMs), BORN, "creation date kept (so the plan does not change after the move)");
  assert.equal(fs.existsSync(path.join(src, "photo.jpg")), false, "original removed after the copy was proven");
  assert.deepEqual(fs.readdirSync(path.dirname(dst)).filter((x) => x.endsWith(".tmp")), [], "no temporary copy left");
  assert.equal(ops(db, p.batch!)[0].step, "done");
});

test("never overwrites; never moves a file that changed or is in use - and says so, with nothing changed", async () => {
  const { src, lib, db } = await library("refuse", { "taken.txt": "mine", "changed.txt": "v1", "locked.txt": "busy", "fine.txt": "fine" });
  const p = await planApply(db, 2);
  const planOf = (f: string) => path.join(lib, ...row(db, f).plan.split("/"));
  fs.mkdirSync(path.dirname(planOf("taken.txt")), { recursive: true });
  fs.writeFileSync(planOf("taken.txt"), "SOMEONE ELSE'S FILE");
  fs.writeFileSync(path.join(src, "changed.txt"), "version two, edited after planning");
  const fd = fs.openSync(path.join(src, "locked.txt"), fs.constants.O_RDONLY | 0x10000000);
  let r;
  try { r = await runBatch(db, p.batch!, fx); } finally { fs.closeSync(fd); }
  assert.deepEqual({ done: r.done, failed: r.failed, review: r.review }, { done: 1, failed: 3, review: 0 });
  const by = (f: string) => ops(db, p.batch!).find((o) => o.src.endsWith(f))!;
  assert.match(by("taken.txt").err!, /never overwritten/);
  assert.equal(read(planOf("taken.txt")), "SOMEONE ELSE'S FILE", "the file that was there is untouched");
  assert.equal(read(path.join(src, "taken.txt")), "mine");
  assert.match(by("changed.txt").err!, /changed since/);
  assert.equal(read(path.join(src, "changed.txt")), "version two, edited after planning");
  assert.match(by("locked.txt").err!, /open in another program/);
  assert.equal(read(path.join(src, "locked.txt")), "busy");
  assert.equal(by("fine.txt").state, OP.DONE);
});

/** The real operations, with one of them misbehaving. */
function sabotage(overrides: Partial<FsOps>): FsOps { return { ...fx, ...overrides }; }

test("a file saved at the destination after it was checked is still never overwritten", async () => {
  // The check before a move cannot close the gap between checking and moving; only the
  // move itself can. It must refuse to replace, in both protocols.
  for (const mode of ["auto", "copy"] as const) {
    const { src, db } = await library(`appears-${mode}`, { "doc.txt": "mine" });
    const p = await planApply(db, 2, { mode });
    const intruder = "SOMEONE ELSE'S FILE, saved a moment after the check";
    const r = await runBatch(db, p.batch!, sabotage({
      // Called after "is the destination free?" and just before the move: another program saves there.
      async mkdirp(dir) { await fx.mkdirp(dir); for (const o of ops(db, p.batch!)) if (!fs.existsSync(o.dst)) fs.writeFileSync(o.dst, intruder); },
    }));
    assert.deepEqual({ done: r.done, failed: r.failed, review: r.review }, { done: 0, failed: 1, review: 0 }, mode);
    const o = ops(db, p.batch!)[0];
    assert.match(o.err!, /never overwritten/, mode);
    assert.equal(o.state, OP.FAILED, `${mode}: nothing changed, so nothing to review`);
    assert.equal(read(o.dst), intruder, `${mode}: the other file is untouched`);
    assert.equal(read(path.join(src, "doc.txt")), "mine", `${mode}: the original is where it was`);
    assert.deepEqual(fs.readdirSync(path.dirname(o.dst)), [path.basename(o.dst)], `${mode}: no temporary copy left`);
  }
});

test("a copy that is not the recorded content is thrown away; the original is untouched", async () => {
  const { src, db } = await library("badcopy", { "doc.txt": "the real content" });
  const p = await planApply(db, 2, { mode: "copy" });
  const r = await runBatch(db, p.batch!, sabotage({
    async copy(a, b) { await fx.copy(a, b); fs.appendFileSync(b, "!"); }, // a bad disk, a bad cable
  }));
  assert.equal(r.failed, 1);
  const o = ops(db, p.batch!)[0];
  assert.match(o.err!, /not the file's recorded content/);
  assert.equal(o.state, OP.FAILED, "nothing changed on disk, so nothing to review");
  assert.equal(read(path.join(src, "doc.txt")), "the real content");
  assert.ok(!fs.existsSync(o.dst), "nothing placed");
  assert.ok(!fs.existsSync(`${o.dst}.atlas-${p.batch}-${row(db, "doc.txt").id}.tmp`), "the bad copy removed");
});

test("an original that changes during its copy is kept, next to the copy, for a person to decide", async () => {
  const { src, db } = await library("race", { "live.txt": "first version" });
  const p = await planApply(db, 2, { mode: "copy" });
  const r = await runBatch(db, p.batch!, sabotage({
    async setCreated(file, ms) { await fx.setCreated(file, ms); fs.appendFileSync(path.join(src, "live.txt"), " + an edit"); },
  }));
  assert.equal(r.review, 1);
  const o = ops(db, p.batch!)[0];
  assert.equal(o.state, OP.REVIEW);
  assert.match(o.err!, /both are kept/);
  assert.equal(read(path.join(src, "live.txt")), "first version + an edit", "the edited original is kept");
  assert.equal(read(o.dst), "first version", "and the verified copy of what was planned");
  assert.equal(row(db, "live.txt").root, 1, "the index still points at the original");
});

test("a chain is moved in order; a cycle is refused with nothing changed", async () => {
  const { src, db } = await library("order", { "a.txt": "A", "b.txt": "B", "c.txt": "C", "d.txt": "D" });
  const id = (f: string) => row(db, f).id;
  const sha = (t: string) => crypto.createHash("sha256").update(t).digest();
  const facts = async (f: string) => (await fx.stat(path.join(src, f)))!;
  const put = async (batch: number, from: string, to: string, body: string) => {
    const s = await facts(from);
    db.run(`INSERT INTO ops(batch, kind, file, src, dst, fid, size, mtime, sha, mode, sroot, spath, droot, dpath, state)
            VALUES (?, 'move', ?, ?, ?, ?, ?, ?, ?, 'rename', 1, ?, 1, ?, ${OP.PLANNED})`,
      batch, id(from), path.join(src, from), path.join(src, to), s.fid, s.size, s.mtime, sha(body), from, to);
  };
  // a -> b's place, b -> e (free): b must go first.
  await put(1, "a.txt", "b.txt", "A");
  await put(1, "b.txt", "e.txt", "B");
  let r = await runBatch(db, 1, fx);
  assert.equal(r.done, 2);
  assert.equal(read(path.join(src, "b.txt")), "A");
  assert.equal(read(path.join(src, "e.txt")), "B");
  // c <-> d: a cycle.
  await put(2, "c.txt", "d.txt", "C");
  await put(2, "d.txt", "c.txt", "D");
  r = await runBatch(db, 2, fx);
  assert.equal(r.failed, 2);
  assert.match(ops(db, 2)[0].err!, /cycle/);
  assert.equal(read(path.join(src, "c.txt")), "C");
  assert.equal(read(path.join(src, "d.txt")), "D");
});

test("undo puts a batch back, and marks it undone", async () => {
  const { src, lib, db } = await library("undo", { "x.txt": "x", "y.txt": "y" });
  const p = await planApply(db, 2);
  await runBatch(db, p.batch!, fx);
  assert.deepEqual(fs.readdirSync(src), []);
  const u = planUndo(db, p.batch!);
  assert.equal(u.ops, 2);
  const r = await runBatch(db, u.batch, fx);
  assert.equal(r.done, 2);
  assert.deepEqual(fs.readdirSync(src).sort(), ["x.txt", "y.txt"]);
  assert.equal(read(path.join(src, "x.txt")), "x");
  assert.equal(row(db, "x.txt").root, 1);
  assert.ok(ops(db, p.batch!).every((o) => o.state === OP.UNDONE));
  assert.equal(fs.readdirSync(lib, { recursive: true }).filter((f) => String(f).endsWith(".txt")).length, 0);
});

test("an interrupted operation blocks everything else; cancel touches nothing; one writer at a time", async () => {
  const { db } = await library("guard", { "k.txt": "k", "l.txt": "l" });
  const p = await planApply(db, 2);
  db.run(`UPDATE ops SET state = ${OP.STARTED} WHERE id = (SELECT min(id) FROM ops)`); // as a crash leaves it
  await assert.rejects(runBatch(db, p.batch!, fx), /interrupted/);
  db.run(`UPDATE ops SET state = ${OP.PLANNED}`);
  assert.equal(cancelBatch(db, p.batch!), 2);
  assert.ok(ops(db, p.batch!).every((o) => o.state === OP.FAILED && o.err === "cancelled before it ran"));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-lock-"));
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = acquireLock("test", home);
  assert.ok(first);
  assert.equal(acquireLock("second", home), null, "a second writer is refused");
  first!.release();
  const again = acquireLock("third", home);
  assert.ok(again, "released when the holder ends");
  again!.release();
});
