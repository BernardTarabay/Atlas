// What a file IS, from its first bytes (and, for zips, the entry names).
// The extension is only a tiebreak: a .pdf that starts with PK is a zip.
import { readZipDirectory, type ZipEntry } from "./zip.ts";

export type Kind = "image" | "video" | "audio" | "pdf" | "doc" | "sheet" | "slides" | "text" | "archive" | "app" | "other";

export interface Sniffed { kind: Kind; mime: string; format: string; zip?: ZipEntry[] }

const EXT_KIND: Record<string, [Kind, string]> = {};
const add = (kind: Kind, mime: string, exts: string) => { for (const e of exts.split(" ")) EXT_KIND[e] = [kind, mime]; };
add("image", "image/jpeg", "jpg jpeg jpe jfif");
add("image", "image/png", "png");
add("image", "image/gif", "gif");
add("image", "image/bmp", "bmp");
add("image", "image/webp", "webp");
add("image", "image/tiff", "tif tiff");
add("image", "image/heic", "heic heif");
add("image", "image/avif", "avif");
add("image", "image/svg+xml", "svg");
add("image", "image/x-raw", "raw cr2 cr3 nef arw dng orf rw2 raf sr2");
add("video", "video/mp4", "mp4 m4v 3gp");
add("video", "video/quicktime", "mov");
add("video", "video/x-msvideo", "avi");
add("video", "video/x-matroska", "mkv");
add("video", "video/webm", "webm");
add("video", "video/x-ms-wmv", "wmv");
add("video", "video/mpeg", "mpg mpeg");
add("audio", "audio/mpeg", "mp3");
add("audio", "audio/wav", "wav");
add("audio", "audio/flac", "flac");
add("audio", "audio/aac", "aac m4a");
add("audio", "audio/ogg", "ogg oga opus");
add("audio", "audio/x-ms-wma", "wma");
add("audio", "audio/amr", "amr");
add("pdf", "application/pdf", "pdf");
add("doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx docm dotx");
add("doc", "application/msword", "doc dot");
add("doc", "application/rtf", "rtf");
add("doc", "application/vnd.oasis.opendocument.text", "odt");
add("sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx xlsm xltx");
add("sheet", "application/vnd.ms-excel", "xls");
add("sheet", "application/vnd.oasis.opendocument.spreadsheet", "ods");
add("sheet", "text/csv", "csv tsv");
add("slides", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx pptm ppsx");
add("slides", "application/vnd.ms-powerpoint", "ppt pps");
add("slides", "application/vnd.oasis.opendocument.presentation", "odp");
add("text", "text/plain", "txt text log md markdown ini cfg conf yaml yml toml");
add("text", "application/json", "json");
add("text", "application/xml", "xml");
add("text", "text/html", "html htm xhtml");
add("text", "text/plain", "js ts jsx tsx py java c cpp h hpp cs go rs rb php sh ps1 bat sql css scss");
add("archive", "application/zip", "zip");
add("archive", "application/x-7z-compressed", "7z");
add("archive", "application/vnd.rar", "rar");
add("archive", "application/gzip", "gz tgz");
add("archive", "application/x-tar", "tar");
add("app", "application/x-msdownload", "exe dll msi");
add("other", "application/octet-stream", "pbix");

export const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
};

export const kindFromExt = (ext: string): Sniffed => {
  const k = EXT_KIND[ext];
  return k ? { kind: k[0], mime: k[1], format: ext } : { kind: "other", mime: "application/octet-stream", format: ext || "bin" };
};

const starts = (b: Buffer, ...bytes: number[]) => bytes.every((v, i) => b[i] === v);
const ascii = (b: Buffer, at: number, s: string) => b.length >= at + s.length && b.toString("latin1", at, at + s.length) === s;

