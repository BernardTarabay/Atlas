// Recovery of interrupted file operations (Phase 7 of docs/18-v2-reliability-audit.md),
// on throwaway folders only. The matrix of §8b is tested twice: once as a decision on
// facts alone (classify, no disk), and once for real - including a process killed
// outright mid-move, whose batch is then settled by `recover`.
import "./_env.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Db } from "../src/db/db.ts";
import { library } from "./_library.ts";
import { planApply, runBatch, type Op } from "../src/apply/apply.ts";
import { nativeFsOps } from "../src/apply/fsops.ts";
import { classify, inspect, recover, settle, type OpFacts } from "../src/apply/recover.ts";
import { OP } from "../src/pipeline/states.ts";

const cleanup: (() => void)[] = [];
after(() => { for (const f of cleanup.reverse()) try { f(); } catch { /* best effort */ } });
const fx = nativeFsOps();
cleanup.push(() => fx.close());
const run = promisify(execFile);

const SHA = crypto.createHash("sha256").update("the content").digest();
const op = (over: Partial<Op> = {}): Op => ({
  id: 1, batch: 1, file: 7, src: "C:\\Inbox\\a.txt", dst: "C:\\Library\\Documents\\a.txt", fid: "1:2", size: 11, mtime: 1000,
  sha: SHA, birth: null, mode: "rename", tmp: null, sroot: 1, spath: "a.txt", droot: 2, dpath: "Documents/a.txt", undoes: null, ...over,
});
const at = (over: Partial<{ fid: string; size: number; mtime: number; birth: number }> = {}) => ({ fid: "1:2", size: 11, mtime: 1000, birth: 0, ...over });
const facts = (f: Partial<OpFacts>): OpFacts => ({ src: null, dst: null, tmp: null, ...f });
const hex = Buffer.from(SHA).toString("hex");

test("what the disk says decides: every interrupted operation, from facts alone", () => {
  const v = (o: Op, f: OpFacts) => classify(o, f).verdict;

  // Same disk. The rename is atomic, so the file is at one end or the other.
  assert.equal(v(op(), facts({ src: at() })), "planned", "not moved yet: run it again");
  assert.equal(v(op(), facts({ dst: at() })), "finish", "at its destination with the same file ID: complete it");
  assert.equal(v(op(), facts({ src: at({ mtime: 2000 }) })), "failed", "changed before it moved: plan again");
  assert.equal(v(op(), facts({ src: at(), dst: at({ fid: "9:9" }) })), "review", "someone else's file is at the destination");
  assert.equal(v(op(), facts({})), "review", "at neither end");
  // A disk without file IDs (FAT): size and date, and only when the source is gone.
  assert.equal(v(op({ fid: null }), facts({ dst: at({ fid: "9:9" }) })), "finish");
  assert.equal(v(op({ fid: null }), facts({ src: at(), dst: at({ fid: "9:9" }) })), "review", "at both ends: a person looks");

  // Another disk: copy, prove, place, then delete the original.
  const copy = op({ mode: "copy", tmp: "C:\\Library\\Documents\\a.txt.atlas-1-7.tmp" });
  assert.equal(v(copy, facts({ src: at() })), "planned", "nothing placed: copy it again");
  assert.equal(v(copy, facts({ src: at(), tmp: at({ size: 3 }) })), "planned", "a half-written copy is not in the way");
  assert.ok(classify(copy, facts({ src: at(), tmp: at({ size: 3 }) })).removeTmp, "and it is removed");
  assert.equal(v(copy, facts({ dst: at(), dstSha: hex })), "finish", "the copy is proven and the original already gone");
  const both = classify(copy, facts({ src: at(), dst: at(), dstSha: hex }));
  assert.equal(both.verdict, "finish");
  assert.ok(both.removeSource, "the original is deleted last, as the move would have");
  assert.equal(v(copy, facts({ src: at({ mtime: 2000 }), dst: at(), dstSha: hex })), "review", "the original changed after it was copied: keep both");
  assert.equal(v(copy, facts({ src: at(), dst: at(), dstSha: "0".repeat(64) })), "review", "that is not this file's content");
  assert.equal(v(copy, facts({ src: at(), dst: at(), dstSha: null })), "review", "unreadable is not the same as different");
  assert.match(classify(copy, facts({ src: at(), dst: at(), dstSha: null })).why, /could not be read/);
  assert.equal(v(copy, facts({ src: at(), dst: at() })), "check", "unread destinations are not decided");
  assert.equal(v(copy, facts({})), "review", "the original is gone and nothing was placed");
});

/** Put a batch back into the state a crash leaves: the op STARTED, nothing else changed. */
function interrupt(db: Db, batch: number, step: string | null = null) {
  db.run(`UPDATE ops SET state = ${OP.STARTED}, t0 = ?, step = ? WHERE batch = ?`, Date.now(), step, batch);
}
const opsOf = (db: Db, batch: number) => db.all<{ id: number; state: number; err: string | null; src: string; dst: string; tmp: string | null }>(
  "SELECT id, state, err, src, dst, tmp FROM ops WHERE batch = ? ORDER BY id", batch);
