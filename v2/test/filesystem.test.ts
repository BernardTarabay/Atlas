// The filesystem model (Phase 4 of docs/18-v2-reliability-audit.md):
//   - gone is decided slowly: SUSPECT first, MISSING only when a later scan agrees
//   - a drive letter is a place, the volume serial is the disk
//   - a decision follows a file moved where no file ID can follow it, by content, if unambiguous
//   - a file still being written is left to settle, unread
//   - late or stale results never land on the wrong row
import "./_env.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/db/db.ts";
import { Engine } from "../src/pipeline/engine.ts";
import { AnalyzePool } from "../src/pipeline/pool.ts";
import { scanRoot, carryByContent } from "../src/scan/scanner.ts";
import { volumeAt } from "../src/scan/volumes.ts";
import { planBatch } from "../src/plan/planner.ts";
import { S, OCR, CONFIRM_MISSING_MS } from "../src/pipeline/states.ts";

const cleanup: (() => void)[] = [];
after(() => { for (const f of cleanup.reverse()) try { f(); } catch { /* best effort */ } });
function tree(name: string, files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-${name}-`));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function database(name: string, ...roots: string[]) {
  const db = new Db(path.join(process.env.ATLAS_HOME!, `${name}.db`));
  for (const r of roots) db.run("INSERT INTO roots(path, created) VALUES (?, ?)", r, Date.now());
  cleanup.push(() => db.close());
  return db;
}
interface Row { id: number; state: number; missed: number | null; plan: string | null; pin: string | null; content: number | null; born: number | null }
const rowOf = (db: Db, p: string) => db.get<Row>("SELECT id, state, missed, plan, pin, content, born FROM files WHERE path = ?", p);
const age = (db: Db, p: string, ms: number) => db.run("UPDATE files SET missed = missed - ? WHERE path = ?", ms, p);

test("gone is decided slowly: suspect first, missing only when a later scan agrees", async () => {
  const dir = tree("slow", { "keep.txt": "k", "blink.txt": "b", "gone.txt": "g", "sub/inner.txt": "i" });
  const db = database("slow", dir);
  await scanRoot(db, 1);
  db.run(`UPDATE files SET state = ${S.DONE}, plan = 'Docs/' || path`);

  fs.renameSync(path.join(dir, "blink.txt"), path.join(dir, "blink.tmp")); // an editor mid-save
  fs.rmSync(path.join(dir, "gone.txt"));
  let s = await scanRoot(db, 1);
  assert.equal(s.suspect, 2);
  assert.equal(s.missing, 0, "one scan proves nothing");
  assert.equal(rowOf(db, "gone.txt")!.state, S.DONE, "a suspect keeps its state");
  assert.ok(rowOf(db, "gone.txt")!.plan, "and its place in the library");

  fs.renameSync(path.join(dir, "blink.tmp"), path.join(dir, "blink.txt")); // the save completes
  s = await scanRoot(db, 1);
  assert.equal(rowOf(db, "blink.txt")!.missed, null, "seen again: no longer suspect");
  assert.equal(rowOf(db, "gone.txt")!.state, S.DONE, "a second scan minutes later: still only suspect");

  age(db, "gone.txt", CONFIRM_MISSING_MS);
  s = await scanRoot(db, 1);
  assert.equal(s.missing, 1);
  assert.equal(rowOf(db, "gone.txt")!.state, S.MISSING, "a later scan, long enough after: missing");
  assert.equal(rowOf(db, "gone.txt")!.plan, null);

  // A folder that cannot be listed says nothing about what is in it.
  const inner = rowOf(db, "sub/inner.txt")!;
  execFileSync("icacls", [path.join(dir, "sub"), "/deny", `${os.userInfo().username}:(RD)`], { stdio: "ignore" });
  cleanup.push(() => execFileSync("icacls", [path.join(dir, "sub"), "/remove:d", os.userInfo().username], { stdio: "ignore" }));
  s = await scanRoot(db, 1);
  assert.ok(s.errors >= 1, "the folder could not be listed");
  assert.equal(rowOf(db, "sub/inner.txt")!.missed, null, "nothing under it is suspected");
  assert.equal(rowOf(db, "sub/inner.txt")!.state, inner.state);
  execFileSync("icacls", [path.join(dir, "sub"), "/remove:d", os.userInfo().username], { stdio: "ignore" });

  // An unreachable root says nothing either: nothing is suspected, whatever the time.
  const moved = `${dir}-away`;
  fs.renameSync(dir, moved);
  cleanup.push(() => { if (fs.existsSync(moved)) fs.renameSync(moved, dir); });
  s = await scanRoot(db, 1);
  assert.equal(s.offline, true);
  assert.equal(db.get<{ n: number }>(`SELECT count(*) AS n FROM files WHERE missed IS NOT NULL AND state <> ${S.MISSING}`)!.n, 0);
  fs.renameSync(moved, dir);
});

test("a different disk at a root's path is not scanned as that root, until someone says so", async () => {
  const dir = tree("otherdisk", { "a.txt": "a" });
  const db = database("otherdisk", dir);
  await scanRoot(db, 1);
  const real = db.get<{ volume: string }>("SELECT volume FROM roots")!.volume;
  assert.equal(real, await volumeAt(dir), "the scan recorded the disk's serial");
  db.run("UPDATE roots SET volume = 'deadbeef'"); // as if the root had been on another disk
  fs.writeFileSync(path.join(dir, "b.txt"), "b");
  fs.rmSync(path.join(dir, "a.txt"));
  const s = await scanRoot(db, 1);
  assert.equal(s.otherDisk, true);
  const r = db.get<{ online: number; seen_volume: string; scan_error: string }>("SELECT online, seen_volume, scan_error FROM roots")!;
  assert.equal(r.online, 0);
  assert.equal(r.seen_volume, real);
  assert.match(r.scan_error, /different disk/);
  assert.equal(rowOf(db, "b.txt"), undefined, "nothing listed from it");
  assert.equal(rowOf(db, "a.txt")!.missed, null, "nothing concluded from it");
  // "Use this disk"
  db.run("UPDATE roots SET volume = seen_volume, seen_volume = NULL");
  await scanRoot(db, 1);
  assert.ok(rowOf(db, "b.txt"), "accepted: scanned as this root");
});

test("a drive that comes back under another letter is followed", async (t) => {
  const free = "RSTUVW".split("").filter((l) => !fs.existsSync(`${l}:\\`));
  if (process.platform !== "win32" || free.length < 2) { t.skip("needs Windows and two free drive letters"); return; }
  const [first, second] = free;
  const disk = tree("letters", { "Photos/p1.jpg": "pixels" });
  const subst = (...a: string[]) => execFileSync("subst", a, { stdio: "ignore" });
  subst(`${first}:`, disk);
  cleanup.push(() => { try { subst(`${first}:`, "/D"); } catch { /* gone */ } });
  const db = database("letters", `${first}:\\Photos`);
  await scanRoot(db, 1);
  const volume = db.get<{ volume: string }>("SELECT volume FROM roots")!.volume;
  // Unplugged, and plugged back in as another letter.
  subst(`${first}:`, "/D");
  subst(`${second}:`, disk);
  cleanup.push(() => { try { subst(`${second}:`, "/D"); } catch { /* gone */ } });
  const s = await scanRoot(db, 1);
  assert.equal(s.offline, true);
  const eng = new Engine(db);
  eng.reloadRoots();
  await eng.checkOffline();
  const r = db.get<{ path: string; volume: string }>("SELECT path, volume FROM roots")!;
  assert.equal(r.path, `${second}:\\Photos`, "the root followed its disk");
  assert.equal(r.volume, volume);
  assert.deepEqual(eng.scanState.queued, [1], "and is scanned again");
  assert.ok(rowOf(db, "p1.jpg"), "its files are the same rows, not a new root");
});

test("a decision follows a file moved to another drive, by content, only when unambiguous", async () => {
  const a = tree("drive-a", { "Report.pdf": "the report", "Twin.pdf": "twin bytes" });
  const b = tree("drive-b", { "Old copy of Report.pdf": "the report" });
  const db = database("carry-sha", a, b);
  await scanRoot(db, 1);
  await scanRoot(db, 2);
  // Pretend all of them were read: one content row per distinct body.
  for (const [root, p, body] of [[1, "Report.pdf", "the report"], [1, "Twin.pdf", "twin bytes"], [2, "Old copy of Report.pdf", "the report"]] as const) {
    const sha = crypto.createHash("sha256").update(body).digest();
    db.run("INSERT INTO contents(sha, size) VALUES (?, ?) ON CONFLICT(sha) DO NOTHING", sha, body.length);
    db.run(`UPDATE files SET content = (SELECT id FROM contents WHERE sha = ?), state = ${S.DONE} WHERE root = ? AND path = ?`, sha, root, p);
  }
  // The old copy on drive B was always there: first seen long before the move.
  db.run("UPDATE files SET born = born - 86400000 WHERE path = 'Old copy of Report.pdf'");
  db.run("UPDATE files SET pin = 'Clients/Acme' WHERE path = 'Report.pdf'");
  db.run("UPDATE files SET pin = 'Twins' WHERE path = 'Twin.pdf'");
  // Moved to drive B (copy + delete): a new row appears there; the old path goes.
  fs.writeFileSync(path.join(b, "Moved Report.pdf"), "the report");
  fs.writeFileSync(path.join(b, "Twin (1).pdf"), "twin bytes");
  fs.writeFileSync(path.join(b, "Twin (2).pdf"), "twin bytes");
  fs.rmSync(path.join(a, "Report.pdf"));
  fs.rmSync(path.join(a, "Twin.pdf"));
  await scanRoot(db, 2);
  for (const [p, body] of [["Moved Report.pdf", "the report"], ["Twin (1).pdf", "twin bytes"], ["Twin (2).pdf", "twin bytes"]]) {
    const sha = crypto.createHash("sha256").update(body).digest();
    db.run(`UPDATE files SET content = (SELECT id FROM contents WHERE sha = ?), state = ${S.DONE} WHERE root = 2 AND path = ?`, sha, p);
  }
  await scanRoot(db, 1); // suspect
  assert.equal(carryByContent(db).carried, 0, "a suspect is not yet gone: nothing moves");
  age(db, "Report.pdf", CONFIRM_MISSING_MS);
  age(db, "Twin.pdf", CONFIRM_MISSING_MS);
  const s = await scanRoot(db, 1); // confirmed missing, and the carry runs
  assert.equal(s.missing, 2);
  assert.equal(rowOf(db, "Moved Report.pdf")!.pin, "Clients/Acme", "the one copy that appeared when the original vanished");
  assert.equal(rowOf(db, "Old copy of Report.pdf")!.pin, null, "a copy that was always there is not it");
  assert.equal(rowOf(db, "Report.pdf")!.pin, null, "handed over, not duplicated");
  assert.equal(rowOf(db, "Twin (1).pdf")!.pin, null, "two candidates: not guessed");
  assert.equal(rowOf(db, "Twin (2).pdf")!.pin, null);
  assert.equal(rowOf(db, "Twin.pdf")!.pin, "Twins", "the ambiguous decision stays where it was");
  assert.deepEqual(carryByContent(db), { carried: 0, unresolved: 1 });
});

test("a file still being written is left to settle, unread; late results land on nothing", async () => {
  // The real worker, with a real file written just now.
  const dir = tree("settle", { "downloading.bin": "partial" });
  const got: string[] = [];
  const pool = new AnalyzePool(1, 5000, 5000, () => true, () => got.push("done"), (_j, code) => got.push(code));
  try {
    pool.submit({ id: 1, root: 1, rel: "downloading.bin", abs: path.join(dir, "downloading.bin"), size: 7, ext: "bin",
      wholeFileBytes: 1 << 20, maxParseBytes: 1 << 20, maxTextChars: 1000, settleMs: 60_000 });
    for (let i = 0; i < 200 && !got.length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(got, ["SETTLING"]);
  } finally {
    await pool.stop();
  }

  const db = database("settle", dir);
  await scanRoot(db, 1);
  const eng = new Engine(db);
  const inner = eng as unknown as { failed: unknown[]; done: unknown[]; retryAt: Map<number, number> };
  const id = rowOf(db, "downloading.bin")!.id;
  const job = { id, root: 1, rel: "downloading.bin", abs: "x", size: 7, ext: "bin", mtime: 0 };
  for (const wait of [15_000, 30_000, 60_000]) {
    inner.failed.push({ job, code: "SETTLING", message: "" });
    const t = Date.now();
    eng.flush();
    assert.ok(Math.abs(inner.retryAt.get(id)! - (t + wait)) < 1000, `waits ${wait / 1000} s`);
  }
  const r = db.get<{ tries: number; err: string | null; state: number }>("SELECT tries, err, state FROM files WHERE id = ?", id)!;
  assert.deepEqual({ ...r }, { tries: 0, err: null, state: S.NEW }, "settling is not a failure: nothing recorded");

  // ENOENT: suspect, not missing; and not read again until a scan has seen it.
  inner.failed.push({ job, code: "ENOENT", message: "" });
  eng.flush();
  assert.equal(rowOf(db, "downloading.bin")!.state, S.NEW);
  assert.ok(rowOf(db, "downloading.bin")!.missed != null);
  await scanRoot(db, 1);
  assert.equal(rowOf(db, "downloading.bin")!.missed, null, "the scan saw it: fine again");

  // A result for this id but another path (the id reused by a different file) is dropped.
  inner.done.push({ job: { ...job, rel: "someone-else.bin" }, sha: crypto.randomBytes(32), actual: { size: 7, mtime: 0 } });
  eng.flush();
  assert.equal(rowOf(db, "downloading.bin")!.content, null, "not linked to content that is not its own");
});

test("OCR text is only kept for the content it was read for", async () => {
  const dir = tree("ocr-guard", { "scan.png": "pixels, version one" });
  const db = database("ocr-guard", dir);
  await scanRoot(db, 1);
  const cid = Number(db.run("INSERT INTO contents(sha, size, kind, ocr) VALUES (?, 20, 'image', 1)", crypto.randomBytes(32)).lastInsertRowid);
  db.run(`UPDATE files SET content = ?, state = ${S.DONE} WHERE path = 'scan.png'`, cid);
  const eng = new Engine(db);
  eng.reloadRoots();
  (eng as unknown as { ocr: unknown }).ocr = {
    idle: 1, busy: 0, close() {},
    recognize: async () => {
      fs.writeFileSync(path.join(dir, "scan.png"), "pixels, version TWO - saved while being read");
      return { text: "INVOICE 42 total due", lang: "en", engine: "test", pages: 1, ms: 1 };
    },
  };
  const inner = eng as unknown as { dispatchOcr(): boolean; flushOcr(): void; ocrOut: unknown[] };
  assert.equal(inner.dispatchOcr(), true);
  for (let i = 0; i < 200 && !inner.ocrOut.length; i++) await new Promise((r) => setTimeout(r, 10));
  inner.flushOcr();
  const c = db.get<{ ocr: number; onext: number | null }>("SELECT ocr, onext FROM contents WHERE id = ?", cid)!;
  assert.equal(c.ocr, OCR.PENDING, "text of a file that changed while being read is not stored");
  assert.ok(c.onext! > Date.now());
  assert.equal(db.get("SELECT 1 AS x FROM texts WHERE content = ?", cid), undefined);
});

test("making room for a name never files an unread file", () => {
  const db = database("evict", "C:\\EvictTest");
  // An edited file (NEW again, content gone) still holds its old planned name...
  db.run(`INSERT INTO files(root, path, size, mtime, seen, state, plan) VALUES (1, 'z/Invoice.pdf', 1, 0, 1, ${S.NEW}, 'Documents/Invoice.pdf')`);
  // ...and a file that sorts before it earns the same name.
  const sha = crypto.randomBytes(32);
  db.run("INSERT INTO contents(sha, size, kind, state, av) VALUES (?, 1, 'pdf', 10, 99)", sha);
  db.run(`INSERT INTO files(root, path, size, mtime, seen, state, content, pinname, pin) VALUES (1, 'a/Invoice.pdf', 1, 0, 1, ${S.IDENT}, 1, 'Invoice.pdf', 'Documents')`);
  planBatch(db, 100, new Set());
  assert.equal(rowOf(db, "a/Invoice.pdf")!.plan, "Documents/Invoice.pdf");
  const held = rowOf(db, "z/Invoice.pdf")!;
  assert.equal(held.plan, null, "gave up the name");
  assert.equal(held.state, S.NEW, "still waiting to be read, not filed unread");
});

test("a scan asked for while that root is being scanned runs again afterwards", async () => {
  const dir = tree("rescan", Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}.txt`, `file ${i}`])));
  const db = database("rescan", dir);
  const eng = new Engine(db);
  cleanup.push(() => void eng.stop());
  eng.start();
  eng.requestScan(1);
  for (let i = 0; i < 400 && eng.scanState.scanning !== 1; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(eng.scanState.scanning, 1);
  eng.requestScan(1);
  for (let i = 0; i < 400 && (eng.scanState.scanning != null || eng.scanState.queued.length); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(db.get<{ gen: number }>("SELECT gen FROM roots")!.gen, 2, "scanned twice, not dropped");
  await eng.stop();
});
