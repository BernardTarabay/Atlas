import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleLines, type Item } from "../src/analyze/pdf.ts";
import { visualToLogicalLine } from "../src/ocr/bidi.ts";

/** Lay out items left to right on one baseline, like a PDF would, from a list of [text, rtl, width]. */
function lineOf(parts: [string, boolean, number?][], y = 700, h = 14): Item[] {
  let x = 100;
  return parts.map(([s, rtl, w]) => {
    const width = w ?? 6 * [...s].length;
    const it = { s, x, y, w: width, h, rtl };
    x += width;
    return it;
  });
}

test("PDF: one glyph per item in visual order becomes the Arabic words in reading order", () => {
  // "مدرسة مار" drawn left to right: ر ا م [space] ة س ر د م
  const items = lineOf([["ر", true], ["ا", true], ["م", true], [" ", false, 4], ["ة", true], ["س", true], ["ر", true], ["د", true], ["م", true]]);
  assert.deepEqual(assembleLines(items), ["مدرسة مار"]);
});

test("PDF: a hyphenated number inside Arabic is restored (bidi splits it into two runs)", () => {
  const items = lineOf([["0762-2020", false, 60], [" ", false, 4], ["م", true], ["ق", true], ["ر", true]]);
  assert.deepEqual(assembleLines(items), ["رقم 2020-0762"]);
});

test("PDF: a lam-meem ligature that pdf.js reversed is put back; ordinary thin pairs are not", () => {
  // المتحف drawn: ف ح ت (ligature "لم" which pdf.js returns as "مل") ا
  const lig = lineOf([["ف", true], ["ح", true], ["ت", true], ["مل", true, 4], ["ا", true]]);
  assert.deepEqual(assembleLines(lig), ["المتحف"]);
  // التاريخ drawn: خ (item "ري" is two real glyphs) ا ت ل ا -- must stay "ري"
  const plain = lineOf([["خ", true], ["ري", true, 8], ["ا", true], ["ت", true], ["ل", true], ["ا", true]]);
  assert.deepEqual(assembleLines(plain), ["التاريخ"]);
});

test("PDF: Latin lines are untouched; lines are ordered top to bottom", () => {
  const items = [...lineOf([["Facture", false], [" ", false, 4], ["N°", false], [" ", false, 4], ["2021-0782", false]], 700),
    ...lineOf([["École", false]], 720)];
  assert.deepEqual(assembleLines(items), ["École", "Facture N° 2021-0782"]);
});

test("Windows OCR visual Arabic lines are put in reading order, number runs kept", () => {
  assert.equal(visualToLogicalLine("يوسف مار مدرسة"), "مدرسة مار يوسف");
  assert.equal(visualToLogicalLine("06/08/2021 التاريخ:"), "التاريخ: 06/08/2021");
  assert.equal(visualToLogicalLine("0762-2020 رقم فاتورة"), "فاتورة رقم 2020-0762");
  assert.equal(visualToLogicalLine("USD 5364.00 المجموع:"), "المجموع: USD 5364.00");
  assert.equal(visualToLogicalLine("Facture N° 2021"), "Facture N° 2021", "Latin lines are left alone");
});
