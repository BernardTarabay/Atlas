import { test } from "node:test";
import assert from "node:assert/strict";
import { dateFromName, parsePdfDate, parseExifDate } from "../src/analyze/dates.ts";
import { safeSegment, joinName, isGenericStem } from "../src/plan/names.ts";
import { plan, type PlanInput } from "../src/plan/rules.ts";
import { detectDocType } from "../src/analyze/dtype.ts";
import { usableTitle, looksLikeMojibake } from "../src/analyze/title.ts";

const at = (s: string) => Date.parse(s + "Z");

test("dates in camera, messaging, scanner and European filenames", () => {
  assert.deepEqual(dateFromName("WhatsApp Image 2026-07-29 at 20.17.33.jpeg"), { t: at("2026-07-29T20:17:33"), hasTime: true });
  assert.deepEqual(dateFromName("Screenshot 2026-04-26 211704.png"), { t: at("2026-04-26T21:17:04"), hasTime: true });
  assert.deepEqual(dateFromName("IMG_20240712_153012.jpg"), { t: at("2024-07-12T15:30:12"), hasTime: true });
  assert.deepEqual(dateFromName("PXL_20240712_153012123.jpg"), { t: at("2024-07-12T15:30:12"), hasTime: true });
  assert.deepEqual(dateFromName("IMG-20240712-WA0001.jpg"), { t: at("2024-07-12T00:00:00"), hasTime: false });
  assert.deepEqual(dateFromName("Facture 12.07.2024.pdf"), { t: at("2024-07-12T00:00:00"), hasTime: false });
  assert.deepEqual(dateFromName("فاتورة ٢٠٢٣-٠٤-١٧.pdf"), { t: at("2023-04-17T00:00:00"), hasTime: false });
  assert.equal(dateFromName("Report v2 final.docx"), null);
  assert.equal(dateFromName("invoice 2024-13-45.pdf"), null, "impossible dates are rejected");
});

test("metadata date parsers", () => {
  assert.equal(parsePdfDate("D:20230415101500+02'00'"), Date.parse("2023-04-15T10:15:00+02:00"));
  assert.equal(parseExifDate("2024:07:12 15:30:12"), at("2024-07-12T15:30:12"));
  assert.equal(parseExifDate("0000:00:00 00:00:00"), null);
});

test("Windows-safe names", () => {
  assert.equal(safeSegment('a<b>c:"d|e?f*'), "a b c d e f");
  assert.equal(safeSegment("CON"), "_CON");
  assert.equal(safeSegment("nul.txt"), "_nul.txt");
  assert.equal(safeSegment("trailing dots..."), "trailing dots");
  assert.equal(safeSegment("‮gpj.exe"), "gpj.exe", "directional overrides cannot disguise an extension");
  assert.equal(joinName("x".repeat(300), "PDF").length, 120);
  assert.ok(joinName("x".repeat(300), "PDF").endsWith(".pdf"));
});

test("generic names are replaceable; names a person chose are kept", () => {
  for (const g of ["IMG_1234", "DSC01234", "scan0001", "Document1", "New Microsoft Word Document", "WhatsApp Image 2026-07-29 at 20.17.33",
    "Screenshot 2026-04-26 211704", "Capture d’écran 2026-04-26 211704", "IMG-20240712-WA0001", "untitled (2)", "20240712_153012", "a1"]) {
    assert.equal(isGenericStem(g), true, g);
  }
  for (const m of ["Facture EDF mars 2024", "photo de famille", "Budget 2024", "عقد الإيجار", "Lettre à l'école"]) {
    assert.equal(isGenericStem(m), false, m);
  }
});

const base: PlanInput = { path: "x", kind: "", dtype: null, title: null, titleShared: false, heading: null, quality: null, ddate: null, dsrc: null, camera: null, mtime: at("2021-03-04T10:00:00"), ctime: 0 };

