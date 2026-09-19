// Text and properties from zipped Office formats (docx/xlsx/pptx, odt/ods/odp).
// Regex over the XML: these files are machine-written and regular, and a DOM
// parser would cost 10x the time and memory for the same text.
import { readZipEntry, type ZipEntry } from "./zip.ts";
import { decodeEntities } from "./decode.ts";

export interface OfficeResult { text: string; title: string | null; created: string | null; modified: string | null; pages: number | null }

const entry = (buf: Buffer, zip: ZipEntry[], name: string) => {
  const e = zip.find((z) => z.name === name);
  return e ? readZipEntry(buf, e)?.toString("utf8") ?? null : null;
};

const tag = (xml: string | null, name: string) => {
  if (!xml) return null;
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeEntities(m[1]).trim() || null : null;
};

function runs(xml: string, paraClose: RegExp, textTag: RegExp): string {
  const out: string[] = [];
  for (const para of xml.split(paraClose)) {
    let line = "";
    for (const m of para.matchAll(textTag)) line += m[1];
    if (line.trim()) out.push(decodeEntities(line));
  }
  return out.join("\n");
}

export function officeText(buf: Buffer, format: string, zip: ZipEntry[], maxChars: number): OfficeResult {
  let text = "";
  let title: string | null = null, created: string | null = null, modified: string | null = null, pages: number | null = null;
  if (format === "docx" || format === "xlsx" || format === "pptx") {
    const core = entry(buf, zip, "docProps/core.xml");
    title = tag(core, "dc:title");
    created = tag(core, "dcterms:created");
    modified = tag(core, "dcterms:modified");
  }
  if (format === "docx") {
    const xml = entry(buf, zip, "word/document.xml") ?? "";
    text = runs(xml, /<\/w:p>/, /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g);
    const app = entry(buf, zip, "docProps/app.xml");
    const p = tag(app, "Pages");
    pages = p ? Number(p) || null : null;
  } else if (format === "pptx") {
    const slides = zip
      .filter((z) => /^ppt\/slides\/slide\d+\.xml$/.test(z.name))
      .sort((a, b) => Number(a.name.match(/\d+/)![0]) - Number(b.name.match(/\d+/)![0]));
    pages = slides.length;
    const parts: string[] = [];
    for (const s of slides) {
      const xml = readZipEntry(buf, s)?.toString("utf8") ?? "";
      parts.push(runs(xml, /<\/a:p>/, /<a:t>([^<]*)<\/a:t>/g));
      if (parts.join("\n").length > maxChars) break;
    }
    text = parts.filter(Boolean).join("\n\n");
  } else if (format === "xlsx") {
    const shared = entry(buf, zip, "xl/sharedStrings.xml") ?? "";
    const strings: string[] = [];
    for (const si of shared.split("</si>")) {
      let s = "";
      for (const m of si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) s += m[1];
      if (s.trim()) strings.push(decodeEntities(s));
    }
    // Inline strings live in the sheets themselves.
    for (const sheet of zip.filter((z) => /^xl\/worksheets\/sheet\d+\.xml$/.test(z.name))) {
      if (strings.join("\n").length > maxChars) break;
      const xml = readZipEntry(buf, sheet)?.toString("utf8") ?? "";
      for (const m of xml.matchAll(/<is>[\s\S]*?<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) if (m[1].trim()) strings.push(decodeEntities(m[1]));
    }
    text = strings.join("\n");
  } else if (format === "odt" || format === "ods" || format === "odp") {
    const content = entry(buf, zip, "content.xml") ?? "";
    text = decodeEntities(content.replace(/<\/text:(p|h)>/g, "\n").replace(/<text:(tab|s)\/>/g, " ").replace(/<[^>]+>/g, ""))
      .replace(/\n\s*\n+/g, "\n").trim();
    const meta = entry(buf, zip, "meta.xml");
    title = tag(meta, "dc:title");
    created = tag(meta, "meta:creation-date");
    modified = tag(meta, "dc:date");
  }
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, title, created, modified, pages };
}