/** `head` is the start of the file; `whole` is the entire file when it fits in memory (needed for zip names). */
export function sniff(head: Buffer, ext: string, whole?: Buffer): Sniffed {
  const byExt = kindFromExt(ext);
  if (ascii(head, 0, "%PDF")) return { kind: "pdf", mime: "application/pdf", format: "pdf" };
  if (starts(head, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    // Legacy Office: the extension says which of doc/xls/ppt/msg it is.
    const k = byExt.kind === "sheet" || byExt.kind === "slides" || byExt.kind === "doc" ? byExt : kindFromExt("doc");
    return { ...k, format: ext === "xls" || ext === "ppt" || ext === "doc" ? ext : "ole" };
  }
  if (starts(head, 0x50, 0x4b, 0x03, 0x04)) {
    const zip = whole ? readZipDirectory(whole) ?? undefined : undefined;
    if (zip) {
      const has = (p: string) => zip.some((e) => e.name.startsWith(p));
      if (has("word/document.xml")) return { ...kindFromExt("docx"), format: "docx", zip };
      if (has("xl/workbook.xml")) return { ...kindFromExt("xlsx"), format: "xlsx", zip };
      if (has("ppt/presentation.xml")) return { ...kindFromExt("pptx"), format: "pptx", zip };
      const mimetype = zip.find((e) => e.name === "mimetype");
      if (mimetype && has("content.xml")) {
        const k = ext === "ods" ? "ods" : ext === "odp" ? "odp" : "odt";
        return { ...kindFromExt(k), format: k, zip };
      }
    }
    if (byExt.kind === "doc" || byExt.kind === "sheet" || byExt.kind === "slides") return { ...byExt, zip };
    return { kind: "archive", mime: "application/zip", format: "zip", zip };
  }
  if (starts(head, 0xff, 0xd8, 0xff)) return { kind: "image", mime: "image/jpeg", format: "jpeg" };
  if (starts(head, 0x89, 0x50, 0x4e, 0x47)) return { kind: "image", mime: "image/png", format: "png" };
  if (ascii(head, 0, "GIF8")) return { kind: "image", mime: "image/gif", format: "gif" };
  if (starts(head, 0x49, 0x49, 0x2a, 0x00) || starts(head, 0x4d, 0x4d, 0x00, 0x2a)) {
    return byExt.kind === "image" ? { ...byExt } : { kind: "image", mime: "image/tiff", format: "tiff" };
  }
  if (ascii(head, 0, "RIFF")) {
    if (ascii(head, 8, "WEBP")) return { kind: "image", mime: "image/webp", format: "webp" };
    if (ascii(head, 8, "WAVE")) return { kind: "audio", mime: "audio/wav", format: "wav" };
    if (ascii(head, 8, "AVI ")) return { kind: "video", mime: "video/x-msvideo", format: "avi" };
  }
  if (ascii(head, 4, "ftyp")) {
    const brand = head.toString("latin1", 8, 12);
    if (/^(heic|heix|hevc|mif1|msf1|heim|heis)$/.test(brand)) return { kind: "image", mime: "image/heic", format: "heic" };
    if (brand === "avif") return { kind: "image", mime: "image/avif", format: "avif" };
    if (/^(M4A |M4B )$/.test(brand)) return { kind: "audio", mime: "audio/aac", format: "m4a" };
    if (brand === "qt  ") return { kind: "video", mime: "video/quicktime", format: "mov" };
    return { kind: "video", mime: "video/mp4", format: "mp4" };
  }
  if (starts(head, 0x1a, 0x45, 0xdf, 0xa3)) return ext === "webm" ? kindFromExt("webm") : kindFromExt("mkv");
  if (ascii(head, 0, "ID3") || starts(head, 0xff, 0xfb) || starts(head, 0xff, 0xf3)) return kindFromExt("mp3");
  if (ascii(head, 0, "fLaC")) return kindFromExt("flac");
  if (ascii(head, 0, "OggS")) return kindFromExt("ogg");
  if (ascii(head, 0, "#!AMR")) return kindFromExt("amr");
  if (ascii(head, 0, "{\\rtf")) return { ...kindFromExt("rtf"), format: "rtf" };
  if (starts(head, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return kindFromExt("7z");
  if (ascii(head, 0, "Rar!")) return kindFromExt("rar");
  if (starts(head, 0x1f, 0x8b)) return kindFromExt("gz");
  if (ascii(head, 0, "MZ")) return kindFromExt(ext === "dll" || ext === "msi" ? ext : "exe");
  if (byExt.kind !== "other") return byExt;
  // No signature and an unknown extension: text if the head has no NUL bytes.
  return head.subarray(0, 4096).includes(0) ? byExt : { kind: "text", mime: "text/plain", format: "txt" };
}
