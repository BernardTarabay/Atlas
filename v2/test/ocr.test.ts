import "./_env.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OcrService } from "../src/ocr/ocr.ts";
import { Db } from "../src/db/db.ts";
import { Engine } from "../src/pipeline/engine.ts";
import { search } from "../src/search/search.ts";
import { tokens } from "../src/search/text.ts";
import { S, OCR } from "../src/pipeline/states.ts";

const fixture = (n: string) => path.join(import.meta.dirname, "fixtures", n);
const skip = !OcrService.available() ? "Windows OCR helper not built (npm run build:native)" : false;
const overlap = (got: string, want: string) => {
  const g = new Set(tokens(got));
  const w = tokens(want);
  return w.filter((t) => g.has(t)).length / w.length;
};

test("OCR service reads English and routes Arabic to the Arabic model, in reading order", { skip }, async () => {
  const ocr = new OcrService(1);
  try {
    const en = await ocr.recognize(fixture("receipt-en.png"), "image");
    assert.equal(en.lang, "en");
    assert.ok(overlap(en.text, "St. Joseph School Receipt School books Uniform Lunch program Total 217.00 Received from Mr. George Khoury") > 0.9, en.text);
    const ar = await ocr.recognize(fixture("receipt-ar.png"), "image");
    assert.equal(ar.lang, "ar");
    assert.equal(ar.engine, "win:ar-SA");
    assert.ok(overlap(ar.text, "مدرسة مار يوسف إيصال استلام الكتب المدرسية المجموع 217.00") > 0.6, ar.text);
    assert.ok(ar.text.indexOf("مدرسة") < ar.text.indexOf("يوسف"), "Arabic comes back in reading order");
  } finally {
    ocr.close();
  }
});

let tree = "", db: Db, engine: Engine;
before(async () => {
  if (skip) return;
  tree = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ocr-"));
  fs.copyFileSync(fixture("receipt-en.png"), path.join(tree, "IMG_20230428_092300.png"));
  fs.copyFileSync(fixture("receipt-ar.png"), path.join(tree, "WhatsApp Image 2023-07-28 at 20.36.00.png"));
  db = new Db(path.join(process.env.ATLAS_HOME!, "ocr.db"));
  db.run("INSERT INTO roots(path, created) VALUES (?, ?)", tree, Date.now());
  engine = new Engine(db);
  engine.start();
  engine.requestScan(1);
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const pending = db.get<{ n: number }>(`SELECT (SELECT count(*) FROM files WHERE state < ${S.DONE}) + (SELECT count(*) FROM contents WHERE ocr = ${OCR.PENDING}) AS n`)!.n;
    if (pending === 0 && engine.scanState.scanning == null && engine.pool.busy === 0 && (engine.ocr?.busy ?? 0) === 0) return;
  }
  throw new Error("pipeline did not settle");
});
after(async () => {
  if (skip) return;
  await engine.stop();
  db.close();
  fs.rmSync(tree, { recursive: true, force: true });
});

test("pipeline: images are OCR'd once, indexed, typed from their text and filed as documents", { skip }, () => {
  const contents = db.all<{ ocr: number; dtype: string | null; lang: string | null }>("SELECT ocr, dtype, lang FROM contents ORDER BY lang");
  assert.deepEqual(contents.map((c) => c.ocr), [OCR.DONE, OCR.DONE]);
  assert.deepEqual(contents.map((c) => c.dtype), ["receipt", "receipt"]);
  const plans = db.all<{ plan: string }>("SELECT plan FROM files ORDER BY plan").map((r) => r.plan);
  assert.ok(plans.every((p) => p.startsWith("Documents/Receipts/2023/")), plans.join(" | "));
  assert.equal(search(db, "receipt Khoury").hits.length, 1);
  assert.equal(search(db, "إيصال").hits.length, 1);
  assert.ok(search(db, "إيصال").hits[0].snippet, "snippet comes from the OCR text");
});
