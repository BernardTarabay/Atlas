// What a person decided survives (Phase 2 of docs/18-v2-reliability-audit.md):
//   - a rename or move in Explorer carries the folder/name chosen in Atlas
//   - a choice made while a file is mid-processing is kept, not silently dropped
//   - choices are written durably, and exported beside the database
//   - an export can be imported back into a fresh database
import "./_env.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/db/db.ts";
import { Engine } from "../src/pipeline/engine.ts";
import { startServer } from "../src/server/http.ts";
import { config } from "../src/config.ts";
import * as auth from "../src/server/auth.ts";
import { scanRoot } from "../src/scan/scanner.ts";
import { S } from "../src/pipeline/states.ts";
import { IntentExport, collectIntent, importIntent, readIntent, type IntentFile } from "../src/intent.ts";

const home = process.env.ATLAS_HOME!;
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
function database(name: string, root?: string) {
  const db = new Db(path.join(home, `${name}.db`));
  if (root) db.run("INSERT INTO roots(path, created) VALUES (?, ?)", root, Date.now());
  cleanup.push(() => db.close());
  return db;
}
interface Row { id: number; path: string; state: number; pin: string | null; pinname: string | null; plan: string | null; fid: string | null; content: number | null }
const rowOf = (db: Db, p: string) => db.get<Row>("SELECT id, path, state, pin, pinname, plan, fid, content FROM files WHERE path = ?", p);

