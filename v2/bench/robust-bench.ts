// Robustness and throughput on real files: what breaks, and how fast the rest goes.
//
// Built for GovDocs1 (digitalcorpora.org): files collected from US government web
// servers - malformed PDFs, Word 97, Excel, PowerPoint, PostScript, HTML, images,
// often with an extension that lies about what is inside. It runs the real engine
// over a folder in a throwaway database and reports:
//
//   throughput    files/s and MB/s on a real mix, not a synthetic one
//   failures      files that could not be read, by extension and by reason
//                 (a parser crash, a timeout, a file that changed underfoot)
//   readable      how much of each type yielded usable text
//   mismatches    files whose bytes are not what their extension says
//
// Usage: node bench/robust-bench.ts <dir> [--ocr N]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const oi = args.indexOf("--ocr");
const dir = path.resolve(args.find((a, i) => !a.startsWith("--") && i !== oi + 1) ?? path.join(os.homedir(), "AtlasBench", "govdocs1", "files"));
process.env.ATLAS_OCR_WORKERS = oi >= 0 ? args[oi + 1] : "4";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-robust-"));
process.env.ATLAS_HOME = home;
process.env.ATLAS_LOG_LEVEL ??= "error";

const { Db } = await import("../src/db/db.ts");
const { Engine } = await import("../src/pipeline/engine.ts");
const { kindFromExt } = await import("../src/analyze/sniff.ts");

const db = new Db(path.join(home, "atlas.db"));
db.run("INSERT INTO roots(path, created) VALUES (?, ?)", dir, Date.now());
const engine = new Engine(db);
const t0 = performance.now();
let readDone = 0;
engine.start();
engine.requestScan(1);
const n = (sql: string) => db.get<{ n: number }>(sql)!.n;
let lastLog = 0;
await new Promise<void>((resolve) => {
  const tick = setInterval(() => {
    const pending = n("SELECT count(*) AS n FROM files WHERE state < 50");
    const ocr = n("SELECT count(*) AS n FROM contents WHERE ocr = 1");
    if (!readDone && !pending && performance.now() - t0 > 2000) readDone = performance.now() - t0;
    if (performance.now() - lastLog > 15000) {
      lastLog = performance.now();
      console.log(`  ${((performance.now() - t0) / 1000).toFixed(0)} s: ${pending} to read, ${ocr} waiting for OCR`);
    }
    if (!pending && !ocr && engine.pool.busy === 0 && engine.scanState.scanning == null && performance.now() - t0 > 3000) { clearInterval(tick); resolve(); }
  }, 500);
});
const total = (performance.now() - t0) / 1000;
await engine.stop();

const extOf = (p: string) => { const b = p.slice(p.lastIndexOf("/") + 1); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i + 1).toLowerCase() : "(none)"; };
const files = db.all<{ path: string; size: number; state: number; err: string | null; kind: string | null; mime: string | null; quality: string | null; tlen: number | null; ocr: number | null }>(
  `SELECT f.path, f.size, f.state, f.err, c.kind, c.mime, c.quality, c.tlen, c.ocr FROM files f LEFT JOIN contents c ON c.id = f.content`);
const bytes = files.reduce((s, f) => s + f.size, 0);

console.log(`\n${files.length} files, ${(bytes / 1048576).toFixed(0)} MB`);
console.log(`read, hashed and analyzed in ${(readDone / 1000).toFixed(1)} s: ${(files.length / (readDone / 1000)).toFixed(0)} files/s, ${(bytes / 1048576 / (readDone / 1000)).toFixed(0)} MB/s`);
console.log(`including OCR: ${total.toFixed(0)} s`);

// ---- by extension: how many, how many readable, how many failed ----------
const byExt = new Map<string, { n: number; failed: number; readable: number; textual: number; bytes: number }>();
for (const f of files) {
  const e = extOf(f.path);
  const s = byExt.get(e) ?? { n: 0, failed: 0, readable: 0, textual: 0, bytes: 0 };
  s.n++; s.bytes += f.size;
  if (f.state === 90) s.failed++;
  const expectsText = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "html", "htm", "csv", "rtf", "xml", "ps", "text"].includes(e);
  if (expectsText) { s.textual++; if (f.quality === "ok" || (f.tlen ?? 0) > 100) s.readable++; }
  byExt.set(e, s);
}
console.log("\next        files      MB   failed   text found (of files that should have text)");
for (const [e, s] of [...byExt.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 18)) {
  console.log(`${e.padEnd(8)} ${String(s.n).padStart(7)} ${(s.bytes / 1048576).toFixed(0).padStart(7)} ${String(s.failed).padStart(8)}   ${s.textual ? `${Math.round((s.readable / s.textual) * 100)}% (${s.readable}/${s.textual})` : "-"}`);
}

// ---- failures, by reason ---------------------------------------------------
const failed = files.filter((f) => f.state === 90);
const reasons = new Map<string, { n: number; exts: Map<string, number>; sample: string }>();
for (const f of failed) {
  const r = (f.err ?? "unknown").replace(/\d+/g, "#").slice(0, 70);
  const s = reasons.get(r) ?? { n: 0, exts: new Map(), sample: f.path };
  s.n++; s.exts.set(extOf(f.path), (s.exts.get(extOf(f.path)) ?? 0) + 1);
  reasons.set(r, s);
}
console.log(`\nfailed: ${failed.length} of ${files.length} (${((failed.length / files.length) * 100).toFixed(2)}%)`);
for (const [r, s] of [...reasons.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
  console.log(`  ${String(s.n).padStart(5)}  ${r}   [${[...s.exts.entries()].map(([e, c]) => `${e} ${c}`).join(", ")}]  e.g. ${s.sample}`);
}

// ---- files whose bytes are not what the extension claims -------------------
const mism = new Map<string, number>();
for (const f of files) {
  if (!f.kind) continue;
  const claimed = kindFromExt(extOf(f.path)).kind;
  if (claimed !== "other" && claimed !== f.kind) {
    const k = `.${extOf(f.path)} is really ${f.kind}`;
    mism.set(k, (mism.get(k) ?? 0) + 1);
  }
}
console.log(`\nextension disagrees with the bytes: ${[...mism.values()].reduce((a, b) => a + b, 0)} files`);
for (const [k, c] of [...mism.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(c).padStart(5)}  ${k}`);

const ocr = db.all<{ ocr: number; n: number }>("SELECT ocr, count(*) AS n FROM contents GROUP BY ocr");
console.log(`\nOCR: ${ocr.map((r) => `${({ 0: "not needed", 1: "pending", 2: "read", 3: "failed", 4: "no engine" } as Record<number, string>)[r.ocr]} ${r.n}`).join(", ")}`);
// Close the database before deleting its folder: Windows will not remove an open file.
db.close();
try { fs.rmSync(home, { recursive: true, force: true }); } catch { console.log(`(left the scratch database in ${home})`); }
process.exit(0);
