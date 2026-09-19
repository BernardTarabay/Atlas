// OCR service: a small pool of engine slots behind one call, `recognize(file)`.
// The engine strategy (which engine, which language, in what order) is decided by
// bench/ocr-bench.ts on ground truth, and lives in `route` below -- nowhere else.
import { WinRt, winrtAvailable, type OcrText } from "./winrt.ts";
import { visualToLogical } from "./bidi.ts";
import { normalize, tokens, detectLang } from "../search/text.ts";
import { assessText } from "../analyze/quality.ts";

export interface OcrResult { text: string; lang: string | null; engine: string; pages: number; ms: number }

/** Share of the output that looks like real words in one script (garbage from the wrong model scores low). */
export function plausibility(text: string): number {
  const n = normalize(text).length;
  if (!n) return 0;
  let good = 0;
  for (const t of tokens(text)) if ([...t].length >= 3 && /^\p{L}+$/u.test(t)) good += [...t].length;
  return good / n;
}

export class OcrService {
  private slots: { rt: WinRt; busy: boolean }[];
  readonly maxPdfPages: number;

  constructor(concurrency: number, maxPdfPages = 20) {
    this.slots = Array.from({ length: concurrency }, () => ({ rt: new WinRt(120_000), busy: false }));
    this.maxPdfPages = maxPdfPages;
  }

  static available(): boolean {
    return winrtAvailable();
  }

  get idle(): number { return this.slots.filter((s) => !s.busy).length; }
  get busy(): number { return this.slots.length - this.idle; }

  async recognize(file: string, kind: "image" | "pdf"): Promise<OcrResult> {
    const slot = this.slots.find((s) => !s.busy);
    if (!slot) throw new Error("no idle OCR slot");
    slot.busy = true;
    const t0 = performance.now();
    try {
      if (kind === "image") {
        const r = await this.route((lang) => slot.rt.ocr(file, lang));
        return { ...r, pages: 1, ms: Math.round(performance.now() - t0) };
      }
      const pages = Math.min(await slot.rt.pages(file), this.maxPdfPages);
      const parts: string[] = [];
      let engine = "", lang: string | null = null;
      for (let p = 0; p < pages; p++) {
        const r = await this.route((l) => slot.rt.ocrPdf(file, p, 200, l));
        parts.push(r.text);
        engine ||= r.engine;
        lang ??= r.lang;
      }
      return { text: parts.join("\n\n").trim(), lang, engine, pages, ms: Math.round(performance.now() - t0) };
    } finally {
      slot.busy = false;
    }
  }

  /**
   * Language routing for one page. Windows OCR needs a language up front; the Latin
   * model (fr-FR, which also reads English) goes first because it is the fastest and
   * most documents are Latin. If its reading is not plausible text, the page is
   * re-read with the Arabic model and the more plausible reading wins.
   */
  private async route(read: (lang: string) => Promise<OcrText>): Promise<{ text: string; lang: string | null; engine: string }> {
    const latin = await read("fr-FR");
    // An empty Latin reading is NOT proof of no text: the Latin model can see nothing in
    // an Arabic page. Only a clearly good Latin reading skips the Arabic pass.
    if (latin.text.trim() && assessText(latin.text) === "ok" && plausibility(latin.text) > 0.5) {
      return { text: latin.text, lang: detectLang(latin.text), engine: "win:fr-FR" };
    }
    const ar = await read("ar-SA");
    const arText = visualToLogical(ar.text);
    if (!arText.trim() && !latin.text.trim()) return { text: "", lang: null, engine: "win" };
    return plausibility(arText) > plausibility(latin.text)
      ? { text: arText, lang: "ar", engine: "win:ar-SA" }
      : { text: latin.text, lang: detectLang(latin.text), engine: "win:fr-FR" };
  }

  close() { for (const s of this.slots) s.rt.close(); }
}
