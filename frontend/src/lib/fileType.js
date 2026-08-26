/**
 * What KIND of file this is, for the eye rather than for the pipeline.
 *
 * WHY THIS EXISTS
 *
 * Every row in the Library drew the same grey document glyph, so a contract, a
 * spreadsheet, a photograph and a video were visually identical and the only
 * way to tell them apart was to read the extension at the end of a truncated
 * filename. That is fine for twenty files and useless for ten thousand: at
 * scale the eye navigates a long list by shape and colour long before it reads
 * any words, and a list with one shape offers it nothing to work with.
 *
 * So a type here is a VISUAL category, not a MIME type. `.docx` and `.pages`
 * are one thing to a person scanning for "the written documents", however
 * different they are to an extractor. The pipeline's own notion of format
 * lives in backend/src/services/extraction and is deliberately finer-grained;
 * this is the coarse version, and the two are not meant to converge.
 *
 * COLOUR IS THE SECOND SIGNAL, NEVER THE ONLY ONE
 *
 * Each category pairs a distinct glyph with a distinct tint. The glyph carries
 * the meaning on its own, so the tint is reinforcement -- which is what keeps
 * the list readable for anyone who cannot separate the hues, and is the same
 * rule the dashboard charts follow.
 */
import {
  FileText, FileSpreadsheet, Presentation, Image, Film, Music,
  Archive, Code, Mail, FileType2, File,
} from "lucide-react";

/**
 * Tints are the -600 ink on a -50 fill, so a tile reads as a quiet coloured
 * chip on white rather than a saturated block. At row height these are small;
 * anything stronger turns a file list into confetti.
 */
const TYPES = {
  pdf:         { label: "PDF",          icon: FileType2,        fg: "text-rose-600",    bg: "bg-rose-50",    ring: "ring-rose-100" },
  document:    { label: "Document",     icon: FileText,         fg: "text-blue-600",    bg: "bg-blue-50",    ring: "ring-blue-100" },
  spreadsheet: { label: "Spreadsheet",  icon: FileSpreadsheet,  fg: "text-emerald-600", bg: "bg-emerald-50", ring: "ring-emerald-100" },
  presentation:{ label: "Presentation", icon: Presentation,     fg: "text-amber-600",   bg: "bg-amber-50",   ring: "ring-amber-100" },
  image:       { label: "Image",        icon: Image,            fg: "text-violet-600",  bg: "bg-violet-50",  ring: "ring-violet-100" },
  video:       { label: "Video",        icon: Film,             fg: "text-fuchsia-600", bg: "bg-fuchsia-50", ring: "ring-fuchsia-100" },
  audio:       { label: "Audio",        icon: Music,            fg: "text-cyan-600",    bg: "bg-cyan-50",    ring: "ring-cyan-100" },
  archive:     { label: "Archive",      icon: Archive,          fg: "text-orange-600",  bg: "bg-orange-50",  ring: "ring-orange-100" },
  code:        { label: "Code",         icon: Code,             fg: "text-slate-600",   bg: "bg-slate-100",  ring: "ring-slate-200" },
  email:       { label: "Email",        icon: Mail,             fg: "text-sky-600",     bg: "bg-sky-50",     ring: "ring-sky-100" },
  other:       { label: "File",         icon: File,             fg: "text-base-500",    bg: "bg-base-850",   ring: "ring-base-800" },
};

const BY_EXTENSION = {
  pdf: "pdf",

  doc: "document", docx: "document", odt: "document", rtf: "document",
  txt: "document", md: "document", pages: "document", tex: "document",

  xls: "spreadsheet", xlsx: "spreadsheet", xlsm: "spreadsheet", ods: "spreadsheet",
  csv: "spreadsheet", tsv: "spreadsheet", numbers: "spreadsheet", pbix: "spreadsheet",

  ppt: "presentation", pptx: "presentation", odp: "presentation", key: "presentation",

  jpg: "image", jpeg: "image", png: "image", gif: "image", bmp: "image", tif: "image",
  tiff: "image", webp: "image", heic: "image", heif: "image", svg: "image", avif: "image",

  mp4: "video", mov: "video", avi: "video", mkv: "video", webm: "video", wmv: "video", m4v: "video",

  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio", aac: "audio", ogg: "audio", wma: "audio",

  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive", bz2: "archive",

  js: "code", jsx: "code", ts: "code", tsx: "code", py: "code", java: "code", c: "code",
  cpp: "code", cs: "code", rb: "code", go: "code", rs: "code", php: "code", sh: "code",
  html: "code", css: "code", json: "code", xml: "code", yml: "code", yaml: "code", sql: "code",

  eml: "email", msg: "email", mbox: "email",
};

/** The extension, lowercased and without its dot, or "" when there isn't one. */
export function extensionOf(file) {
  const raw = file?.extension || "";
  if (raw) return String(raw).replace(/^\./, "").toLowerCase();
  // Search results return the raw row, which may carry no `extension` column,
  // so fall back to reading it off whichever name is present.
  const name = file?.filename_current || file?.display_name || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * @param {object} file a `files` row (or a search result shaped like one)
 * @returns {{key: string, label: string, icon: Function, fg: string, bg: string, ring: string, ext: string}}
 */
export function fileTypeOf(file) {
  const ext = extensionOf(file);
  // `is_image` is the pipeline's own judgement and beats the extension: it is
  // set by content sniffing, which is right about a .jpg that is really a PNG.
  const key = file?.is_image && !BY_EXTENSION[ext] ? "image" : (BY_EXTENSION[ext] || "other");
  return { key, ext, ...TYPES[key] };
}

/** Grouping label for a "group by type" affordance, and for filter chips. */
export function typeLabel(file) {
  return fileTypeOf(file).label;
}

export const FILE_TYPES = TYPES;
