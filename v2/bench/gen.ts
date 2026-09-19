// Synthetic scaling corpus: deterministic, multilingual, duplicate-heavy.
// This measures THROUGHPUT and correctness of the machinery; representative
// quality (OCR, real photos, real scans) comes from the real corpus.
//
// Usage: node bench/gen.ts --out <dir> --files 5000 [--dup 0.2] [--large 3] [--large-mb 200] [--seed 1]
// Default output is ~/AtlasBench/corpus-small: never inside the repo, which may be OneDrive-synced.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = path.resolve(opt("out", path.join(os.homedir(), "AtlasBench", "corpus-small")));
const N = Number(opt("files", "5000"));
const DUP = Number(opt("dup", "0.2"));
const LARGE = Number(opt("large", "3"));
const LARGE_MB = Number(opt("large-mb", "200"));
let seed = Number(opt("seed", "1"));

// mulberry32: a proper 32-bit PRNG. (A plain LCG in doubles loses precision past 2^53 and cycles.)
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const EN = "the report invoice customer payment account meeting project budget contract agreement schedule delivery quarterly annual review summary office team manager client service total amount due date number".split(" ");
const FR = "le rapport facture client paiement compte réunion projet budget contrat accord calendrier livraison trimestriel annuel synthèse bureau équipe responsable service montant total échéance numéro élève école".split(" ");
const AR = "التقرير فاتورة العميل الدفع الحساب الاجتماع المشروع الميزانية العقد الاتفاقية الجدول التسليم السنوي المراجعة الملخص المكتب الفريق المدير الخدمة المبلغ الإجمالي تاريخ الاستحقاق رقم المدرسة".split(" ");
const HEAD: Record<string, string[]> = {
  en: ["INVOICE No. 2023-0417", "Dear Sir or Madam,", "Service Agreement between the parties", "Quarterly Report Q3 2024", "Meeting minutes of the meeting"],
  fr: ["FACTURE N° 2023-0417", "Madame, Monsieur,", "Contrat de prestation entre les parties", "Rapport trimestriel", "Procès-verbal de la réunion"],
  ar: ["فاتورة رقم ٢٠٢٣-٠٤١٧", "تحية طيبة وبعد،", "عقد خدمات بين الطرف الأول والطرف الثاني", "التقرير الربعي", "محضر اجتماع"],
};
const NAMES: Record<string, string[]> = {
  en: ["Invoice", "Report", "Contract", "Minutes", "Budget", "Notes", "Letter"],
  fr: ["Facture", "Rapport", "Contrat", "Compte rendu", "Budget", "Notes", "Lettre à l'école"],
  ar: ["فاتورة", "تقرير", "عقد", "محضر", "ميزانية", "ملاحظات", "رسالة"],
};
const GENERIC = ["scan0001", "Document1", "New Document", "IMG_20240712_153012", "untitled", "WhatsApp Image 2026-07-29 at 20.17.33"];

function sentence(lang: string) {
  const w = lang === "en" ? EN : lang === "fr" ? FR : AR;
  return Array.from({ length: int(6, 14) }, () => pick(w)).join(" ") + (lang === "ar" ? "." : ".");
}
function body(lang: string, paras: number) {
  return [pick(HEAD[lang]), ...Array.from({ length: paras }, () => Array.from({ length: int(2, 6) }, () => sentence(lang)).join(" "))].join("\n");
}

// --- minimal zip writer (deflate), enough for a valid .docx ---
function crc32(b: Buffer) { return zlib.crc32(b); }
function zip(entries: [string, string][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content, "utf8");
    const comp = zlib.deflateRawSync(data);
    const nameB = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc >>> 0, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameB.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(local, nameB, comp);
    central.push(cen, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function docx(title: string, text: string): Buffer {
  const paras = text.split("\n").map((p) => `<w:p><w:r><w:t xml:space="preserve">${xml(p)}</w:t></w:r></w:p>`).join("");
  return zip([
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`],
    ["word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`],
    ["docProps/core.xml", `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y" xmlns:dcterms="z"><dc:title>${xml(title)}</dc:title><dcterms:created>2023-0${int(1, 9)}-1${int(0, 9)}T10:00:00Z</dcterms:created></cp:coreProperties>`],
  ]);
}

// --- minimal valid PNG (grayscale), a stand-in for screenshots ---
function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w + 1) * h);
  const salt = Math.floor(rnd() * 256);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = (x * y + salt + (y << 3)) & 0xff;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const DIRS = ["Admin", "Clients/Acme", "Clients/ÉcoleSaint-Joseph", "Finance/2023", "Finance/2024", "المالية/الفواتير", "Projets/Été 2024", "Photos/Vacances", "Downloads", "Desktop/stuff/old", "Scans", "Archive/2019/misc"];
