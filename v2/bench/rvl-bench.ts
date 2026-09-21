// Document typing on real scans, against labels a human assigned.
//
// RVL-CDIP small-200 (Hugging Face: vaclavpechtor/rvl_cdip-small-200): 3,200
// grayscale scans of real 1980s-90s business documents in 16 classes. Fetched by
// ~/AtlasBench/rvl-cdip/fetch.mjs, renamed scan-0001.tif... in shuffled order,
// with the classes only in truth.json - so nothing about the answer reaches
// Atlas through a file or folder name.
//
// It runs the REAL engine on them in a throwaway database - the same OCR, the
// same noise check, the same dictionary a library gets - then reads what each
// scan was typed as and compares. Two questions, kept apart:
//
//   recall      for classes Atlas has a type for: how often it is right
//   restraint   for classes it has no type for (adverts, news, handwriting...):
//               how often it wrongly stamps a type on them anyway
//
// Usage: node bench/rvl-bench.ts [dir] [--ocr N]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const oi = args.indexOf("--ocr");
const dir = path.resolve(args.find((a, i) => !a.startsWith("--") && i !== oi + 1) ?? path.join(os.homedir(), "AtlasBench", "rvl-cdip"));
process.env.ATLAS_OCR_WORKERS = oi >= 0 ? args[oi + 1] : "4";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-rvl-"));
process.env.ATLAS_HOME = home;
process.env.ATLAS_LOG_LEVEL ??= "warn";

const { Db } = await import("../src/db/db.ts");
const { Engine } = await import("../src/pipeline/engine.ts");

const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Record<string, { label: string; split: string }>;

/**
 * What a correct answer is for each RVL class. A set, because some classes are
 * honestly either: a memo is a kind of letter, or no type at all; an email
 * printout likewise. `null` means "no Atlas type fits" - the right answer is to
 * leave it unclassified.
 */
const EXPECT: Record<string, (string | null)[]> = {
  invoice: ["invoice"],
  letter: ["letter"],
  resume: ["cv"],
  "scientific report": ["report"],
  scientific_report: ["report"],
  memo: ["letter", null],
  email: ["letter", null],
  form: ["registration", null],
  questionnaire: ["registration", null],
  budget: ["statement", "report", null],
  scientific_publication: ["report", null],
  presentation: ["report", null],
  specification: [null],
  news_article: [null],
  advertisement: [null],
  handwritten: [null],
  file_folder: [null],
};
const hasType = (label: string) => EXPECT[label]?.some((t) => t !== null);

const db = new Db(path.join(home, "atlas.db"));
db.run("INSERT INTO roots(path, created) VALUES (?, ?)", path.join(dir, "scans"), Date.now());
const engine = new Engine(db);
const t0 = performance.now();
engine.start();
engine.requestScan(1);
const n = (sql: string) => db.get<{ n: number }>(sql)!.n;
let lastLog = 0;
await new Promise<void>((resolve) => {
  const tick = setInterval(() => {
    const pending = n("SELECT count(*) AS n FROM files WHERE state < 50");
    const ocr = n("SELECT count(*) AS n FROM contents WHERE ocr = 1");
    if (performance.now() - lastLog > 15000) {
      lastLog = performance.now();
      console.log(`  ${((performance.now() - t0) / 1000).toFixed(0)} s: ${pending} to read, ${ocr} waiting for OCR`);
    }
    if (!pending && !ocr && engine.pool.busy === 0 && engine.scanState.scanning == null && performance.now() - t0 > 3000) { clearInterval(tick); resolve(); }
  }, 500);
});
const secs = (performance.now() - t0) / 1000;
await engine.stop();

const rows = db.all<{ path: string; dtype: string | null; ocr: number; meta: string | null; tlen: number | null }>(
  `SELECT f.path, c.dtype, c.ocr, c.meta, c.tlen FROM files f JOIN contents c ON c.id = f.content`);
interface Stat { n: number; right: number; typed: number; read: number; chars: number; got: Map<string, number> }
const per = new Map<string, Stat>();
for (const r of rows) {
  const t = truth[r.path];
  if (!t) continue;
  const s = per.get(t.label) ?? { n: 0, right: 0, typed: 0, read: 0, chars: 0, got: new Map() };
  const meta = r.meta ? JSON.parse(r.meta) as { ocr?: { chars?: number; quality?: string } } : {};
  const chars = meta.ocr?.chars ?? 0;
  s.n++;
  s.chars += chars;
  if (meta.ocr?.quality === "ok") s.read++;
  if (r.dtype) s.typed++;
  if ((EXPECT[t.label] ?? [null]).includes(r.dtype ?? null)) s.right++;
  const k = r.dtype ?? "(none)";
  s.got.set(k, (s.got.get(k) ?? 0) + 1);
  per.set(t.label, s);
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
console.log(`\n${rows.length} scans in ${secs.toFixed(0)} s (${(rows.length / secs).toFixed(1)} scans/s)\n`);
console.log("class                     scans  OCR readable  avg chars  correct  typed as (top)");
const order = [...per.keys()].sort((a, b) => Number(hasType(b)) - Number(hasType(a)) || a.localeCompare(b));
let recallN = 0, recallRight = 0, restraintN = 0, restraintWrong = 0;
for (const label of order) {
  const s = per.get(label)!;
  const top = [...s.got.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`${label.padEnd(25)} ${String(s.n).padStart(5)}  ${pct(s.read, s.n).padStart(12)}  ${String(Math.round(s.chars / Math.max(1, s.n))).padStart(9)}  ${pct(s.right, s.n).padStart(7)}  ${top}`);
  if (EXPECT[label]?.every((t) => t === null)) { restraintN += s.n; restraintWrong += s.typed; }
  else if (label === "invoice" || label === "letter" || label === "resume" || label === "scientific_report") { recallN += s.n; recallRight += s.right; }
}
console.log(`\nrecall on invoice / letter / resume / scientific report: ${pct(recallRight, recallN)} (${recallRight}/${recallN})`);
console.log(`typed anyway, classes with no Atlas type:               ${pct(restraintWrong, restraintN)} (${restraintWrong}/${restraintN})`);
// Close the database before deleting its folder: Windows will not remove an open file.
db.close();
try { fs.rmSync(home, { recursive: true, force: true }); } catch { console.log(`(left the scratch database in ${home})`); }
process.exit(0);
