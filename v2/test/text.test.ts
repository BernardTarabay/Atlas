import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, stem, stemArabic, stemLatin, indexText, ftsQuery, nameQuery, detectLang } from "../src/search/text.ts";

test("Arabic: alef variants, alef maqsura, ta marbuta and hamza carriers unify", () => {
  assert.equal(normalize("أحمد إبراهيم آمنة"), "احمد ابراهيم امنه");
  assert.equal(normalize("مستشفى"), "مستشفي");
  assert.equal(normalize("مسؤول مسائل"), "مسوول مسايل");
});

test("Arabic: tashkeel, tatweel and Quranic marks are stripped", () => {
  assert.equal(normalize("مُحَمَّدٌ"), "محمد");
  assert.equal(normalize("الـــعـــربية"), "العربيه");
});

test("Arabic-Indic and Persian digits become ASCII (dates, invoice numbers)", () => {
  assert.equal(normalize("فاتورة رقم ٢٠٢٣-٠٤١٧"), "فاتوره رقم 2023 0417");
  assert.equal(normalize("۱۴۰۲"), "1402");
});

test("PDF presentation forms and lam-alef ligatures fold to letters (NFKC)", () => {
  assert.equal(normalize("ﻻﺎﺮ"), normalize("لاار"));
});

test("French: accents folded, elisions split including the typographic apostrophe", () => {
  assert.equal(normalize("L’École d'été"), "ecole ete");
  assert.equal(normalize("qu’il jusqu'à"), "il a");
  assert.equal(normalize("Œuvre"), "oeuvre");
});

test("Arabic light10 stemming strips articles, conjunction and suffixes consistently", () => {
  assert.equal(stemArabic(normalize("الفاتورة")), stemArabic(normalize("فاتورة")));
  assert.equal(stemArabic(normalize("والفاتورة")), stemArabic(normalize("فاتورة")));
  assert.equal(stemArabic(normalize("بالمدرسة")), stemArabic(normalize("المدرسة")));
  assert.equal(stemArabic("ال"), "ال", "never strips a word to nothing");
});

test("Latin minimal stemming: plurals only, never below 3 letters", () => {
  assert.equal(stemLatin("invoices"), "invoice");
  assert.equal(stemLatin("factures"), "facture");
  assert.equal(stemLatin("queries"), "query");
  assert.equal(stemLatin("journaux"), "journal");
  assert.equal(stemLatin("process"), "process");
  assert.equal(stemLatin("bus"), "bus");
  assert.equal(stem("contracts"), "contract");
});

test("index and query sides produce the same terms", () => {
  assert.equal(indexText("Les Factures de l'École"), "les facture de ecole");
  assert.equal(ftsQuery("factures école"), '"facture"* AND "ecole"*');
});

test("FTS query: user quotes cannot break out of the expression", () => {
  assert.equal(ftsQuery('"exact phrase" other'), '"exact phrase" AND "other"*');
  // FTS operators typed by a user become quoted terms, never operators.
  assert.equal(ftsQuery('a " OR b'), '"a" AND "or" AND "b"');
  assert.equal(ftsQuery("NEAR(x y) NOT z*"), '"near"* AND "x" AND "y" AND "not"* AND "z"');
  assert.equal(ftsQuery("   "), null);
});

test("name query needs 3+ characters per term (trigram index)", () => {
  assert.equal(nameQuery("INV-2023-0417"), '"inv" AND "2023" AND "0417"');
  assert.equal(nameQuery("a b"), null);
});

test("language detection", () => {
  assert.equal(detectLang("هذا تقرير عن الميزانية السنوية للمدرسة وتفاصيل الدفع"), "ar");
  assert.equal(detectLang("Le rapport de la réunion est dans le dossier des factures pour les élèves"), "fr");
  assert.equal(detectLang("The report of the meeting is in the folder with the invoices for the team"), "en");
  assert.equal(detectLang("123 456"), null);
});