async function until(what: string, ok: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("durable(): FULL for its own commit only, and never nested", () => {
  const db = database("durable");
  const level = () => db.get<{ synchronous: number }>("PRAGMA synchronous")!.synchronous;
  assert.equal(level(), 1, "NORMAL by default");
  db.raw.exec("CREATE TABLE t(x)");
  let inside = -1;
  db.durable(() => { db.run("INSERT INTO t VALUES (1)"); inside = level(); });
  assert.equal(inside, 2, "FULL while it commits");
  assert.equal(level(), 1, "back to NORMAL after");
  assert.throws(() => db.durable(() => { throw new Error("boom"); }), /boom/);
  assert.equal(level(), 1, "back to NORMAL after a rollback too");
  assert.throws(() => db.tx(() => db.durable(() => 0)), /cannot run inside another transaction/);
});

test("a file renamed or moved in Explorer keeps the folder and name chosen for it", async () => {
  const dir = tree("carry", { "Inbox/contract.txt": "This agreement is made between the parties hereinafter", "Inbox/other.txt": "unrelated notes" });
  fs.linkSync(path.join(dir, "Inbox/other.txt"), path.join(dir, "Inbox/other-link.txt"));
  const db = database("carry", dir);
  const eng = new Engine(db);
  cleanup.push(() => void eng.stop());
  eng.start();
  eng.requestScan(1);
  const settled = () => db.get<{ n: number }>(`SELECT count(*) AS n FROM files WHERE state < ${S.DONE}`)!.n === 0
    && eng.pool.busy === 0 && eng.scanState.scanning == null && !eng.scanState.queued.length;
  await until("first pass", settled);

  db.run("UPDATE files SET pin = 'Legal/Signed', pinname = 'Lease 2024.txt', state = ? WHERE path = 'Inbox/contract.txt'", S.IDENT);
  db.run("UPDATE files SET pin = 'Mine' WHERE path = 'Inbox/other-link.txt'");
  db.run("UPDATE files SET pin = 'Theirs' WHERE path = 'Inbox/other.txt'");
  eng.wake();
  await until("planned", settled);
  assert.equal(rowOf(db, "Inbox/contract.txt")!.plan, "Legal/Signed/Lease 2024.txt");

  // Renamed AND moved to another folder in Explorer; the hard-linked file renamed too.
  fs.mkdirSync(path.join(dir, "Archive"));
  fs.renameSync(path.join(dir, "Inbox/contract.txt"), path.join(dir, "Archive/scan 0042.txt"));
  fs.renameSync(path.join(dir, "Inbox/other.txt"), path.join(dir, "Inbox/renamed-other.txt"));
  eng.requestScan(1);
  await until("rescan", () => eng.lastScans.get(1)!.carried > 0 && settled());

  assert.equal(rowOf(db, "Inbox/contract.txt"), undefined, "the old row is gone");
  const moved = rowOf(db, "Archive/scan 0042.txt")!;
  assert.equal(moved.pin, "Legal/Signed", "folder chosen by hand carried over");
  assert.equal(moved.pinname, "Lease 2024.txt", "name chosen by hand carried over");
  assert.equal(moved.plan, "Legal/Signed/Lease 2024.txt", "and still honoured by the plan");
  assert.equal(rowOf(db, "Inbox/renamed-other.txt")!.pin, "Theirs", "a renamed hard link carries its own choice");
  assert.equal(rowOf(db, "Inbox/other-link.txt")!.pin, "Mine", "the other name keeps its own choice");
  await eng.stop();
});

test("a choice carries even when the old row goes missing on a later scan", async () => {
  // An incomplete scan adopts the moved file but cannot mark its old path missing;
  // the next complete scan does. The choice must still arrive.
  const dir = tree("late", { "now-here.txt": "moved while a folder was unreadable" });
  const db = database("late", dir);
  await scanRoot(db, 1);
  const live = rowOf(db, "now-here.txt")!;
  db.run(`INSERT INTO files(root, path, size, mtime, fid, seen, state, pin, pinname) VALUES (1, 'was-here.txt', 1, 1, ?, 0, ${S.MISSING}, 'Kept/By Hand', 'Chosen.txt')`, live.fid);
  const s = await scanRoot(db, 1);
  assert.equal(s.carried, 1);
  const r = rowOf(db, "now-here.txt")!;
  assert.equal(r.pin, "Kept/By Hand");
  assert.equal(r.pinname, "Chosen.txt");
  assert.equal(rowOf(db, "was-here.txt"), undefined, "history row removed once its choice has moved");
});

test("the plan API keeps choices made mid-processing, and says when a file is gone", async () => {
  const dir = tree("api", { "a.txt": "a", "b.txt": "b", "c.txt": "c" });
  const db = database("api", dir);
  await scanRoot(db, 1); // every row NEW: nothing has been read yet
  const [a, b, c] = ["a.txt", "b.txt", "c.txt"].map((p) => rowOf(db, p)!);
  db.run(`UPDATE files SET state = ${S.MISSING} WHERE id = ?`, c.id);
  db.run(`UPDATE files SET state = ${S.DONE} WHERE id = ?`, b.id);
  const engine = new Engine(db);
  engine.pool = { busy: 0 } as Engine["pool"];
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-intent-api-"));
  cleanup.push(() => fs.rmSync(out, { recursive: true, force: true }));
  const intent = new IntentExport(db, out);
  (config as { port: number }).port = 7898;
  const server = startServer(db, engine, intent);
  cleanup.push(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const cookie = `atlas_sid=${auth.createSession(db, false)}`;
  const post = (p: string, body: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: 7898, method: "POST", path: p,
      headers: { host: "127.0.0.1:7898", origin: "http://127.0.0.1:7898", cookie, "content-type": "application/json" } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (x) => (t += x)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(t) }));
    });
    r.on("error", reject); r.end(data);
  });

  const m = await post("/api/plan/move", { ids: [a.id, b.id, c.id], folder: "Clients/Acme" });
  assert.equal(m.status, 200);
  assert.equal(m.body.moved, 2);
  assert.equal(m.body.skipped, 1, "the missing file is reported, not hidden");
  assert.equal(rowOf(db, "a.txt")!.pin, "Clients/Acme", "a file not yet read keeps the choice");
  assert.equal(rowOf(db, "a.txt")!.state, S.NEW, "and still gets read first");
  assert.equal(rowOf(db, "b.txt")!.state, S.IDENT, "a planned file is re-planned");
  assert.equal(rowOf(db, "c.txt")!.pin, null);

  assert.equal((await post("/api/plan/rename", { id: a.id, name: "Invoice 17.txt" })).status, 200);
  assert.equal(rowOf(db, "a.txt")!.pinname, "Invoice 17.txt");
  const gone = await post("/api/plan/rename", { id: c.id, name: "Nope.txt" });
  assert.equal(gone.status, 409, "renaming a file that is no longer on disk is refused, not faked");

  intent.flush();
  const x = readIntent(intent.latest)!;
  assert.deepEqual(x.files.map((f) => [f.path, f.pin, f.pinname]), [["a.txt", "Clients/Acme", "Invoice 17.txt"], ["b.txt", "Clients/Acme", null]]);
  assert.equal(x.roots.length, 1);
});

