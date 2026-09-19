// Where a file belongs in the library, and what it should be called.
// Ordered, deterministic, first match wins. Every plan records the rule id that
// produced it, which is the answer to "why is this file here?".
import { dateFromName } from "../analyze/dates.ts";
import { detectDocType, DOC_TYPE_LABEL, type DocType } from "../analyze/dtype.ts";
import { kindFromExt, type Kind } from "../analyze/sniff.ts";
import { dateParts, isGenericStem, joinName, safeSegment, splitName } from "./names.ts";

export interface PlanInput {
  path: string;            // relative path under its root ('/' separated)
  kind: Kind | "";         // from content analysis; '' when never analyzed (cloud placeholder)
  dtype: string | null;
  title: string | null;
  titleShared: boolean;    // the embedded title is template boilerplate (shared by many files)
  heading: string | null;
  quality: string | null;
  ddate: number | null;    // document/capture date from metadata
  dsrc: string | null;
  camera: string | null;
  mtime: number;
  ctime: number;
}

export interface Plan { folder: string; name: string; rule: string }

const TYPE_SINGULAR: Record<DocType, string> = {
  invoice: "Invoice", receipt: "Receipt", contract: "Contract", statement: "Bank statement", payslip: "Payslip",
  letter: "Letter", cv: "CV", certificate: "Certificate", report: "Report", minutes: "Minutes", medical: "Medical",
  tax: "Tax", identity: "Identity document", registration: "Registration form", quote: "Quote", order: "Order",
  insurance: "Insurance",
};

const SCREENSHOT = /^(screenshot|screen shot|capture d['’]?\s?[ée]cran|scr[_-]|screenshot_)/i;
const MESSAGING = /(whatsapp (image|video|audio)|^(img|vid|aud|ptt)-\d{8}-wa\d+|^signal-\d{4}|^telegram)/i;
const VOICE = /(whatsapp audio|^(ptt|aud)-\d{8}|^voice|^recording|^enregistrement)/i;
const CODE_EXT = new Set("js ts jsx tsx py java c cpp h hpp cs go rs rb php sh ps1 bat sql css scss json xml yaml yml toml ini cfg conf log".split(" "));

export function plan(f: PlanInput): Plan {
  const name = f.path.slice(f.path.lastIndexOf("/") + 1);
  const [stem, ext] = splitName(name);
  const kind: Kind = f.kind || kindFromExt(ext.toLowerCase()).kind;

  // The date that decides folders: metadata, then the name, then the earliest filesystem time.
  const fromName = dateFromName(name);
  const meta = f.ddate != null ? { t: f.ddate, wall: f.dsrc?.startsWith("exif") ?? false, hasTime: true } : null;
  const nameD = fromName ? { t: fromName.t, wall: true, hasTime: fromName.hasTime } : null;
  const fsT = f.ctime > 0 ? Math.min(f.mtime, f.ctime) : f.mtime;
  const best = meta ?? nameD ?? { t: fsT, wall: false, hasTime: false };
  const d = dateParts(best.t, best.wall);
  const keep = joinName(stem, ext);

  // A photo of a document IS that document: an invoice photographed on a phone belongs with
  // the invoices. Only when OCR read it well enough to recognize a type; screenshots stay screenshots.
  if (kind === "image" && f.dtype && !SCREENSHOT.test(name)) {
    const typ = f.dtype as DocType;
    return { folder: `Documents/${DOC_TYPE_LABEL[typ]}/${d.year}`, name: isGenericStem(stem) ? joinName(`${d.day} ${TYPE_SINGULAR[typ]}`, ext) : keep, rule: `doc-${typ}-photo` };
  }

  if (kind === "image" || kind === "video") {
    const shot = meta?.wall ? meta : nameD?.hasTime ? nameD : null; // a real capture time
    const stamp = shot ? dateParts(shot.t, true).stamp : null;
    if (kind === "image" && SCREENSHOT.test(name)) {
      return { folder: `Screenshots/${d.year}`, name: stamp ? joinName(`Screenshot ${stamp}`, ext) : keep, rule: "screenshot" };
    }
    const top = kind === "image" ? "Photos" : "Videos";
    if (MESSAGING.test(name)) {
      return { folder: `${top}/${d.year}/${d.month}`, name: stamp && isGenericStem(stem) ? joinName(`${stamp} WhatsApp`, ext) : keep, rule: `${top.toLowerCase()}-messaging` };
    }
    if (f.camera || meta?.wall || kind === "video") {
      return { folder: `${top}/${d.year}/${d.month}`, name: stamp && isGenericStem(stem) ? joinName(stamp, ext) : keep, rule: `${top.toLowerCase()}-camera` };
    }
    return { folder: `Images/${d.year}`, name: keep, rule: "images-other" };
  }

  if (kind === "audio") {
    if (VOICE.test(name) || ext.toLowerCase() === "opus" || ext.toLowerCase() === "amr") {
      return { folder: `Audio/Voice notes/${d.year}`, name: keep, rule: "audio-voice" };
    }
    return { folder: `Audio/${d.year}`, name: keep, rule: "audio" };
  }

  if (kind === "pdf" || kind === "doc" || kind === "sheet" || kind === "slides" || kind === "text") {
    if (kind === "text" && CODE_EXT.has(ext.toLowerCase())) return { folder: `Other/Code and data`, name: keep, rule: "code" };
    // The filename a person chose is strong evidence of type too ("Facture EDF mars.pdf").
    const typ = (f.dtype as DocType | null) ?? detectDocType(stem.replace(/[_-]+/g, " "), "", "")?.type ?? null;
    const title = f.title && !f.titleShared ? f.title : null;
    const docName = () => {
      if (!isGenericStem(stem)) return keep;
      if (title) return joinName(`${d.day} ${title}`, ext);
      if (typ) return joinName(`${d.day} ${TYPE_SINGULAR[typ]}`, ext);
      if (f.heading) return joinName(`${d.day} ${f.heading}`, ext);
      return keep;
    };
    if (typ) return { folder: `Documents/${DOC_TYPE_LABEL[typ]}/${d.year}`, name: docName(), rule: `doc-${typ}` };
    if (kind === "pdf" && f.quality && f.quality !== "ok") return { folder: `Documents/Scans/${d.year}`, name: docName(), rule: "doc-scan" };
    if (kind === "sheet") return { folder: `Spreadsheets/${d.year}`, name: docName(), rule: "sheet" };
    if (kind === "slides") return { folder: `Presentations/${d.year}`, name: docName(), rule: "slides" };
    if (kind === "text") return { folder: `Documents/Notes/${d.year}`, name: docName(), rule: "notes" };
    return { folder: `Documents/${d.year}`, name: docName(), rule: "doc" };
  }

  if (kind === "archive") return { folder: `Archives/${d.year}`, name: keep, rule: "archive" };
  if (kind === "app") return { folder: "Software", name: keep, rule: "software" };
  return { folder: ext ? `Other/${safeSegment(ext.toLowerCase())}` : "Other", name: keep, rule: "other" };
}
