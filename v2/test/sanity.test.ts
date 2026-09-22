// The sanity check (Phase 5 of docs/18-v2-reliability-audit.md): report-only, off
// the main thread. A clean library reports nothing to worry about; every kind of
// contradiction it knows is found and named; nothing is ever written.
import "./_env.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/db/db.ts";
import { config } from "../src/config.ts";
import { Engine } from "../src/pipeline/engine.ts";
import { IntentExport } from "../src/intent.ts";
import { runSanity, saveReport, latestReport, formatReport, sanityDir } from "../src/db/sanity.ts";
import { Maintenance } from "../src/db/maintenance.ts";
import { S } from "../src/pipeline/states.ts";

const cleanup: (() => void)[] = [];
after(() => { for (const f of cleanup.reverse()) try { f(); } catch { /* best effort */ } });
const home = config.home;

async function processedLibrary(name: string, files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-${name}-`));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
    fs.utimesSync(path.join(dir, rel), new Date("2024-01-02T03:04:05Z"), new Date("2024-01-02T03:04:05Z"));
  }
  const file = path.join(home, `${name}.db`);
  const db = new Db(file);
  cleanup.push(() => db.close());
  db.run("INSERT INTO roots(path, created) VALUES (?, ?)", dir, Date.now());
  const eng = new Engine(db);
  eng.start();
  eng.requestScan(1);
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const pending = db.get<{ n: number }>(`SELECT count(*) AS n FROM files WHERE state < ${S.DONE}`)!.n;
    if (i > 4 && !pending && eng.pool.busy === 0 && eng.scanState.scanning == null && !eng.scanState.queued.length) break;
  }
  await eng.stop();
  return { dir, file, db };
}
const version = (db: Db) => db.get<{ data_version: number }>("PRAGMA data_version")!.data_version;
const ids = (r: { findings: { id: string }[] }) => r.findings.map((f) => f.id).sort();

test("a clean, processed library: nothing to worry about, and nothing written", async () => {
  const { file, db } = await processedLibrary("sane", {
    "Invoices/facture 2024-017.txt": "FACTURE N° 2024-017 Montant total TTC 900 euros",
    "Invoices/copy of facture.txt": "FACTURE N° 2024-017 Montant total TTC 900 euros",
    "Letters/letter.txt": "Dear Sir,\nThank you for your letter.\nYours sincerely,\nA. Person",
    "notes.txt": "some notes",
  });
  db.run("UPDATE files SET pin = 'Clients/Acme' WHERE path = 'Letters/letter.txt'");
  new IntentExport(db).write();
  const v = version(db);
  const r = await runSanity(file);
  assert.equal(version(db), v, "the check wrote nothing to the database");
  assert.deepEqual(r.findings.filter((f) => f.level !== "info").map((f) => `${f.id}: ${f.samples.join("; ")}`), [], "no errors, no warnings");
  assert.ok(r.checked.length >= 25, `${r.checked.length} checks ran`);
  assert.equal(r.rehash.verified, r.rehash.sampled, "every re-read file matches its hash");
  assert.ok(r.rehash.sampled >= 3);
});

test("every contradiction it knows is found, named, and left alone", async () => {
  const { dir, file, db } = await processedLibrary("insane", { "a.txt": "alpha", "b.txt": "bravo", "c.txt": "charlie", "twin.txt": "same", "twin2.txt": "same" });
  const row = (p: string) => db.get<{ id: number; content: number }>("SELECT id, content FROM files WHERE path = ?", p)!;
  const c = row("a.txt").content;
  db.tx(() => {
    db.run("UPDATE roots SET created = ?", Date.now() - 3 * 86_400_000); // old enough to expect a backup; none exists
    db.run(`INSERT INTO files(root, path, size, mtime, seen, state) VALUES (99, 'nowhere.txt', 1, 0, 1, ${S.NEW})`);
    db.run(`INSERT INTO files(root, path, size, mtime, seen, state, content, plan, rule) VALUES (1, 'dangling.txt', 1, 0, 1, ${S.DONE}, 99999, 'X/dangling.txt', 'r')`);
    db.run(`INSERT INTO files(root, path, size, mtime, seen, state, plan) VALUES (1, 'ghost.txt', 1, 0, 1, ${S.MISSING}, 'X/ghost.txt')`);
    db.run(`INSERT INTO files(root, path, size, mtime, seen, state, plan, rule) VALUES (1, 'unread.txt', 1, 0, 1, ${S.DONE}, 'X/unread.txt', 'r')`);
    db.run(`INSERT INTO files(root, path, size, mtime, seen, state, content, rule) VALUES (1, 'placeless.txt', 1, 0, 1, ${S.DONE}, ?, 'notes')`, c);
    db.run(`INSERT INTO files(root, path, size, mtime, seen, state, content, plan, rule) VALUES (1, 'same-place.txt', 1, 0, 1, ${S.DONE}, ?, (SELECT plan FROM files WHERE path = 'b.txt'), 'r')`, row("b.txt").content);
    db.run(`INSERT INTO files(root, path, size, mtime, seen, state, content, plan, rule) VALUES (1, 'case.txt', 1, 0, 1, ${S.DONE}, ?, upper((SELECT plan FROM files WHERE path = 'c.txt')), 'r')`, row("c.txt").content);
    db.run(`UPDATE files SET plan = 'Twins/twin2.txt', rule = 'r' WHERE path = 'twin2.txt'`); // two representatives
    db.run(`INSERT INTO files(root, path, size, mtime, seen, state) VALUES (1, 'failed.txt', 1, 0, 1, ${S.FAILED})`);
    db.run("INSERT INTO ops(batch, kind, file, src, dst, state) VALUES (1, 'move', 1, 'C:\\\\a', 'C:\\\\b', 1)");
    db.run("INSERT INTO fts_name(rowid, name) VALUES (88888, 'nothing')");
    db.run("INSERT INTO texts(content, src, body) VALUES (77777, 'x', 'text of nothing')");
    db.run("INSERT INTO roots(path, created, online, scan_error) VALUES ('Z:\\\\Unplugged', 0, 0, 'root folder is not reachable')");
    db.run("INSERT INTO roots(path, created, online, seen_volume, volume) VALUES ('Y:\\\\Swapped', 0, 0, '12345678', '87654321')");
    db.run(`UPDATE files SET missed = ? WHERE path = 'notes-stale.txt' OR path = 'b.txt'`, Date.now() - 2 * 86_400_000);
    db.run("UPDATE files SET pin = 'Somewhere' WHERE path = 'c.txt'"); // a choice never exported
  });
  // A file whose bytes changed while its size and date did not.
  const a = path.join(dir, "a.txt");
  const st = fs.statSync(a);
  fs.writeFileSync(a, "ALPHA");
  fs.utimesSync(a, st.atime, st.mtime);
  // Leftovers: an interrupted thumbnail, and a thumbnail that is not a picture.
  fs.mkdirSync(path.join(home, "thumbs", "ab"), { recursive: true });
  fs.writeFileSync(path.join(home, "thumbs", "ab", "x.img.123.tmp"), "half");
  fs.writeFileSync(path.join(home, "thumbs", "ab", "broken-256-v2.img"), "not a picture");
  cleanup.push(() => fs.rmSync(path.join(home, "thumbs"), { recursive: true, force: true }));

  const v = version(db);
  const r = await runSanity(file, { files: 1000, bytes: 1 << 30 });
  assert.equal(version(db), v, "found everything, changed nothing");
  const found = ids(r);
  for (const id of ["orphan-files", "dangling-content", "missing-with-plan", "filed-unread", "done-without-place", "plan-collision",
    "plan-case-collision", "representatives", "failed-unclassified", "ops-open", "fts-name-orphans", "text-orphans",
    "roots-offline", "roots-other-disk", "suspect-stale", "intent-export", "backup-stale", "rehash-differs", "litter", "thumbs-broken"]) {
    assert.ok(found.includes(id), `found: ${id}`);
  }
  const level = (id: string) => r.findings.find((f) => f.id === id)!.level;
  assert.equal(level("rehash-differs"), "error");
  assert.equal(level("plan-case-collision"), "warn");
  assert.equal(level("litter"), "info");
  assert.deepEqual(r.findings.find((f) => f.id === "rehash-differs")!.samples, [a], "names the file");
  assert.ok(r.errors >= 9 && r.warnings >= 7);
  const text = formatReport(r);
  assert.match(text, /ERROR Files whose bytes changed while their size and date did not: 1/);
  assert.ok(fs.existsSync(path.join(home, "thumbs", "ab", "broken-256-v2.img")), "report-only: nothing is deleted");
});

test("reports are kept (newest 30) and the daily check runs once a day, never on a damaged database", async () => {
  const dir = sanityDir();
  const base = { findings: [], checked: ["x"], rehash: { sampled: 0, verified: 0, skipped: 0, mb: 0 }, ms: 1, errors: 0, warnings: 0, infos: 0 };
  for (let i = 0; i < 33; i++) saveReport({ ...base, at: Date.UTC(2026, 0, 1, 0, 0, i) });
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".json")).length, 30);
  assert.equal(latestReport()!.at, Date.UTC(2026, 0, 1, 0, 0, 32));

  const { file } = await processedLibrary("daily", { "one.txt": "one" });
  const m = new Maintenance(file, () => {});
  assert.equal(await m.maybeSanity(true), null, "not before the database has passed its integrity check");
  await m.check();
  const r = await m.maybeSanity();
  assert.ok(r, "due: the last report is old");
  assert.equal(m.health.sanity.at, r!.at);
  assert.equal(await m.maybeSanity(), null, "not again within a day");
  assert.ok(await m.maybeSanity(true), "unless asked");
});
