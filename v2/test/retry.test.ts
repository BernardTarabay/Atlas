// Failures are kept, not retried on every scan (Phase 1 of docs/18-v2-reliability-audit.md).
//
//   content  hung parser, crashed worker: terminal until the file, FAILURE_SIG or a person says otherwise
//   access   locked, denied, still being written, stalled: tried again at `fnext` (1 h, 6 h, daily)
//
// Plus the two clocks of the worker pool (a slow read is not a stuck read), OCR failures
// with the same split, and a database write that fails without stranding the batch.
import "./_env.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/db/db.ts";
import { Engine, FAILURE_SIG, OCR_SIG } from "../src/pipeline/engine.ts";
import { AnalyzePool } from "../src/pipeline/pool.ts";
import { scanRoot } from "../src/scan/scanner.ts";
import { S, OCR, failureClass, backoffMs } from "../src/pipeline/states.ts";

const HOUR = 3_600_000;
const home = process.env.ATLAS_HOME!;
const cleanup: (() => void)[] = [];
after(() => { for (const f of cleanup.reverse()) try { f(); } catch { /* best effort */ } });

/** What the tests reach into: the engine's in-memory bookkeeping. */
interface Inner {
  failed: { job: { id: number; abs: string; size: number; ext: string }; code: string; message: string }[];
  done: unknown[];
  inflight: Set<number>;
  retryAt: Map<number, number>;
  holdUntil: number;
  ocrOut: unknown[];
  reviveFailures(startup: boolean): void;
  dispatchOcr(): boolean;
  flushOcr(): void;
}
const inner = (e: Engine) => e as unknown as Inner;

