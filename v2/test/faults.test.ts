// Injected faults (Phase 8 of docs/18-v2-reliability-audit.md): every step of a move
// made to fail on purpose, on throwaway folders. What is asserted each time is the same
// three things - the person's file still exists and still holds its content, nothing was
// overwritten, and nothing of Atlas's is left lying around - plus that the operation
// says something true about what happened.
import "./_env.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { library } from "./_library.ts";
import type { Db } from "../src/db/db.ts";
import { planApply, runBatch } from "../src/apply/apply.ts";
import { nativeFsOps, FsError, type FsOps } from "../src/apply/fsops.ts";
import { OP } from "../src/pipeline/states.ts";

const cleanup: (() => void)[] = [];
after(() => { for (const f of cleanup.reverse()) try { f(); } catch { /* best effort */ } });
const fx = nativeFsOps();
cleanup.push(() => fx.close());

const sabotage = (overrides: Partial<FsOps>): FsOps => ({ ...fx, ...overrides });
const opsOf = (db: Db, batch: number) => db.all<{ id: number; state: number; err: string | null; src: string; dst: string; tmp: string | null; step: string | null }>(
  "SELECT id, state, err, src, dst, tmp, step FROM ops WHERE batch = ? ORDER BY id", batch);
/** Everything Atlas might have left behind in the library folder. */
const litter = (lib: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.includes(".atlas-")) out.push(p); } };
  walk(lib);
  return out;
};

test("the disk fills up while copying: nothing is placed, nothing is left behind", async () => {
  const { src, lib, db } = await library("fault-nospc", { "doc.txt": "the real content" }, cleanup);
  const p = await planApply(db, 2, { mode: "copy" });
  const r = await runBatch(db, p.batch!, sabotage({
    async copy(a, b) { await fx.copy(a, b); throw new FsError("NOSPC", "there is not enough space on the disk"); },
  }));
  assert.deepEqual({ done: r.done, failed: r.failed, review: r.review }, { done: 0, failed: 1, review: 0 });
  const o = opsOf(db, p.batch!)[0];
  assert.equal(o.state, OP.FAILED, "nothing had changed where it matters, so it can be planned again");
  assert.equal(fs.readFileSync(path.join(src, "doc.txt"), "utf8"), "the real content");
  assert.ok(!fs.existsSync(o.dst), "nothing placed");
  assert.deepEqual(litter(lib), [], "no half-written copy left");
});

test("the copy cannot be flushed to disk: it is thrown away, the original untouched", async () => {
  const { src, lib, db } = await library("fault-flush", { "doc.txt": "the real content" }, cleanup);
  const p = await planApply(db, 2, { mode: "copy" });
  const r = await runBatch(db, p.batch!, sabotage({
    flush: async () => { throw new FsError("IO", "the disk stopped answering"); },
  }));
  assert.equal(r.failed, 1);
  const o = opsOf(db, p.batch!)[0];
  assert.equal(o.state, OP.FAILED);
  assert.match(o.err!, /flush|disk stopped answering/i);
  assert.equal(fs.readFileSync(path.join(src, "doc.txt"), "utf8"), "the real content");
  assert.ok(!fs.existsSync(o.dst));
  assert.deepEqual(litter(lib), [], "no half-written copy left");
});

test("the copy cannot be read back: it is thrown away, the original untouched", async () => {
  const { src, lib, db } = await library("fault-hash", { "doc.txt": "the real content" }, cleanup);
  const p = await planApply(db, 2, { mode: "copy" });
  const r = await runBatch(db, p.batch!, sabotage({
    hash: async () => { throw new FsError("ACCES", "the file could not be read"); },
  }));
  assert.equal(r.failed, 1);
  const o = opsOf(db, p.batch!)[0];
  assert.equal(o.state, OP.FAILED, "unproven means not placed: nothing to review");
  assert.equal(fs.readFileSync(path.join(src, "doc.txt"), "utf8"), "the real content");
  assert.ok(!fs.existsSync(o.dst));
  assert.deepEqual(litter(lib), [], "no unproven copy left");
});

