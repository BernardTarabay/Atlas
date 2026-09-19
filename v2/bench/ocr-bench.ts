// OCR engine benchmark against the rendered ground-truth set (bench/ocr-corpus.ts).
//
// Measures, per engine and per (language, variant):
//   cer        character error rate on normalized text (what search sees), lower is better
//   recall     share of ground-truth words found (can the file be found by its words?)
//   precision  share of output words that are real (garbage inflates the index)
//   ms         time per image; wall = images/s at the given concurrency
//
// Usage: node bench/ocr-bench.ts [--engines win,win-auto,tess-fast,...] [--sample 1] [--concurrency 4]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WinRt } from "../src/ocr/winrt.ts";
import { OcrService } from "../src/ocr/ocr.ts";
import { tesseract } from "../src/ocr/tesseract.ts";
import { visualToLogical } from "../src/ocr/bidi.ts";
import { normalize, tokens } from "../src/search/text.ts";
import { analyze } from "../src/analyze/analyze.ts";
import { assessText } from "../src/analyze/quality.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const base = path.resolve(opt("corpus", path.join(os.homedir(), "AtlasBench", "ocr")));
const SAMPLE = Number(opt("sample", "1"));
const CONC = Number(opt("concurrency", "4"));
const TD_FAST = path.join(os.homedir(), "AtlasBench", "tessdata_fast");
const TD_BEST = path.join(os.homedir(), "AtlasBench", "tessdata_best");
const truth = JSON.parse(fs.readFileSync(path.join(base, "truth.json"), "utf8")) as Record<string, { lang: "ar" | "fr" | "en"; variant: string; template: string; text: string }>;

// ---------- scoring ----------
function lev(a: string, b: string): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Uint32Array(b.length + 1), cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
function score(out: string, ref: string) {
  const o = normalize(out), r = normalize(ref);
  const cer = r.length ? Math.min(1, lev(o, r) / r.length) : o.length ? 1 : 0;
  const rt = tokens(ref), ot = tokens(out);
  const bag = new Map<string, number>();
  for (const t of ot) bag.set(t, (bag.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of rt) { const n = bag.get(t) ?? 0; if (n > 0) { hit++; bag.set(t, n - 1); } }
  return { cer, recall: rt.length ? hit / rt.length : 1, precision: ot.length ? hit / ot.length : rt.length ? 0 : 1, outChars: o.length };
}

// ---------- engines ----------
const WIN_LANG = { ar: "ar-SA", fr: "fr-FR", en: "en-US" } as const;
const TESS_LANG = { ar: "ara", fr: "fra", en: "eng" } as const;
const winPool = Array.from({ length: CONC }, () => new WinRt(120_000));
let winNext = 0;
const win = () => winPool[winNext++ % winPool.length];

/** Letters-per-word plausibility: how much of this output looks like words in one script. */
function plausibility(text: string): number {
  let good = 0;
  for (const t of tokens(text)) if ([...t].length >= 3 && /^[\p{L}]+$/u.test(t)) good += [...t].length;
  return good;
}

type Item = { rel: string; file: string; lang: "ar" | "fr" | "en"; pdf: boolean };
type Engine = (it: Item) => Promise<{ text: string; ms: number; calls?: number }>;

const winOcr = async (it: Item, lang: string) => {
  const r = it.pdf ? await win().ocrPdf(it.file, 0, 200, lang) : await win().ocr(it.file, lang);
  return { text: lang.startsWith("ar") ? visualToLogical(r.text) : r.text, ms: r.ms };
};

const service = new OcrService(CONC);

const ENGINES: Record<string, Engine> = {
  // Exactly what the pipeline ships: src/ocr/ocr.ts, language not known in advance.
  "atlas": async (it) => {
    const r = await service.recognize(it.file, it.pdf ? "pdf" : "image");
    return { text: r.text, ms: r.ms };
  },
  // Windows OCR, language known in advance (upper bound for Windows).
  "win": (it) => winOcr(it, WIN_LANG[it.lang]),
  // Windows OCR, language NOT known: Latin model first; Arabic only if the Latin read looks like garbage.
  "win-auto": async (it) => {
    const latin = await winOcr(it, "fr-FR");
    if (assessText(latin.text) === "ok" && plausibility(latin.text) > 0.5 * normalize(latin.text).length) return { ...latin, calls: 1 };
    const ar = await winOcr(it, "ar-SA");
    return plausibility(ar.text) > plausibility(latin.text) ? { text: ar.text, ms: latin.ms + ar.ms, calls: 2 } : { text: latin.text, ms: latin.ms + ar.ms, calls: 2 };
  },
  "tess-fast": async (it) => tesseract(await raster(it), { langs: TESS_LANG[it.lang], tessdata: TD_FAST }),
  "tess-best": async (it) => tesseract(await raster(it), { langs: TESS_LANG[it.lang], tessdata: TD_BEST }),
  // V1's approach: all three languages at once, language not known.
  "tess-multi": async (it) => tesseract(await raster(it), { langs: "ara+fra+eng", tessdata: TD_FAST }),
  // Router: Windows for Latin script, Tesseract fast for Arabic, script decided by the Windows Latin pass.
  "route": async (it) => {
    const latin = await winOcr(it, "fr-FR");
    if (assessText(latin.text) === "ok" && plausibility(latin.text) > 0.5 * normalize(latin.text).length) return { ...latin, calls: 1 };
    const ar = await tesseract(await raster(it), { langs: "ara", tessdata: TD_FAST });
    return plausibility(ar.text) > plausibility(latin.text) ? { text: ar.text, ms: latin.ms + ar.ms, calls: 2 } : { text: latin.text, ms: latin.ms + ar.ms, calls: 2 };
  },
};

// Tesseract cannot read PDFs: image-only PDF pages are rasterized once (by Windows) and cached.
const rasterDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-raster-"));
const rastered = new Map<string, Promise<string>>();
function raster(it: Item): Promise<string> {
  if (!it.pdf) return Promise.resolve(it.file);
  let p = rastered.get(it.file);
  if (!p) {
    const out = path.join(rasterDir, path.basename(it.file, ".pdf") + ".png");
    p = win().render(it.file, 0, 200, out).then(() => out);
    rastered.set(it.file, p);
  }
  return p;
}

// ---------- run ----------
const items: Item[] = Object.entries(truth)
  .filter(([rel]) => !rel.startsWith("pdf-text/"))
  .filter((_, i) => i % SAMPLE === 0)
  .map(([rel, t]) => ({ rel, file: path.join(base, rel), lang: t.lang, pdf: rel.endsWith(".pdf") }));
const which = opt("engines", "win,win-auto,tess-fast,tess-best,tess-multi,route").split(",").filter((e) => ENGINES[e]);

interface Row { engine: string; lang: string; variant: string; cer: number; recall: number; precision: number; ms: number; calls: number; outChars: number }
const rows: Row[] = [];
const summary: Record<string, { images: number; wallS: number; errors: number }> = {};
for (const name of which) {
  const engine = ENGINES[name];
  const t0 = performance.now();
  let i = 0, errors = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < items.length) {
      const it = items[i++];
      const t = truth[it.rel];
      try {
        const r = await engine(it);
        rows.push({ engine: name, lang: t.lang, variant: t.variant, ...score(r.text, t.text), ms: r.ms, calls: r.calls ?? 1 });
      } catch (e) {
        errors++;
        rows.push({ engine: name, lang: t.lang, variant: t.variant, cer: 1, recall: 0, precision: 0, ms: 0, calls: 1, outChars: 0 });
        if (errors <= 3) console.error(`${name} ${it.rel}: ${(e as Error).message}`);
      }
    }
  }));
  summary[name] = { images: items.length, wallS: +((performance.now() - t0) / 1000).toFixed(1), errors };
  console.error(`${name}: ${items.length} images in ${summary[name].wallS}s (${errors} errors)`);
}

