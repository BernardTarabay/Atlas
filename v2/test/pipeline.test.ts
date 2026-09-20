import "./_env.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/db/db.ts";
import { Engine } from "../src/pipeline/engine.ts";
import { search } from "../src/search/search.ts";
import { listFolder } from "../src/library.ts";
import { planBatch } from "../src/plan/planner.ts";
import { S } from "../src/pipeline/states.ts";
import { docx } from "./_zip.ts";

const tree = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-tree-"));
const put = (rel: string, data: string | Buffer, mtime = "2023-05-06T10:00:00Z") => {
  const abs = path.join(tree, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  fs.utimesSync(abs, new Date(mtime), new Date(mtime));
};
let db: Db;
let engine: Engine;

async function settle() {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const pending = db.get<{ n: number }>(`SELECT count(*) AS n FROM files WHERE state < ${S.DONE}`)!.n;
    if (pending === 0 && engine.pool.busy === 0 && engine.scanState.scanning == null && !engine.scanState.queued.length) return;
  }
  throw new Error("pipeline did not settle");
}
const byPath = (p: string) => db.get<{ id: number; state: number; plan: string | null; rule: string | null; content: number | null }>(
  "SELECT id, state, plan, rule, content FROM files WHERE path = ?", p)!;

before(async () => {
  put("Clients/Acme/scan0001.txt", "FACTURE N° 2023-0417\nMontant total TTC 1200 euros pour la prestation de service du mois de mars.");
  put("Backup/2023/Acme/scan0001 (1).txt", "FACTURE N° 2023-0417\nMontant total TTC 1200 euros pour la prestation de service du mois de mars.");
  put("المالية/تقرير.txt", "التقرير السنوي للمدرسة\nيعرض هذا التقرير نتائج السنة الدراسية وتفاصيل الميزانية والدفعات.");
  put("Notes/meeting.docx", docx("Meeting minutes March", ["Meeting minutes of the meeting", "The team reviewed the quarterly budget and the delivery schedule for the project."]));
  put("Photos/WhatsApp Image 2026-07-29 at 20.17.33.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  put("Photos/WhatsApp Image 2026-07-30 at 09.00.00.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]));
  put("to-move/Contract final.txt", "This agreement is made between the parties hereinafter referred to as the client and the provider.");
  put("to-change.txt", "first version of the notes");
  put("to-delete.txt", "temporary");
  fs.linkSync(path.join(tree, "to-change.txt"), path.join(tree, "hardlink-of-change.txt"));

  db = new Db(path.join(process.env.ATLAS_HOME!, "atlas.db"));
  db.run("INSERT INTO roots(path, created) VALUES (?, ?)", tree, Date.now());
  engine = new Engine(db);
  engine.start();
  engine.requestScan(1);
  await settle();
});

after(async () => {
  await engine.stop();
  db.close();
  fs.rmSync(tree, { recursive: true, force: true });
});

test("every file reaches DONE; identical bytes collapse to one representative", () => {
  assert.equal(db.get<{ n: number }>(`SELECT count(*) AS n FROM files WHERE state <> ${S.DONE}`)!.n, 0);
  const a = byPath("Clients/Acme/scan0001.txt"), b = byPath("Backup/2023/Acme/scan0001 (1).txt");
  assert.equal(a.content, b.content);
  assert.equal([a.plan, b.plan].filter(Boolean).length, 1, "exactly one copy is placed");
  assert.equal(a.plan, "Documents/Invoices/2023/2023-05-06 Invoice.txt", "the shallower path wins and the generic name is replaced");
  assert.equal(b.rule, "duplicate");
});

test("a hard link is an alias of the same file, not a duplicate", () => {
  assert.equal(byPath("hardlink-of-change.txt").rule === "alias" || byPath("to-change.txt").rule === "alias", true);
});

test("the virtual library lists folders and files without touching disk", () => {
  const root = listFolder(db, "");
  assert.ok(root.folders.some((f) => f.name === "Documents"));
  assert.ok(root.folders.some((f) => f.name === "Photos"));
  const photos = listFolder(db, "Photos/2026/2026-07");
  assert.deepEqual(photos.files.map((f) => f.name).sort(), ["2026-07-29 20.17.33 WhatsApp.jpeg", "2026-07-30 09.00.00 WhatsApp.jpeg"]);
  assert.ok(fs.existsSync(path.join(tree, "Photos/WhatsApp Image 2026-07-29 at 20.17.33.jpeg")), "originals are untouched");
});

