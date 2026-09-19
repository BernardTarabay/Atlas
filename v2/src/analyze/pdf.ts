// PDF text + info via pdf.js (the parser V1 settled on after pdf-parse failed on
// valid files). Runs inside an analysis worker thread; the pool kills a worker
// whose job exceeds config.jobTimeoutMs, so a pathological PDF cannot hang Atlas.
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fontDir = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let lib: PdfJs | null = null;

export interface PdfResult { text: string; title: string | null; created: string | null; modified: string | null; producer: string | null; pages: number }

const MAX_PAGES = 500;

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
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      text += "\n";
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