// ---------- pdf text layers (not OCR): does extraction keep Arabic in reading order? ----------
const pdfRows: { lang: string; cer: number; recall: number }[] = [];
for (const [rel, t] of Object.entries(truth).filter(([r]) => r.startsWith("pdf-text/"))) {
  const buf = fs.readFileSync(path.join(base, rel));
  const a = await analyze(buf, buf.subarray(0, 65536), "pdf", buf.length, 1e6);
  const s = score(a.text, t.text);
  pdfRows.push({ lang: t.lang, cer: s.cer, recall: s.recall });
}

// ---------- report ----------
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const table: Record<string, unknown>[] = [];
const variants = ["clean", "scan", "photo", "screenshot", "pdf-scan"];
for (const name of which) {
  for (const lang of ["ar", "fr", "en"]) {
    const r = rows.filter((x) => x.engine === name && x.lang === lang && x.variant !== "notext");
    const cell: Record<string, unknown> = { engine: name, lang };
    for (const v of variants) {
      const rv = r.filter((x) => x.variant === v);
      cell[v] = rv.length ? `${pct(avg(rv.map((x) => x.cer)))} / ${pct(avg(rv.map((x) => x.recall)))}` : "";
    }
    cell.msPerImage = Math.round(avg(r.map((x) => x.ms)));
    table.push(cell);
  }
  const nt = rows.filter((x) => x.engine === name && x.variant === "notext");
  table.push({ engine: name, lang: "notext", clean: `${nt.filter((x) => x.outChars >= 10).length}/${nt.length} produced text`, msPerImage: Math.round(avg(nt.map((x) => x.ms))) });
}
console.log("\nCER / word recall per variant (lower CER, higher recall = better):");
console.table(table);
console.log("Throughput:", JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, `${(v.images / v.wallS).toFixed(1)} img/s, ${v.errors} errors`]))));
console.log("PDF text layer via pdf.js:", JSON.stringify(Object.fromEntries(["ar", "fr", "en"].map((l) => {
  const r = pdfRows.filter((x) => x.lang === l);
  return [l, `CER ${pct(avg(r.map((x) => x.cer)))}, recall ${pct(avg(r.map((x) => x.recall)))}`];
}))));
const resDir = path.join(import.meta.dirname, "results");
fs.mkdirSync(resDir, { recursive: true });
fs.writeFileSync(path.join(resDir, `ocr-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ summary, table, rows, pdfRows }, null, 1));
for (const w of winPool) w.close();
service.close();
fs.rmSync(rasterDir, { recursive: true, force: true });