const fileRow = (db: Db, id: number) => db.get<{ root: number; path: string }>("SELECT root, path FROM files WHERE id = ?", id)!;

test("interrupted before the move: nothing happened, so it simply runs again", async () => {
  const { src, db } = await library("rec-before", { "notes.txt": "some notes" }, cleanup);
  const p = await planApply(db, 2);
  interrupt(db, p.batch!);
  const r = await recover(db, fx);
  assert.deepEqual({ planned: r.planned, finished: r.finished, failed: r.failed, review: r.review }, { planned: 1, finished: 0, failed: 0, review: 0 });
  assert.equal(opsOf(db, p.batch!)[0].state, OP.PLANNED);
  assert.equal(fs.readFileSync(path.join(src, "notes.txt"), "utf8"), "some notes", "untouched");
  // And it runs to the end afterwards.
  const done = await runBatch(db, p.batch!, fx);
  assert.equal(done.done, 1);
});

test("interrupted after a same-disk move: the file is at its destination, so the index follows", async () => {
  const { src, lib, db } = await library("rec-moved", { "notes.txt": "some notes" }, cleanup);
  const p = await planApply(db, 2);
  const o = opsOf(db, p.batch!)[0];
  const id = db.get<{ file: number }>("SELECT file FROM ops WHERE id = ?", o.id)!.file;
  // The move happened; the crash came before the database was told.
  fs.mkdirSync(path.dirname(o.dst), { recursive: true });
  await fx.move(o.src, o.dst);
  interrupt(db, p.batch!, "moved");
  const r = await recover(db, fx);
  assert.deepEqual({ planned: r.planned, finished: r.finished, review: r.review }, { planned: 0, finished: 1, review: 0 });
  const row = fileRow(db, id);
  assert.equal(row.root, 2, "the index says the library now");
  assert.equal(path.join(lib, ...row.path.split("/")), o.dst);
  assert.equal(opsOf(db, p.batch!)[0].state, OP.DONE);
  assert.match(opsOf(db, p.batch!)[0].err!, /Completed after an interruption/);
  assert.ok(!fs.existsSync(path.join(src, "notes.txt")));
  const byName = db.all<{ rowid: number }>("SELECT rowid FROM fts_name WHERE fts_name MATCH ?", '"notes"').map((x) => x.rowid);
  assert.ok(byName.includes(id), "and the name index with it");
});

test("interrupted after a copy was placed: the original is deleted last, exactly as the move would have", async () => {
  const { src, db } = await library("rec-copied", { "doc.txt": "the real content" }, cleanup);
  const p = await planApply(db, 2, { mode: "copy" });
  const o = opsOf(db, p.batch!)[0];
  fs.mkdirSync(path.dirname(o.dst), { recursive: true });
  fs.copyFileSync(o.src, o.dst);
  interrupt(db, p.batch!, "placed");
  const r = await recover(db, fx);
  assert.equal(r.finished, 1);
  assert.equal(fs.readFileSync(o.dst, "utf8"), "the real content");
  assert.ok(!fs.existsSync(path.join(src, "doc.txt")), "the original is gone, but only after the copy was proven");
  assert.equal(opsOf(db, p.batch!)[0].state, OP.DONE);
});

test("interrupted mid-copy: the half-written copy is removed and the file is copied again", async () => {
  const { src, db } = await library("rec-midcopy", { "doc.txt": "the real content" }, cleanup);
  const p = await planApply(db, 2, { mode: "copy" });
  const o = opsOf(db, p.batch!)[0];
  fs.mkdirSync(path.dirname(o.tmp!), { recursive: true });
  fs.writeFileSync(o.tmp!, "the real co"); // stopped half way
  interrupt(db, p.batch!, "copied");
  const r = await recover(db, fx);
  assert.equal(r.planned, 1);
  assert.ok(!fs.existsSync(o.tmp!), "the half-written copy is gone");
  assert.equal(fs.readFileSync(path.join(src, "doc.txt"), "utf8"), "the real content", "the original untouched");
  const done = await runBatch(db, p.batch!, fx);
  assert.equal(done.done, 1, "and the copy is made properly");
  assert.equal(fs.readFileSync(o.dst, "utf8"), "the real content");
});