const made: string[] = [];
let bytes = 0;
function write(rel: string, data: Buffer | string) {
  const abs = path.join(out, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  const t = new Date(Date.UTC(2019 + int(0, 6), int(0, 11), int(1, 28), int(7, 20)));
  fs.utimesSync(abs, t, t);
  made.push(rel);
  bytes += typeof data === "string" ? Buffer.byteLength(data) : data.length;
}

fs.rmSync(out, { recursive: true, force: true });
const t0 = performance.now();
const unique = Math.round(N * (1 - DUP));
for (let i = 0; i < unique; i++) {
  const lang = pick(["en", "en", "ar", "ar", "fr"]);
  const dir = pick(DIRS) + (rnd() < 0.3 ? `/${pick(["a", "b", "c", "d"])}${int(1, 9)}` : "");
  const generic = rnd() < 0.3;
  const base = generic ? `${pick(GENERIC)} ${i}` : `${pick(NAMES[lang])} ${2019 + int(0, 6)}-${String(int(1, 12)).padStart(2, "0")} ${i}`;
  const r = rnd();
  if (r < 0.45) write(`${dir}/${base}.txt`, body(lang, int(1, 8)));
  else if (r < 0.70) write(`${dir}/${base}.docx`, docx(rnd() < 0.5 ? pick(HEAD[lang]) : "Document1", body(lang, int(2, 12))));
  else if (r < 0.80) write(`${dir}/${base}.csv`, Array.from({ length: int(5, 200) }, (_, k) => `${k},${pick(EN)},${int(1, 9999)},${pick(FR)}`).join("\n"));
  else if (r < 0.92) write(`${dir}/Screenshot 202${int(3, 6)}-0${int(1, 9)}-1${int(0, 9)} 1${int(0, 9)}${int(10, 59)}${int(10, 59)} ${i}.png`, png(int(64, 320), int(64, 240)));
  else write(`${dir}/${base}.bin`, crypto.randomBytes(int(1, 512) * 1024));
}
// Exact duplicates: same bytes, other folder, often another name.
const originals = [...made];
for (let i = 0; i < N - unique; i++) {
  const src = pick(originals);
  const data = fs.readFileSync(path.join(out, src));
  const name = path.basename(src);
  const renamed = rnd() < 0.5 ? name.replace(/(\.[^.]+)$/, " (1)$1") : rnd() < 0.5 ? `Copy of ${name}` : name;
  write(`${pick(DIRS)}/dup${i}/${renamed}`, data);
}
// Near-duplicates: one extra line. Different bytes, so NOT duplicates.
for (let i = 0; i < Math.round(N * 0.02); i++) {
  const src = pick(originals.filter((p) => p.endsWith(".txt")));
  write(`Near/${i}/${path.basename(src)}`, fs.readFileSync(path.join(out, src), "utf8") + "\nEdited.");
}
// Large files, streamed in 8 MB blocks.
for (let i = 0; i < LARGE; i++) {
  const rel = `Videos/big-${i}.mp4`;
  const abs = path.join(out, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const fd = fs.openSync(abs, "w");
  const block = crypto.randomBytes(8 * 1024 * 1024);
  for (let mb = 0; mb < LARGE_MB; mb += 8) fs.writeSync(fd, block);
  fs.closeSync(fd);
  made.push(rel);
  bytes += LARGE_MB * 1024 * 1024;
}
console.log(JSON.stringify({ out, files: made.length, unique, exactDuplicates: N - unique, bytesMB: Math.round(bytes / 1048576), seconds: +((performance.now() - t0) / 1000).toFixed(1) }));
