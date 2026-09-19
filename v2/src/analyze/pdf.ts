// PDF text + info via pdf.js (the parser V1 settled on after pdf-parse failed on
// valid files). Runs inside an analysis worker thread; the pool kills a worker
// whose job exceeds config.jobTimeoutMs, so a pathological PDF cannot hang Atlas.
//
// Text is rebuilt from glyph POSITIONS, not from content-stream order. Many PDFs
// (Edge/Chrome output, most Arabic ones) emit one item per glyph, in visual
// left-to-right order, as Arabic presentation forms. Joining items in stream order
// turned "مدرسة مار يوسف" into "ف س و ي ر ا م..." -- 99% character error, measured.
// So: group items into lines by baseline, order each line left to right, insert a
// space only where there is a real gap, then put right-to-left lines back into
// reading order and fold presentation forms to ordinary letters.
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fontDir = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let lib: PdfJs | null = null;

export interface PdfResult { text: string; title: string | null; created: string | null; modified: string | null; producer: string | null; pages: number }

const MAX_PAGES = 500;
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const PRESENTATION = /[ﭐ-﷿ﹰ-﻿]+/g;

/** A pdf.js text item: its string, left x, baseline y, width, height, and pdf.js's direction guess. */
export interface Item { s: string; x: number; y: number; w: number; h: number; rtl: boolean }
interface Ch { c: string; cx: number; w: number; h: number; y: number; seq: number }

const LTR = /[A-Za-z0-9À-ɏ]/;

/**
 * One page's items -> text lines in reading order. Exported for tests.
 *
 * Items are exploded into characters placed at their visual position (pdf.js hands
 * rtl items back in logical order, so their characters run right to left), then
 * each line is rebuilt purely from geometry: order by x, split words at real gaps,
 * reverse the letters of Arabic words, and put right-to-left lines in reading order.
 */
export function assembleLines(items: Item[]): string[] {
  const chars: Ch[] = [];
  items.forEach((it, n) => {
    let cs = [...it.s];
    if (!cs.length) return;
    // A ligature is ONE glyph mapped to several letters in reading order ("لم"). pdf.js
    // reverses every right-to-left item as if it were visual, which scrambles exactly
    // these, handing back "مل". Width alone cannot tell a ligature from two thin letters
    // (it broke "ري" in التاريخ), so only the lam ligatures of Naskh fonts are undone:
    // a narrow two-letter item "Xل" with X one of meem, hah, jeem, khah, ya.
    if (it.rtl && cs.length === 2 && cs[1] === "ل" && "محجخيى".includes(cs[0]) && it.w < 0.6 * (it.h || 10)) cs = cs.reverse();
    const cw = it.w / cs.length;
    cs.forEach((c, i) => {
      const k = it.rtl ? cs.length - 1 - i : i;
      chars.push({ c, cx: it.x + cw * (k + 0.5), w: cw, h: it.h || 10, y: it.y, seq: n * 10000 + k });
    });
  });
  chars.sort((a, b) => b.y - a.y || a.cx - b.cx);
  const lines: Ch[][] = [];
  for (const ch of chars) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - ch.y) <= Math.max(2, 0.5 * ch.h)) last.push(ch);
    else lines.push([ch]);
  }
  const out: string[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.cx - b.cx);
    // Stacked ligatures (lam over meem in Naskh fonts) overlap horizontally, so x cannot
    // order them. The content stream draws glyphs in visual order; let it decide when two
    // glyphs overlap by more than half the narrower one.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        const overlap = Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
        if (overlap > 0.5 * Math.min(a.w, b.w) && b.seq < a.seq) { line[i - 1] = b; line[i] = a; }
      }
    }
    const words: Ch[][] = [[]];
    let prevRight = -Infinity;
    for (const ch of line) {
      if (!ch.c.trim()) { if (words[words.length - 1].length) words.push([]); prevRight = -Infinity; continue; }
      if (words[words.length - 1].length && ch.cx - ch.w / 2 - prevRight > 0.2 * ch.h) words.push([]);
      words[words.length - 1].push(ch);
      prevRight = ch.cx + ch.w / 2;
    }
    const units = words.filter((w) => w.length).map((w) => {
      const s = w.map((c) => c.c).join("");
      return ARABIC.test(s) ? [...w].reverse().map((c) => c.c).join("") : s;
    });
    const arabicChars = units.join("").match(new RegExp(ARABIC.source, "g"))?.length ?? 0;
    const latinChars = units.join("").match(/[A-Za-zÀ-ɏ]/g)?.length ?? 0;
    let ordered = units;
    if (arabicChars > latinChars) {
      // Right-to-left line: reverse the words, but keep each run of left-to-right words in order.
      ordered = [];
      let run: string[] = [];
      const flush = () => { ordered.push(...run); run = []; };
      for (const u of [...units].reverse()) {
        if (!ARABIC.test(u) && LTR.test(u)) run.unshift(u);
        else { flush(); ordered.push(u); }
      }
      flush();
      // Inside Arabic text, "2020-0762" displays as "0762-2020" (the hyphen splits Arabic-number runs).
      ordered = ordered.map((u) => (/^\d+(-\d+)+$/.test(u) ? u.split("-").reverse().join("-") : u));
    }
    const text = ordered.join(" ").replace(PRESENTATION, (m) => m.normalize("NFKC"));
    if (text) out.push(text);
  }
  return out;
}

export async function pdfText(buf: Buffer, maxChars: number): Promise<PdfResult> {
  lib ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await lib.getDocument({
    data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    standardFontDataUrl: fontDir,
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const pages = doc.numPages;
    let text = "";
    for (let n = 1; n <= Math.min(pages, MAX_PAGES) && text.length < maxChars; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        items.push({ s: item.str, x: item.transform[4], y: item.transform[5], w: item.width, h: Math.abs(item.transform[3]) || item.height, rtl: item.dir === "rtl" });
      }
      text += assembleLines(items).join("\n") + "\n\n";
      page.cleanup();
    }
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return {
      text: text.length > maxChars ? text.slice(0, maxChars) : text,
      title: str(info.Title), created: str(info.CreationDate), modified: str(info.ModDate), producer: str(info.Producer), pages,
    };
  } finally {
    await doc.destroy();
  }
}