test("a destination holding something else is never touched: a person is asked, and can settle it", async () => {
  const { src, db } = await library("rec-review", { "doc.txt": "the real content" }, cleanup);
  const p = await planApply(db, 2, { mode: "copy" });
  const o = opsOf(db, p.batch!)[0];
  fs.mkdirSync(path.dirname(o.dst), { recursive: true });
  fs.writeFileSync(o.dst, "SOMEONE ELSE'S FILE");
  interrupt(db, p.batch!, "placed");
  const r = await recover(db, fx);
  assert.equal(r.review, 1);
  assert.equal(fs.readFileSync(o.dst, "utf8"), "SOMEONE ELSE'S FILE", "not touched");
  assert.equal(fs.readFileSync(path.join(src, "doc.txt"), "utf8"), "the real content", "and neither is the original");
  assert.equal(opsOf(db, p.batch!)[0].state, OP.REVIEW);
  // Planning is held up until a person says they have looked.
  await assert.rejects(planApply(db, 2), /for review/);
  assert.equal(settle(db, o.id, "kept both"), 1);
  assert.equal(opsOf(db, p.batch!)[0].state, OP.FAILED);
  assert.match(opsOf(db, p.batch!)[0].err!, /Settled by hand/);
  assert.equal(settle(db, o.id, "again"), 0, "only an operation waiting for a person can be settled");
  await planApply(db, 2, { dryRun: true }); // no longer refused
});

test("an original that changes between the decision and the deletion is kept", async () => {
  const { src, db } = await library("rec-late", { "doc.txt": "the real content" }, cleanup);
  const p = await planApply(db, 2, { mode: "copy" });
  const o = opsOf(db, p.batch!)[0];
  fs.mkdirSync(path.dirname(o.dst), { recursive: true });
  fs.copyFileSync(o.src, o.dst);
  interrupt(db, p.batch!, "placed");
  // Deciding and acting cannot be one instant. Between them, someone saves over the
  // original: the last word before a delete is the check just before it.
  let looks = 0;
  const late = { ...fx, async stat(file: string) {
    const s = await fx.stat(file);
    if (file === o.src && ++looks > 1 && s) return { ...s, mtime: s.mtime + 5000 };
    return s;
  } };
  const r = await recover(db, late);
  assert.equal(r.review, 1, "a person decides");
  assert.equal(r.finished, 0);
  assert.equal(fs.readFileSync(path.join(src, "doc.txt"), "utf8"), "the real content", "the original is still there");
  assert.equal(fs.readFileSync(o.dst, "utf8"), "the real content", "and so is the copy");
  assert.match(opsOf(db, p.batch!)[0].err!, /changed while this was being settled/);
});

test("looking changes nothing: inspect only reads", async () => {
  const { src, db } = await library("rec-look", { "doc.txt": "the real content" }, cleanup);
  const p = await planApply(db, 2);
  interrupt(db, p.batch!);
  const before = db.get<{ v: number }>("PRAGMA data_version")!.v;
  const findings = await inspect(db, fx, { hash: true });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].verdict, "planned");
  assert.equal(opsOf(db, p.batch!)[0].state, OP.STARTED, "still interrupted: looking settles nothing");
  assert.equal(db.get<{ v: number }>("PRAGMA data_version")!.v, before, "and wrote nothing");
  assert.equal(fs.readFileSync(path.join(src, "doc.txt"), "utf8"), "the real content");
});

test("a process killed outright mid-batch: recovery settles it, and the batch finishes", async () => {
  const { src, lib, db } = await library("rec-kill", { "a.txt": "first file", "b.txt": "second file", "c.txt": "third file" }, cleanup);
  const p = await planApply(db, 2);
  assert.equal(p.ops, 3);
  const dbFile = db.get<{ file: string }>("PRAGMA database_list")!.file;
  db.close();
  // A real child process, killed the moment the first file has moved on disk.
  const child = run(process.execPath, ["--disable-warning=ExperimentalWarning",
    path.join(import.meta.dirname, "_apply-kill.ts"), dbFile, String(p.batch), "1"]);
  const killed = await child.catch((e: { code?: number; signal?: string; stdout?: string }) => e);
  assert.ok(!("stdout" in killed && killed.stdout?.includes("finished without being killed")), "the child was killed mid-batch");

  const db2 = new Db(dbFile);
  cleanup.push(() => db2.close());
  const stuck = db2.all<{ id: number; state: number }>(`SELECT id, state FROM ops WHERE batch = ? AND state = ${OP.STARTED}`, p.batch!);
  assert.equal(stuck.length, 1, "exactly the file that was in flight is left interrupted");
  await assert.rejects(runBatch(db2, p.batch!, fx), /recover/, "and nothing else moves until it is settled");

  const r = await recover(db2, fx);
  assert.equal(r.finished + r.planned, 1);
  assert.equal(r.review, 0, "nothing ambiguous: the disk answered");
  const rest = await runBatch(db2, p.batch!, fx);
  assert.equal(rest.failed + rest.review, 0);
  // The end state is what a batch that was never interrupted would have produced.
  const placed = db2.all<{ id: number; root: number; path: string }>("SELECT id, root, path FROM files ORDER BY id");
  assert.ok(placed.every((f) => f.root === 2), "every file is in the library");
  for (const f of placed) assert.ok(fs.existsSync(path.join(lib, ...f.path.split("/"))), `${f.path} is where the index says`);
  assert.deepEqual(fs.readdirSync(src), [], "and nothing is left behind");
  assert.ok(db2.all<{ id: number }>(`SELECT id FROM ops WHERE batch = ? AND state <> ${OP.DONE}`, p.batch!).length === 0, "every operation is done");
});
