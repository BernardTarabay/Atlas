// The database's own safety (Phase 3 of docs/18-v2-reliability-audit.md): integrity
// checks, verified backups with rotation, a restore that never deletes anything, and
// an import that can make decisions exactly what an export says.
import "./_env.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db } from "../src/db/db.ts";
import { config } from "../src/config.ts";
import { checkDatabase, listBackups, makeBackup, restoreBackup, Maintenance } from "../src/db/maintenance.ts";
import { importIntent, collectIntent, type IntentFile } from "../src/intent.ts";
import { scanRoot } from "../src/scan/scanner.ts";
import { Engine } from "../src/pipeline/engine.ts";
import { startServer } from "../src/server/http.ts";
import * as auth from "../src/server/auth.ts";
import { S } from "../src/pipeline/states.ts";

const cleanup: (() => void)[] = [];
after(() => { for (const f of cleanup.reverse()) try { f(); } catch { /* best effort */ } });
function tmp(name: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-${name}-`));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A real Atlas database with some bulk in it, closed (so it is one checkpointed file). */
function makeDb(dir: string, rows = 3000) {
  const file = path.join(dir, "atlas.db");
  const db = new Db(file);
  db.run("INSERT INTO roots(path, created) VALUES ('C:\\\\Example', 0)");
  db.tx(() => {
    for (let i = 0; i < rows; i++) {
      db.run(`INSERT INTO files(root, path, size, mtime, seen, state) VALUES (1, ?, ?, 0, 1, ${S.DONE})`, `folder/file-${i}-${"x".repeat(80)}.txt`, i);
    }
  });
  db.close();
  return file;
}
const countFiles = (file: string) => { const d = new DatabaseSync(file, { readOnly: true }); try { return (d.prepare("SELECT count(*) AS n FROM files").get() as { n: number }).n; } finally { d.close(); } };

/** Overwrite the middle of the file with garbage: pages of the files table, not the header. */
function damage(file: string) {
  const fd = fs.openSync(file, "r+");
  try {
    const size = fs.fstatSync(fd).size;
    fs.writeSync(fd, Buffer.alloc(8192, 0xa5), 0, 8192, Math.floor(size / 2 / 4096) * 4096);
  } finally { fs.closeSync(fd); }
}

test("the write-ahead log is capped once checkpointed", () => {
  const db = new Db(path.join(tmp("wal"), "atlas.db"));
  cleanup.push(() => db.close());
  assert.equal(db.get<{ journal_size_limit: number }>("PRAGMA journal_size_limit")!.journal_size_limit, 67108864);
});

test("a backup is a verified snapshot, and only the newest are kept", async () => {
  const home = tmp("backup");
  const file = makeDb(home);
  const dir = path.join(home, "backups");
  fs.mkdirSync(dir);
  // Eight older backups (names are the record of when), plus litter that is not a backup.
  for (let d = 1; d <= 8; d++) fs.writeFileSync(path.join(dir, `atlas-202601${String(d).padStart(2, "0")}-030000Z.db`), "old");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a backup");
  const r = await makeBackup(file, dir, 7);
  assert.ok(r.ok, JSON.stringify(r));
  const all = listBackups(dir);
  assert.equal(all.length, 7, "newest seven kept");
  assert.equal(all[0].file, r.backup.file, "the new one is the newest");
  assert.ok(!all.some((b) => b.file.endsWith("20260101-030000Z.db") || b.file.endsWith("20260102-030000Z.db")), "the two oldest rotated out");
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")), "other files are never touched");
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith(".part")), "no half-made copy left");
  assert.equal(countFiles(r.backup.file), 3000, "the copy holds the data");
  assert.equal((await checkDatabase(r.backup.file, true)).ok, true, "and passes the full check");
});

test("a backup taken while Atlas keeps writing is still whole", async () => {
  const home = tmp("busy");
  const file = makeDb(home, 500);
  const db = new Db(file);
  cleanup.push(() => db.close());
  const running = makeBackup(file, path.join(home, "backups"), 7);
  for (let i = 0; i < 200; i++) db.run(`INSERT INTO files(root, path, size, mtime, seen, state) VALUES (1, ?, 1, 0, 1, ${S.NEW})`, `during/${i}`);
  const r = await running;
  assert.ok(r.ok, JSON.stringify(r));
  const n = countFiles(r.backup.file);
  assert.ok(n >= 500 && n <= 700, `a consistent snapshot (${n} rows)`);
});

test("a damaged database is detected, and never copied over a good backup", async () => {
  const home = tmp("damaged");
  const file = makeDb(home);
  const dir = path.join(home, "backups");
  const good = await makeBackup(file, dir, 7);
  assert.ok(good.ok);
  damage(file);
  const check = await checkDatabase(file);
  assert.equal(check.ok, false);
  assert.ok(check.detail.length > 0, "the check says what is wrong");
  const r = await makeBackup(file, dir, 1);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.stage, "source", "blamed on the database, not the backup");
  assert.deepEqual(listBackups(dir).map((b) => b.file), [good.backup.file], "the good backup is still the one kept");
});

test("the startup check: a sound database is marked ok; a damaged one stops changes, once", async () => {
  fs.mkdirSync(config.backupDir, { recursive: true });
  fs.writeFileSync(path.join(config.backupDir, "atlas-20260101-000000Z.db.part"), "a backup cut short by a crash");
  const okHome = tmp("sound");
  const sound = new Maintenance(makeDb(okHome, 100), () => assert.fail("a sound database is not corrupt"));
  sound.start();
  sound.stop();
  assert.equal(fs.existsSync(path.join(config.backupDir, "atlas-20260101-000000Z.db.part")), false, "a crash's half backup is removed");
  await sound.check();
  assert.equal(sound.health.integrity, "ok");

  const bad = makeDb(tmp("broken"));
  damage(bad);
  const calls: string[][] = [];
  const m = new Maintenance(bad, (d) => calls.push(d));
  await m.check();
  await m.check();
  assert.equal(m.health.integrity, "failed");
  assert.equal(calls.length, 1, "told once");
  assert.equal(await m.maybeBackup(true), null, "no backup is made of a damaged database");
});

test("restore: verified first, the replaced database moved aside, never deleted", async () => {
  const home = tmp("restore");
  const file = makeDb(home, 100);
  const dir = path.join(home, "backups");
  const b = await makeBackup(file, dir, 7);
  assert.ok(b.ok);
  // Life goes on after the backup...
  const db = new Db(file);
  db.run(`INSERT INTO files(root, path, size, mtime, seen, state) VALUES (1, 'after-backup.txt', 1, 0, 1, ${S.NEW})`);
  db.close();

  const r = await restoreBackup(b.backup.file, home);
  assert.equal(countFiles(file), 100, "the database is the backup's");
  assert.ok(r.replacedDir && fs.existsSync(path.join(r.replacedDir, "atlas.db")), "the replaced one is kept");
  assert.equal(countFiles(path.join(r.replacedDir!, "atlas.db")), 101, "with what was written after the backup");
  assert.ok(fs.existsSync(b.backup.file), "the backup itself is still there");
  assert.equal((await checkDatabase(file, true)).ok, true);

  // A damaged backup, or one from a newer Atlas, is refused and changes nothing.
  const broken = path.join(dir, "atlas-20990101-000000Z.db");
  fs.copyFileSync(b.backup.file, broken);
  damage(broken);
  await assert.rejects(restoreBackup(broken, home), /failed its integrity check/);
  const future = path.join(home, "future.db");
  fs.copyFileSync(b.backup.file, future);
  const f = new DatabaseSync(future);
  f.exec("UPDATE meta SET value = '999' WHERE key = 'schema'");
  f.close();
  await assert.rejects(restoreBackup(future, home), /newer Atlas/);
  assert.equal(countFiles(file), 100, "untouched by the refused restores");
});

test("import --exact makes the database's decisions exactly an export's", async () => {
  const dir = tmp("exact");
  for (const [n, body] of Object.entries({ "a.txt": "a", "b.txt": "b", "c.txt": "c", "twin-1.txt": "same", "twin-2.txt": "same" })) fs.writeFileSync(path.join(dir, n), body);
  const db = new Db(path.join(tmp("exact-db"), "atlas.db"));
  cleanup.push(() => db.close());
  db.run("INSERT INTO roots(path, role, created) VALUES (?, 'source', 0)", dir);
  await scanRoot(db, 1);
  // The export: newer than the database (a restored backup).
  db.run("UPDATE files SET pin = 'Z' WHERE path = 'a.txt'");
  db.run("UPDATE files SET pinname = 'C.txt' WHERE path = 'c.txt'");
  const x: IntentFile = { ...collectIntent(db), written: new Date().toISOString() };
  x.roots[0].role = "library";
  const digest = crypto.createHash("sha256").update("same").digest();
  x.files.push({ root: dir, path: "gone/twin.txt", fid: null, sha: digest.toString("hex"), size: 4, pin: "Twin", pinname: null });
  // The database as the backup had it.
  db.run("UPDATE files SET pin = 'X', pinname = NULL WHERE path = 'a.txt'");
  db.run("UPDATE files SET pin = 'Y' WHERE path = 'b.txt'");
  db.run("UPDATE files SET pinname = NULL WHERE path = 'c.txt'");
  db.run("INSERT INTO contents(sha, size) VALUES (?, 4)", digest);
  db.run("UPDATE files SET content = (SELECT id FROM contents WHERE sha = ?) WHERE path LIKE 'twin-%'", digest);
  db.run("UPDATE files SET pin = 'Old twin choice' WHERE path = 'twin-1.txt'");

  const r = await importIntent(db, x, async () => {}, { exact: true });
  const pin = (p: string) => ({ ...db.get<{ pin: string | null; pinname: string | null }>("SELECT pin, pinname FROM files WHERE path = ?", p)! });
  assert.deepEqual(pin("a.txt"), { pin: "Z", pinname: null }, "changed since the backup: the export's");
  assert.deepEqual(pin("b.txt"), { pin: null, pinname: null }, "undone since the backup: removed");
  assert.deepEqual(pin("c.txt"), { pin: null, pinname: "C.txt" }, "made since the backup: added");
  assert.equal(pin("twin-1.txt").pin, "Old twin choice", "a file an ambiguous entry might mean is left alone");
  assert.equal(r.files.cleared, 1);
  assert.deepEqual(r.roots.updated, [dir]);
  assert.equal(db.get<{ role: string }>("SELECT role FROM roots")!.role, "library");
  const again = await importIntent(db, x, async () => {}, { exact: true });
  assert.equal(again.files.byPath + again.files.cleared, 0, "running it again changes nothing");
});

test("while the database is damaged, the plan and roots refuse changes and the Status page says why", async () => {
  const dir = tmp("guard");
  const db = new Db(path.join(dir, "atlas.db"));
  cleanup.push(() => db.close());
  db.run("INSERT INTO roots(path, created) VALUES (?, 0)", dir);
  db.run(`INSERT INTO files(root, path, size, mtime, seen, state) VALUES (1, 'a.txt', 1, 0, 1, ${S.DONE})`);
  const engine = new Engine(db);
  engine.pool = { busy: 0 } as Engine["pool"];
  const maint = { health: { integrity: "failed", detail: ["Tree 4 page 9: btreeInitPage() returns error code 11"], checkedAt: Date.now(),
    backup: { last: null, count: 3, running: false, error: null, dir: "D:\\Backups" } } } as unknown as Maintenance;
  (config as { port: number }).port = 7897;
  const server = startServer(db, engine, undefined, maint);
  cleanup.push(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const cookie = `atlas_sid=${auth.createSession(db, false)}`;
  const call = (method: string, p: string, body?: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: 7897, method, path: p,
      headers: { host: "127.0.0.1:7897", origin: "http://127.0.0.1:7897", cookie, "content-type": "application/json" } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (x) => (t += x)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(t || "{}") }));
    });
    r.on("error", reject); r.end(body ? JSON.stringify(body) : undefined);
  });
  const move = await call("POST", "/api/plan/move", { ids: [1], folder: "Somewhere" });
  assert.equal(move.status, 503);
  assert.match(String(move.body.error), /npm run db -- restore/);
  assert.equal(db.get<{ pin: string | null }>("SELECT pin FROM files WHERE id = 1")!.pin, null, "nothing written");
  assert.equal((await call("DELETE", "/api/roots/1")).status, 503);
  const dash = await call("GET", "/api/dashboard");
  assert.equal(dash.status, 200, "reading still works");
  assert.equal((dash.body.safety as { integrity: string }).integrity, "failed");
});