function fixture(name: string, files: Record<string, string>) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-${name}-`));
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(tree, rel), body);
  const db = new Db(path.join(home, `${name}.db`));
  db.run("INSERT INTO roots(path, created) VALUES (?, ?)", tree, Date.now());
  cleanup.push(() => fs.rmSync(tree, { recursive: true, force: true }), () => db.close());
  return { tree, db };
}

interface Row { id: number; state: number; tries: number; err: string | null; fclass: string | null; fsig: string | null; fnext: number | null; frounds: number; content: number | null }
const rowOf = (db: Db, p: string) => db.get<Row>("SELECT id, state, tries, err, fclass, fsig, fnext, frounds, content FROM files WHERE path = ?", p)!;

async function until(what: string, ok: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("failure kinds and backoff", () => {
  for (const c of ["TIMEOUT", "CRASH", "ERR", "ERR_STRING_TOO_LONG"]) assert.equal(failureClass(c), "content", c);
  for (const c of ["EBUSY", "EACCES", "EPERM", "EIO", "UNSTABLE", "STALL", "UNKNOWN", "ETIMEDOUT"]) assert.equal(failureClass(c), "access", c);
  assert.deepEqual([0, 1, 2, 9].map(backoffMs), [HOUR, 6 * HOUR, 24 * HOUR, 24 * HOUR]);
});

test("a content failure is kept across scans, and comes back only for a reason", async () => {
  const { tree, db } = fixture("content", { "bad.pdf": "%PDF-1.4 pretend this hangs the parser", "good.txt": "fine" });
  await scanRoot(db, 1);
  const eng = new Engine(db);
  const bad = rowOf(db, "bad.pdf").id;
  const fail = (code: string, n = 3) => {
    for (let i = 0; i < n; i++) {
      inner(eng).failed.push({ job: { id: bad, abs: path.join(tree, "bad.pdf"), size: 1, ext: "pdf" }, code, message: "test" });
      eng.flush();
    }
  };

  fail("TIMEOUT", 2);
  assert.equal(rowOf(db, "bad.pdf").state, S.NEW, "not failed yet: tries close together first");
  assert.ok(inner(eng).retryAt.get(bad)! > Date.now(), "the next try waits a little");
  fail("TIMEOUT", 1);
  let r = rowOf(db, "bad.pdf");
  assert.equal(r.state, S.FAILED);
  assert.equal(r.tries, 3);
  assert.equal(r.fclass, "content");
  assert.equal(r.fsig, FAILURE_SIG);
  assert.equal(r.fnext, null, "a content failure has no retry time");
  assert.match(r.err!, /^TIMEOUT/);

  // The whole point: scans come and go, the failure stays.
  await scanRoot(db, 1);
  await scanRoot(db, 1);
  r = rowOf(db, "bad.pdf");
  assert.equal(r.state, S.FAILED, "an unchanged failed file is not retried by a scan");
  assert.equal(r.tries, 3);

  // A failure reported for a row that has moved on is ignored.
  inner(eng).failed.push({ job: { id: rowOf(db, "good.txt").id, abs: "x", size: 1, ext: "txt" }, code: "TIMEOUT", message: "stale" });
  db.run(`UPDATE files SET state = ${S.DONE} WHERE path = 'good.txt'`);
  eng.flush();
  assert.equal(rowOf(db, "good.txt").state, S.DONE);
  assert.equal(rowOf(db, "good.txt").fclass, null);

  // 1. The file changed.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(tree, "bad.pdf"), later, later);
  await scanRoot(db, 1);
  r = rowOf(db, "bad.pdf");
  assert.equal(r.state, S.NEW, "a changed file is a new chance");
  assert.equal(r.tries, 0);

  // 2. Another physical file now has the name (same size and time, different file ID).
  fail("CRASH");
  db.run("UPDATE files SET fid = 'ffffffff:1' WHERE id = ?", bad);
  await scanRoot(db, 1);
  assert.equal(rowOf(db, "bad.pdf").state, S.NEW, "a different file under the same name is retried");

  // 3. The analyzer or its limits changed since the failure (checked at startup).
  fail("TIMEOUT");
  inner(eng).reviveFailures(true);
  assert.equal(rowOf(db, "bad.pdf").state, S.FAILED, "same signature: still failed");
  db.run("UPDATE files SET fsig = 'a0.t1.p1.w1' WHERE id = ?", bad);
  inner(eng).reviveFailures(true);
  assert.equal(rowOf(db, "bad.pdf").state, S.NEW, "a different analyzer gets another go");

  // 4. Someone asked.
  fail("TIMEOUT");
  assert.deepEqual(eng.retry([bad]), { files: 1, ocr: 0 });
  r = rowOf(db, "bad.pdf");
  assert.equal(r.state, S.NEW);
  assert.equal(r.tries, 0);
});

test("an access failure waits 1 h, then 6 h, then a day", async () => {
  const { db } = fixture("access", { "locked.xlsx": "someone has this open" });
  await scanRoot(db, 1);
  const eng = new Engine(db);
  const id = rowOf(db, "locked.xlsx").id;
  const fail = (code: string) => {
    for (let i = 0; i < 3; i++) {
      inner(eng).failed.push({ job: { id, abs: "x", size: 1, ext: "xlsx" }, code, message: "test" });
      eng.flush();
    }
  };
  const t0 = Date.now();
  fail("EBUSY");
  let r = rowOf(db, "locked.xlsx");
  assert.equal(r.state, S.FAILED);
  assert.equal(r.fclass, "access");
  assert.equal(r.fsig, null);
  assert.equal(r.frounds, 1);
  assert.ok(r.fnext! >= t0 + HOUR && r.fnext! <= Date.now() + HOUR, "first round: an hour");

  inner(eng).reviveFailures(false);
  assert.equal(rowOf(db, "locked.xlsx").state, S.FAILED, "not due yet");
  db.run("UPDATE files SET fnext = ? WHERE id = ?", Date.now() - 1, id);
  inner(eng).reviveFailures(false);
  assert.equal(rowOf(db, "locked.xlsx").state, S.NEW, "due: tried again");

  fail("EACCES");
  r = rowOf(db, "locked.xlsx");
  assert.equal(r.frounds, 2);
  assert.ok(r.fnext! >= t0 + 6 * HOUR, "second round: six hours");
  db.run("UPDATE files SET fnext = 0 WHERE id = ?", id);
  inner(eng).reviveFailures(false);
  fail("UNSTABLE");
  assert.ok(rowOf(db, "locked.xlsx").fnext! >= t0 + 24 * HOUR, "then daily");

  // A file still being written is given minutes between tries, not seconds.
  db.run(`UPDATE files SET state = ${S.NEW}, tries = 0 WHERE id = ?`, id);
  inner(eng).failed.push({ job: { id, abs: "x", size: 1, ext: "xlsx" }, code: "UNSTABLE", message: "test" });
  eng.flush();
  assert.ok(inner(eng).retryAt.get(id)! >= Date.now() + 55_000);
});

test("end to end: a locked file fails as access, survives a rescan, and is read once due and free", async () => {
  const { tree, db } = fixture("locked", { "ok.txt": "a perfectly readable file", "locked.txt": "held open exclusively by another program" });
  // UV_FS_O_EXLOCK: open with no sharing, as Outlook does with its data files.
  const fd = fs.openSync(path.join(tree, "locked.txt"), fs.constants.O_RDONLY | 0x10000000);
  let open = true;
  const release = () => { if (open) { fs.closeSync(fd); open = false; } };
  cleanup.push(release);
  const eng = new Engine(db);
  cleanup.push(() => void eng.stop());
  eng.start();
  eng.requestScan(1);
  const locked = () => rowOf(db, "locked.txt");
  await until("first failure", () => rowOf(db, "ok.txt")?.state === S.DONE && locked()?.tries >= 1);
  assert.match(locked().err!, /^EBUSY/);
  // Skip the short waits between tries: "try again now".
  eng.retry([locked().id]);
  await until("second failure", () => locked().tries >= 2);
  eng.retry([locked().id]);
  await until("recorded as failed", () => locked().state === S.FAILED);
  let r = locked();
  assert.equal(r.fclass, "access");
  assert.ok(Math.abs(r.fnext! - (Date.now() + HOUR)) < 60_000, "tried again in an hour");

  const gen = db.get<{ gen: number }>("SELECT gen FROM roots WHERE id = 1")!.gen;
  eng.requestScan(1);
  await until("rescan", () => db.get<{ gen: number }>("SELECT gen FROM roots WHERE id = 1")!.gen > gen && eng.scanState.scanning == null);
  r = locked();
  assert.equal(r.state, S.FAILED, "the rescan leaves it alone");
  assert.equal(r.tries, 3);

  release();
  db.run("UPDATE files SET fnext = 0 WHERE id = ?", r.id);
  inner(eng).reviveFailures(false);
  await until("read once due", () => locked().state === S.DONE);
  r = locked();
  assert.equal(r.fclass, null);
  assert.equal(r.frounds, 0);
  assert.equal(r.err, null);
  await eng.stop();
});

test("the pool: a slow read is not a stuck one, and analysis has a deadline", async () => {
  let settle: (v: string) => void = () => {};
  const pool = new AnalyzePool(1, 400, 250, () => true, () => settle("done"), (_j, code) => settle(code),
    new URL("./_stall-worker.ts", import.meta.url));
  let id = 0;
  const run = (abs: string) => new Promise<string>((resolve) => {
    settle = resolve;
    pool.submit({ id: ++id, abs, size: 0, ext: "", wholeFileBytes: 0, maxParseBytes: 0, maxTextChars: 0 });
  });
  try {
    assert.equal(await run("moving"), "done", "700 ms of steady reading outlives a 250 ms stall clock");
    assert.equal(await run("stall"), "STALL", "a read that stops is stuck");
    assert.equal(await run("hang"), "TIMEOUT", "analysis past its deadline is a hung parser");
    assert.equal(await run("moving"), "done", "replaced workers work");
  } finally {
    await pool.stop();
  }
});

test("OCR: the file's fault waits and comes back; the content's fault is kept", async () => {
  const { tree, db } = fixture("ocr", { "scan.png": "pretend these are pixels" });
  await scanRoot(db, 1);
  const cid = Number(db.run("INSERT INTO contents(sha, size, kind, ocr) VALUES (?, 24, 'image', 1)", crypto.randomBytes(32)).lastInsertRowid);
  db.run(`UPDATE files SET content = ?, state = ${S.DONE} WHERE path = 'scan.png'`, cid);
  const eng = new Engine(db);
  eng.reloadRoots();
  let calls = 0;
  (eng as unknown as { ocr: unknown }).ocr = {
    idle: 1, busy: 0, close() {},
    recognize: async () => { calls++; throw new Error("OCR helper exited"); },
  };
  const c = () => db.get<{ ocr: number; osig: string | null; onext: number | null; orounds: number }>("SELECT ocr, osig, onext, orounds FROM contents WHERE id = ?", cid)!;
  const attempt = async () => {
    const sent = inner(eng).dispatchOcr();
    if (sent) await until("OCR outcome", () => inner(eng).ocrOut.length > 0);
    inner(eng).flushOcr();
    return sent;
  };

  // The file is there and unchanged: the content defeated OCR. Kept.
  assert.equal(await attempt(), true);
  assert.equal(c().ocr, OCR.FAILED);
  assert.equal(c().osig, OCR_SIG);
  inner(eng).reviveFailures(true);
  assert.equal(c().ocr, OCR.FAILED, "same OCR: still failed");
  db.run("UPDATE contents SET osig = 'o0' WHERE id = ?", cid);
  inner(eng).reviveFailures(true);
  assert.equal(c().ocr, OCR.PENDING, "a different OCR reads it again");

  // The file changed under it: that says nothing about the content. Deferred, not failed.
  fs.appendFileSync(path.join(tree, "scan.png"), " and then someone saved over it");
  assert.equal(await attempt(), true);
  assert.equal(c().ocr, OCR.PENDING);
  assert.equal(c().orounds, 1);
  assert.ok(c().onext! > Date.now() + HOUR - 60_000);
  const before = calls;
  assert.equal(await attempt(), false, "not attempted before its time");
  assert.equal(calls, before);

  // A root that is offline is not read at all.
  db.run("UPDATE contents SET onext = NULL WHERE id = ?", cid);
  db.run("UPDATE roots SET online = 0");
  assert.equal(await attempt(), false, "nothing is read from an offline root");
  db.run("UPDATE roots SET online = 1");

  // "Try again now" lifts the wait.
  db.run("UPDATE contents SET onext = ? WHERE id = ?", Date.now() + HOUR, cid);
  assert.deepEqual(eng.retry(), { files: 0, ocr: 1 });
  assert.equal(c().onext, null);
  assert.equal(c().orounds, 0);
});

test("a failed database write does not strand its files in memory", async () => {
  const { tree, db } = fixture("dbfail", { "a.txt": "some text" });
  await scanRoot(db, 1);
  const eng = new Engine(db);
  const id = rowOf(db, "a.txt").id;
  const sha = crypto.randomBytes(32);
  inner(eng).inflight.add(id);
  inner(eng).done.push({ job: { id, abs: path.join(tree, "a.txt"), size: 9, ext: "txt", mtime: 0 }, sha, actual: { size: 9, mtime: 0 } });
  db.raw.exec("CREATE TRIGGER boom BEFORE UPDATE OF content ON files BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  try {
    assert.throws(() => eng.flush(), /disk full/);
  } finally {
    db.raw.exec("DROP TRIGGER boom");
  }
  assert.equal(inner(eng).inflight.has(id), false, "released, so it can be read again");
  assert.ok(inner(eng).retryAt.get(id)! > Date.now(), "after a pause");
  assert.ok(inner(eng).holdUntil > Date.now(), "new work waits too");
  assert.equal(rowOf(db, "a.txt").state, S.NEW, "nothing half-written");
  assert.equal(db.get("SELECT 1 AS x FROM contents WHERE sha = ?", sha), undefined, "rolled back whole");
});
