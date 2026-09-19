import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sniff } from "../src/analyze/sniff.ts";
import { analyze } from "../src/analyze/analyze.ts";
import { decodeText, htmlToText, rtfToText } from "../src/analyze/decode.ts";
import { assessText } from "../src/analyze/quality.ts";
import { dimensions } from "../src/analyze/image.ts";
import { docx, zip } from "./_zip.ts";

const fixture = (n: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", n));

test("sniffing trusts bytes over extensions", () => {
  assert.equal(sniff(Buffer.from("%PDF-1.7\n"), "txt").kind, "pdf");
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "pdf").format, "jpeg");
  assert.equal(sniff(Buffer.from("....ftypheic"), "jpg").format, "heic");
  assert.equal(sniff(Buffer.from("RIFF....WEBPVP8 "), "").format, "webp");
  const d = docx("t", ["x"]);
  assert.equal(sniff(d, "zip", d).format, "docx", "an Office zip is recognized from its entries");
  assert.equal(sniff(Buffer.from("hello world"), "unknownext").kind, "text");
  assert.equal(sniff(Buffer.from([0, 1, 2, 3]), "unknownext").kind, "other");
});

test("the ported legacy-Office parser reads V1's real .doc and .xls fixtures", async () => {
  const doc = await analyze(fixture("sample.doc"), fixture("sample.doc").subarray(0, 65536), "doc", 0, 1e6);
  assert.equal(doc.kind, "doc");
  assert.match(doc.text, /Legacy Extraction Test Document/);
  assert.match(doc.text, /Final paragraph after the table/);
  const xls = await analyze(fixture("sample.xls"), fixture("sample.xls").subarray(0, 65536), "xls", 0, 1e6);
  assert.equal(xls.kind, "sheet");
  assert.ok(xls.text.length > 20);
});

test("docx: text, embedded title and creation date; French detected; type from keywords", async () => {
  const buf = docx("Rapport annuel 2023", ["Rapport annuel de l'école", "Le rapport présente les résultats et la synthèse des activités de l'année pour les élèves et les familles."]);
  const a = await analyze(buf, buf.subarray(0, 65536), "docx", buf.length, 1e6);
  assert.equal(a.kind, "doc");
  assert.equal(a.title, "Rapport annuel 2023");
  assert.equal(a.ddate, Date.parse("2023-02-19T10:00:00Z"));
  assert.equal(a.dsrc, "embedded");
  assert.equal(a.lang, "fr");
  assert.equal(a.dtype, "report");
  assert.equal(a.quality, "ok");
});

test("zip entries are inflated on demand and bounded (zip bomb guard)", async () => {
  const bomb = zip([["word/document.xml", "<w:t>" + "A".repeat(70 * 1024 * 1024) + "</w:t>"]]);
  const a = await analyze(bomb, bomb.subarray(0, 65536), "docx", bomb.length, 1e6);
  assert.equal(a.text, "", "an entry over 64 MB uncompressed is not inflated");
});

test("plain text: UTF-8, UTF-16 and windows-1256 Arabic", () => {
  assert.equal(decodeText(Buffer.from("مرحبا", "utf8")), "مرحبا");
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo", "utf16le")])), "héllo");
  // "مرحبا" in windows-1256
  assert.equal(decodeText(Buffer.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7])), "مرحبا");
});

test("markup: HTML scripts dropped, RTF control words stripped with its code page", () => {
  const h = htmlToText("<html><title>T</title><script>alert(1)</script><p>Hello &amp; bye</p></html>");
  assert.equal(h.title, "T");
  assert.equal(h.text, "T Hello & bye");
  assert.equal(rtfToText("{\\rtf1\\ansi\\ansicpg1256 {\\fonttbl{\\f0 Arial;}} \\'e3\\'d1\\'cd\\'c8\\'c7\\par}"), "مرحبا");
});

test("text quality: scans and encoding garbage are not text", () => {
  assert.equal(assessText("", 1000), "empty");
  assert.equal(assessText("abc", 5_000_000), "no_text_layer");
  assert.equal(assessText("x y z q w e r t", 100), "gibberish");
  assert.equal(assessText("This is a perfectly ordinary sentence with enough words.", 100), "ok");
  assert.equal(assessText("هذا نص عربي عادي فيه كلمات كافية للقراءة", 100), "ok");
});

test("image dimensions straight from headers", () => {
  const png = Buffer.alloc(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.writeUInt32BE(1920, 16);
  png.writeUInt32BE(1080, 20);
  assert.deepEqual(dimensions(png), [1920, 1080]);
});