test("the export: atomic, unchanged is not rewritten, a dropped choice keeps the previous file, an empty database writes nothing", async () => {
  const dir = tree("export", { "x.txt": "x", "y.txt": "y" });
  const db = database("export", dir);
  await scanRoot(db, 1);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-intent-out-"));
  cleanup.push(() => fs.rmSync(out, { recursive: true, force: true }));
  const ex = new IntentExport(db, out);
  db.run("UPDATE files SET pin = 'A' WHERE path = 'x.txt'");
  db.run("UPDATE files SET pinname = 'Why.txt' WHERE path = 'y.txt'");
  assert.equal(ex.write(), "written");
  assert.equal(ex.write(), "unchanged");
  assert.equal(new IntentExport(db, out).write(), "unchanged", "a restart compares with the file on disk");
  assert.deepEqual(fs.readdirSync(out), ["latest.json"], "no temp files left, no history yet");

  db.run("UPDATE files SET pin = 'B' WHERE path = 'x.txt'"); // a changed choice
  assert.equal(ex.write(), "written");
  const hist = fs.readdirSync(path.join(out, "history"));
  assert.equal(hist.length, 1, "the version that said 'A' is kept");
  assert.equal(readIntent(path.join(out, "history", hist[0]))!.files.find((f) => f.path === "x.txt")!.pin, "A");

  db.run("UPDATE files SET pin = 'B', pinname = 'Also.txt' WHERE path = 'x.txt'"); // only an addition
  assert.equal(ex.write(), "written");
  assert.equal(fs.readdirSync(path.join(out, "history")).length, 1, "adding a choice loses nothing: no history copy");

  const empty = database("export-empty");
  assert.equal(new IntentExport(empty, out).write(), "empty");
  assert.equal(readIntent(path.join(out, "latest.json"))!.files.length, 2, "a new or lost database never overwrites the export");
});

test("import puts roots and choices back into a fresh database: by path, by file ID, by content, never by guess", async () => {
  const dir = tree("import", { "Kept/a.txt": "alpha", "Moved/b.txt": "bravo", "same-1.txt": "twin", "same-2.txt": "twin", "only.txt": "single copy" });
  // The database that was lost.
  const lost = database("import-lost", dir);
  await scanRoot(lost, 1);
  lost.run("UPDATE files SET pin = 'Folder A', pinname = 'Alpha.txt' WHERE path = 'Kept/a.txt'");
  lost.run("UPDATE files SET pin = 'Folder B' WHERE path = 'Moved/b.txt'");
  const x: IntentFile = { ...collectIntent(lost), written: new Date().toISOString() };
  const bFid = rowOf(lost, "Moved/b.txt")!.fid;
  // Entries only findable by content: one unique, one shared by two files.
  const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
  x.files.push({ root: dir, path: "elsewhere/only.txt", fid: null, sha: sha("single copy"), size: 11, pin: "By Content", pinname: null });
  x.files.push({ root: dir, path: "elsewhere/twin.txt", fid: null, sha: sha("twin"), size: 4, pin: "Which One", pinname: null });
  // Since the loss, b.txt was renamed in Explorer (same file, same file ID).
  fs.renameSync(path.join(dir, "Moved/b.txt"), path.join(dir, "Moved/b renamed.txt"));

  const db = database("import-fresh");
  const r1 = await importIntent(db, x, (id) => scanRoot(db, id));
  assert.deepEqual(r1.roots.added, [dir]);
  assert.equal(rowOf(db, "Kept/a.txt")!.pin, "Folder A");
  assert.equal(rowOf(db, "Kept/a.txt")!.pinname, "Alpha.txt");
  assert.equal(rowOf(db, "Moved/b renamed.txt")!.pin, "Folder B", "found by file ID after a rename");
  assert.equal(rowOf(db, "Moved/b renamed.txt")!.fid, bFid);
  assert.equal(r1.files.byPath, 1);
  assert.equal(r1.files.byFileId, 1);
  assert.equal(r1.files.unmatched.length, 2, "content matches need the files read first");

  // Atlas reads the files (here: content rows linked by hand), then import runs again.
  for (const p of ["same-1.txt", "same-2.txt", "only.txt"]) {
    const body = fs.readFileSync(path.join(dir, p));
    const digest = crypto.createHash("sha256").update(body).digest();
    db.run("INSERT INTO contents(sha, size) VALUES (?, ?) ON CONFLICT(sha) DO NOTHING", digest, body.length);
    db.run("UPDATE files SET content = (SELECT id FROM contents WHERE sha = ?), state = ? WHERE path = ?", digest, S.DONE, p);
  }
  db.run("UPDATE files SET pin = 'Changed Since' WHERE path = 'Kept/a.txt'");
  const r2 = await importIntent(db, x, (id) => scanRoot(db, id));
  assert.equal(rowOf(db, "only.txt")!.pin, "By Content", "one file with those bytes: placed");
  assert.equal(r2.files.bySha, 1);
  assert.equal(rowOf(db, "same-1.txt")!.pin, null, "two files with those bytes: not guessed");
  assert.equal(rowOf(db, "same-2.txt")!.pin, null);
  assert.equal(r2.files.ambiguous.length, 1);
  assert.equal(rowOf(db, "Kept/a.txt")!.pin, "Changed Since", "the database's own, newer choice wins");
  assert.equal(r2.files.conflicts.length, 1);
  assert.deepEqual(r2.roots.present, [dir], "roots are not added twice");
  const r3 = await importIntent(db, x, (id) => scanRoot(db, id));
  assert.equal(r3.files.byPath + r3.files.byFileId + r3.files.bySha, 0, "running it again changes nothing");
});