test("the creation date cannot be restored: the move still happens, and says so", async () => {
  const { src, lib, db } = await library("fault-created", { "doc.txt": "the real content" }, cleanup);
  const p = await planApply(db, 2, { mode: "copy" });
  const r = await runBatch(db, p.batch!, sabotage({
    setCreated: async () => { throw new FsError("ACCES", "the creation time could not be set"); },
  }));
  assert.deepEqual({ done: r.done, failed: r.failed, review: r.review }, { done: 1, failed: 0, review: 0 },
    "a date is not worth refusing a proven copy over");
  const o = opsOf(db, p.batch!)[0];
  assert.equal(o.state, OP.DONE);
  assert.match(o.err!, /creation/i, "but it is recorded");
  assert.equal(fs.readFileSync(o.dst, "utf8"), "the real content");
  assert.ok(!fs.existsSync(path.join(src, "doc.txt")));
  assert.deepEqual(litter(lib), []);
});

test("the original cannot be deleted after it was copied: both are kept, and it is said plainly", async () => {
  const { src, lib, db } = await library("fault-remove", { "doc.txt": "the real content" }, cleanup);
  const p = await planApply(db, 2, { mode: "copy" });
  const r = await runBatch(db, p.batch!, sabotage({
    remove: async (f) => { if (f.includes(".atlas-")) return fx.remove(f); throw new FsError("ACCES", "the file is in use"); },
  }));
  assert.equal(r.done, 1, "the copy is in the library and proven: that part did happen");
  const o = opsOf(db, p.batch!)[0];
  assert.match(o.err!, /could not be deleted/);
  assert.equal(fs.readFileSync(o.dst, "utf8"), "the real content");
  assert.equal(fs.readFileSync(path.join(src, "doc.txt"), "utf8"), "the real content", "the original is still there");
  assert.ok(r.notes.some((n) => n.includes("still at")), "and the run says where");
  assert.deepEqual(litter(lib), []);
});

test("the file is locked by another program: refused, and nothing is touched", async () => {
  const { src, lib, db } = await library("fault-busy", { "doc.txt": "the real content" }, cleanup);
  const p = await planApply(db, 2);
  const r = await runBatch(db, p.batch!, sabotage({
    move: async () => { throw new FsError("BUSY", "the file is open in another program"); },
  }));
  assert.equal(r.failed, 1);
  const o = opsOf(db, p.batch!)[0];
  assert.equal(o.state, OP.FAILED, "retryable: try again later");
  assert.match(o.err!, /open in another program/);
  assert.equal(fs.readFileSync(path.join(src, "doc.txt"), "utf8"), "the real content");
  assert.deepEqual(litter(lib), []);
});

test("the disk disappears mid-batch: what is left is refused, not guessed", async () => {
  const { src, lib, db } = await library("fault-offline", { "a.txt": "first", "b.txt": "second" }, cleanup);
  const p = await planApply(db, 2);
  let moves = 0;
  const r = await runBatch(db, p.batch!, sabotage({
    async move(a, b) { if (++moves > 1) throw new FsError("NOENT", "the destination is not reachable"); return fx.move(a, b); },
    async stat(f) { if (moves > 1 && f.includes("Library")) throw new FsError("NOENT", "the destination is not reachable"); return fx.stat(f); },
  }));
  assert.equal(r.done + r.failed + r.review, 2);
  assert.equal(r.done, 1, "the one that went through is done");
  assert.equal(r.review, 0, "and the other changed nothing, so nobody has to look");
  const left = fs.readdirSync(src);
  assert.equal(left.length, 1, "the file that did not move is still where it was");
  assert.equal(fs.readFileSync(path.join(src, left[0]), "utf8").length > 0, true);
  assert.deepEqual(litter(lib), []);
});