test("rules: photos get dated folders and a timestamp name only when the old name is generic", () => {
  const p = plan({ ...base, path: "DCIM/IMG_1234.JPG", kind: "image", ddate: at("2024-07-12T15:30:12"), dsrc: "exif", camera: "Apple iPhone 13" });
  assert.deepEqual(p, { folder: "Photos/2024/2024-07", name: "2024-07-12 15.30.12.jpg", rule: "photos-camera" });
  const kept = plan({ ...base, path: "Holidays/Beach with Sara.jpg", kind: "image", ddate: at("2024-07-12T15:30:12"), dsrc: "exif", camera: "Canon" });
  assert.equal(kept.name, "Beach with Sara.jpg");
});

test("rules: WhatsApp and screenshots are recognized from their names", () => {
  assert.deepEqual(plan({ ...base, path: "WhatsApp Image 2026-07-29 at 20.17.33.jpeg", kind: "image" }),
    { folder: "Photos/2026/2026-07", name: "2026-07-29 20.17.33 WhatsApp.jpeg", rule: "photos-messaging" });
  assert.equal(plan({ ...base, path: "Screenshot 2026-04-26 211704.png", kind: "image" }).folder, "Screenshots/2026");
});

test("rules: documents by detected type; generic names replaced, real names kept", () => {
  const inv = plan({ ...base, path: "scans/scan0001.pdf", kind: "pdf", dtype: "invoice", quality: "ok", ddate: at("2023-04-15T00:00:00"), dsrc: "pdf" });
  assert.deepEqual(inv, { folder: "Documents/Invoices/2023", name: "2023-04-15 Invoice.pdf", rule: "doc-invoice" });
  const named = plan({ ...base, path: "Facture EDF mars.pdf", kind: "pdf", quality: "ok" });
  assert.equal(named.folder, "Documents/Invoices/2021", "type from the filename a person chose");
  assert.equal(named.name, "Facture EDF mars.pdf");
  const titled = plan({ ...base, path: "Document1.docx", kind: "doc", title: "Annual Budget Review", quality: "ok" });
  assert.equal(titled.name, "2021-03-04 Annual Budget Review.docx");
  const boiler = plan({ ...base, path: "Document1.docx", kind: "doc", title: "Acme Corporation", titleShared: true, quality: "ok" });
  assert.equal(boiler.name, "Document1.docx", "template boilerplate titles are not names");
});

test("rules: scans without a text layer, sheets, code, voice notes, unknowns", () => {
  assert.equal(plan({ ...base, path: "doc.pdf", kind: "pdf", quality: "no_text_layer" }).rule, "doc-scan");
  assert.equal(plan({ ...base, path: "data.xlsx", kind: "sheet", quality: "ok" }).folder, "Spreadsheets/2021");
  assert.equal(plan({ ...base, path: "app.py", kind: "text" }).rule, "code");
  assert.equal(plan({ ...base, path: "PTT-20240101-WA0003.opus", kind: "audio" }).rule, "audio-voice");
  assert.equal(plan({ ...base, path: "thing.xyz" }).folder, "Other/xyz");
  assert.equal(plan({ ...base, path: "Setup.exe", kind: "app" }).folder, "Software");
});

test("document type detection in three languages; one weak body word is not enough", () => {
  assert.equal(detectDocType("FACTURE N° 2023-0417", "")?.type, "invoice");
  assert.equal(detectDocType("فاتورة ضريبية", "")?.type, "invoice");
  assert.equal(detectDocType("", "This agreement is made between the parties hereinafter referred to")?.type, "contract");
  assert.equal(detectDocType("Holiday notes", "we saw a report on the news")?.type ?? null, null);
});

test("title vetting rejects template defaults and mojibake", () => {
  assert.equal(usableTitle("Document1"), null);
  assert.equal(usableTitle("Microsoft Word - draft.doc"), null);
  assert.equal(usableTitle("Ã©tÃ© 2024"), null);
  assert.equal(looksLikeMojibake("Ã©tÃ©"), true);
  assert.equal(usableTitle("Conférences des Carmélites"), "Conférences des Carmélites");
});