test("a file moved by hand stays where it was put, and can be handed back", () => {
  // Dragging a file onto a folder pins it. The planner then keeps naming and
  // collision handling, but stops choosing the folder - and nothing on disk moves.
  const f = byPath("Clients/Acme/scan0001.txt");
  const before = f.plan;
  assert.ok(before?.startsWith("Documents/Invoices/"), "the rules filed it as an invoice");
  const onDisk = path.join(tree, "Clients/Acme/scan0001.txt");
  const stat = fs.statSync(onDisk);

  db.run(`UPDATE files SET pin = ?, state = ${S.IDENT} WHERE id = ?`, "Papers/Sorted by hand", f.id);
  planBatch(db, 100, new Set());
  const moved = byPath("Clients/Acme/scan0001.txt");
  assert.equal(moved.plan, "Papers/Sorted by hand/2023-05-06 Invoice.txt", "the folder is the pinned one, the name is still the rules'");
  assert.equal(moved.rule, "manual");
  assert.ok(listFolder(db, "Papers/Sorted by hand").files.some((x) => x.id === f.id));
  assert.deepEqual(
    [fs.existsSync(onDisk), fs.statSync(onDisk).mtimeMs],
    [true, stat.mtimeMs],
    "the file itself was not touched",
  );

  db.run(`UPDATE files SET pin = NULL, state = ${S.IDENT} WHERE id = ?`, f.id);
  planBatch(db, 100, new Set());
  assert.equal(byPath("Clients/Acme/scan0001.txt").plan, before, "handing it back restores the rules' choice");
  assert.equal(byPath("Clients/Acme/scan0001.txt").rule, "doc-invoice");
});

test("search: Arabic with and without the article, French plural, English, names", () => {
  const ar = search(db, "تقارير المدرسه");
  assert.equal(ar.hits.length, 0, "a broken plural is not light-stemmed (semantic search will cover it)");
  assert.equal(search(db, "التقرير").hits[0]?.path, "المالية/تقرير.txt");
  assert.equal(search(db, "تقرير").hits[0]?.path, "المالية/تقرير.txt");
  const fr = search(db, "factures");
  assert.equal(fr.hits.length, 1, "one hit per content, not per copy");
  assert.equal(fr.hits[0].path, "Clients/Acme/scan0001.txt");
  assert.ok(fr.hits[0].snippet?.includes("FACTURE"));
  assert.equal(search(db, "quarterly budget").hits[0]?.path, "Notes/meeting.docx");
  assert.equal(search(db, "2023-0417").hits.length, 1);
  assert.ok(search(db, "acme").hits.some((h) => h.why.includes("name")), "folder names are searchable");
});

test("rescan: moved file keeps its analysis (same NTFS file id), deleted is missing, edited is re-read", async () => {
  const moved = byPath("to-move/Contract final.txt");
  fs.mkdirSync(path.join(tree, "moved-here"));
  fs.renameSync(path.join(tree, "to-move/Contract final.txt"), path.join(tree, "moved-here/Contract final.txt"));
  fs.rmSync(path.join(tree, "to-delete.txt"));
  fs.writeFileSync(path.join(tree, "to-change.txt"), "second, longer version of the notes after editing");
  const hashedBefore = engine.counters.hashed;
  engine.requestScan(1);
  await settle();
  const now = byPath("moved-here/Contract final.txt");
  assert.equal(now.content, moved.content, "analysis carried over");
  assert.equal(db.get("SELECT 1 AS x FROM files WHERE path = 'to-move/Contract final.txt'"), undefined, "the old row is gone");
  assert.equal(byPath("to-delete.txt").state, S.MISSING);
  const changed = byPath("to-change.txt");
  assert.equal(changed.state, S.DONE);
  assert.equal(engine.counters.hashed - hashedBefore, 2, "only the edited file and its hard link were re-read");
});
