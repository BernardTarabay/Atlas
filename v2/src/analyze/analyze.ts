// Everything learned from a file's bytes, for one unique content.
// Called from the analysis worker AFTER hashing, and only when the content hash
// is new: duplicates never reach this.
import { createRequire } from "node:module";
import { sniff, type Kind } from "./sniff.ts";
import { decodeText, htmlToText, rtfToText } from "./decode.ts";
import { officeText } from "./office.ts";
import { pdfText } from "./pdf.ts";
import { imageInfo } from "./image.ts";
import { assessText, type Verdict } from "./quality.ts";
import { parseExifDate, parseFileTime, parseIsoDate, parsePdfDate } from "./dates.ts";
import { detectDocType, openingLines } from "./dtype.ts";
import { headingFrom, usableTitle } from "./title.ts";
import { detectLang } from "../search/text.ts";
import { OCR } from "../pipeline/states.ts";

const require = createRequire(import.meta.url);
const ole = require("./ole/oleCfbExtractor.cjs") as {
  extract(b: Buffer): Promise<{ text: string; metadata: { title: string | null; createdFileTime: unknown; modifiedFileTime: unknown } }>;
};

/** Bump when extraction improves, so older content rows can be re-analyzed. */
export const ANALYZER_VERSION = 3; // 3: document types by shape - salutations, closings, section headings (measured on RVL-CDIP)

export interface Analysis {
  kind: Kind;
  mime: string;
  quality: Verdict | null;
  lang: string | null;
  dtype: string | null;
  title: string | null;
  ddate: number | null;
  dsrc: string | null;
  width: number | null;
  height: number | null;
  pages: number | null;
  meta: Record<string, unknown> | null;
  text: string;
  ocr: number;
  error?: string;
}

const OCR_IMAGE_FORMATS = new Set(["jpeg", "jpg", "png", "tiff", "tif", "bmp", "gif", "webp", "heic"]);

/**
 * @param buf    the whole file, or null when it was too large to hold (then only `head` is available)
 * @param head   the first bytes (always present)
 */
export async function analyze(buf: Buffer | null, head: Buffer, ext: string, size: number, maxChars: number): Promise<Analysis> {
  const s = sniff(head, ext, buf ?? undefined);
  const a: Analysis = {
    kind: s.kind, mime: s.mime, quality: null, lang: null, dtype: null, title: null, ddate: null, dsrc: null,
    width: null, height: null, pages: null, meta: null, text: "", ocr: OCR.NA,
  };
  const meta: Record<string, unknown> = { format: s.format };
  let embeddedTitle: string | null = null;

  const date = (source: string, t: number | null) => {
    if (t != null && a.ddate == null) { a.ddate = t; a.dsrc = source; }
  };

  try {
    if (s.kind === "image") {
      const src = buf ?? head;
      const img = await imageInfo(src);
      a.width = img.width;
      a.height = img.height;
      if (img.make || img.model) meta.camera = [img.make, img.model].filter(Boolean).join(" ");
      if (img.software) meta.software = img.software;
      date("exif", parseExifDate(img.taken));
      date("exif-created", parseExifDate(img.created));
      if (OCR_IMAGE_FORMATS.has(s.format)) a.ocr = OCR.PENDING;
    } else if (buf && s.kind === "pdf") {
      const r = await pdfText(buf, maxChars);
      a.text = r.text;
      a.pages = r.pages;
      embeddedTitle = r.title;
      if (r.producer) meta.producer = r.producer;
      date("pdf", parsePdfDate(r.created));
      date("pdf-modified", parsePdfDate(r.modified));
    } else if (buf && s.zip && ["docx", "xlsx", "pptx", "odt", "ods", "odp"].includes(s.format)) {
      const r = officeText(buf, s.format, s.zip, maxChars);
      a.text = r.text;
      a.pages = r.pages;
      embeddedTitle = r.title;
      date("embedded", parseIsoDate(r.created));
      date("embedded-modified", parseIsoDate(r.modified));
    } else if (buf && (s.format === "doc" || s.format === "xls" || s.format === "ppt" || s.format === "ole")) {
      const r = await ole.extract(buf);
      a.text = r.text.length > maxChars ? r.text.slice(0, maxChars) : r.text;
      embeddedTitle = r.metadata.title;
      date("ole", parseFileTime(r.metadata.createdFileTime));
      date("ole-modified", parseFileTime(r.metadata.modifiedFileTime));
    } else if (s.kind === "text" || s.format === "csv" || s.format === "tsv" || s.format === "rtf") {
      // Large text/CSV files: the first bytes are enough to index and classify.
      const raw = decodeText(buf ?? head);
      if (s.format === "rtf") a.text = rtfToText(raw);
      else if (s.format === "html" || s.format === "htm" || s.format === "xhtml") {
        const h = htmlToText(raw);
        a.text = h.text;
        embeddedTitle = h.title;
      } else a.text = raw;
      if (a.text.length > maxChars) a.text = a.text.slice(0, maxChars);
    }
  } catch (e) {
    a.error = (e as Error).message?.slice(0, 300) || String(e);
  }

  if (a.text) {
    a.text = a.text.replace(/\u0000/g, "");
    a.quality = assessText(a.text, size);
    if (a.quality === "ok") {
      a.lang = detectLang(a.text);
      const heading = headingFrom(a.text);
      if (heading) meta.heading = heading;
      a.title = usableTitle(embeddedTitle);
      // A spreadsheet's cells are data, not prose: only its title and first lines say what it is.
      const body = s.kind === "sheet" ? "" : a.text;
      const name = `${a.title ?? ""}\n${heading ?? ""}\n${openingLines(a.text)}`;
      const dt = detectDocType(name, a.text.slice(0, s.kind === "sheet" ? 200 : 600), body);
      if (dt) { a.dtype = dt.type; meta.dtypeMatched = dt.matched.slice(0, 6); }
    }
  } else if (s.kind === "pdf" || s.kind === "doc") {
    a.quality = buf ? "empty" : null;
  }
  // A PDF whose text layer is missing or garbage is a scan: OCR is how it becomes readable.
  if (s.kind === "pdf" && a.quality && a.quality !== "ok") a.ocr = OCR.PENDING;
  a.meta = meta;
  return a;
}
