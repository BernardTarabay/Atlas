# 17. OCR: the benchmark and what it decided

Measured 2026-09-19/20 on this development machine (i7-1165G7, 4 cores/8 threads).
Reproduce with `npm run bench:ocr` in `v2/`.

## The test set

`v2/bench/ocr-corpus.ts` renders 468 files with **exact ground truth**, using the
Edge that ships with Windows. Nothing is downloaded.

| set | what it is |
|---|---|
| clean (120) | document pages as crisp images, 3 languages × 5 templates (letter, invoice, receipt, form, report) |
| scan (120) | grayscale, rotated, blurred, noisy, off-white paper |
| photo (120) | phone photo of a page: perspective, shading, blur, table behind it |
| screenshot (24) | phone chat UI at 1080×2340 |
| notext (24) | pictures with no text at all |
| pdf-text (30) | real PDFs with a text layer |
| pdf-scan (30) | image-only PDFs |

Arabic documents use the Naskh fonts actually installed on Windows (Traditional
Arabic, Simplified Arabic, Sakkal Majalla, Arabic Typesetting...), French and
English use Times, Calibri, Cambria, Georgia and Courier.

**Word recall is the metric that matters**: the share of the document's words that
end up in the index, i.e. whether the file can be found by its words. Character
error rate is reported too, but it punishes reading order (tables, columns) which
search does not care about.

## Result

Word recall per variant, and speed with 4 running in parallel:

| engine | ar clean / scan / photo / shot / pdf-scan | fr + en (all variants) | images/s |
|---|---|---|---|
| **Windows OCR** | **88 / 82 / 66 / 97 / 75%** | **97–99.5%** | **22.7** |
| Tesseract fast (ara/fra/eng) | 80 / 82 / 56 / 71 / 70% | 100% clean, **67–73% photo** | 5.5 |
| Tesseract best | 85 / **87** / 56 / 79 / 73% | 100% clean, 67–73% photo | 3.3 |
| Tesseract ara+fra+eng (V1's setting) | 87 / 88 / 58 / 81 / 77% | 98–99% clean, 67–73% photo | 4.0 |
| Windows Latin → Tesseract for Arabic | 80 / 82 / 57 / 71 / 70% | same as Windows | 11.4 |

**Decision: Windows OCR** (`Windows.Media.Ocr`, via `bin/atlas-winrt.exe`).

- Best or near-best recall almost everywhere, and 4–7× faster.
- It holds up on phone photos (97–98% on Latin) where Tesseract collapses to 67–73%.
- Nothing to download, nothing GPL to bundle, Arabic/French/English recognizers
  already present on this machine.
- Tesseract's one real win is Arabic *scans* (+5 points of recall) at 5× the cost.
  Not worth a second engine on synthetic scans; re-check on real ones.

## Decisions that came out of the measurements

- **No separate "does this image contain text?" gate.** No engine invented text on
  the 24 no-text pictures, and Windows decides a picture has no text in ~30 ms.
  OCR is its own gate.
- **Language is not known in advance**, so `OcrService` reads with the Latin model
  first (fr-FR, which also reads English within 0.8 points of en-US) and only falls
  back to the Arabic model when the Latin reading is implausible. Arabic pages
  therefore cost two passes (~360 ms), Latin pages one (~120 ms).
- **An empty Latin reading still triggers the Arabic pass.** Measured: 2 of 128
  Arabic images return *nothing* from the Latin model, so treating "empty" as "no
  text" would silently lose those files. It costs ~36 ms per text-free picture.
- **Windows OCR returns Arabic lines in visual order** ("مدرسة مار يوسف" comes back
  as "يوسف مار مدرسة"). `src/ocr/bidi.ts` puts them back into reading order,
  keeping embedded Latin and number runs intact.

## PDF text layers (not OCR)

The same run measures text extraction from real PDFs:

| | before | after |
|---|---|---|
| Arabic | CER 98.8%, recall 23.2% | **CER 4.6%, recall 94.0%** |
| French | CER 0.5%, recall 98.5% | **CER 0.0%, recall 100%** |
| English | CER 0.0%, recall 100% | CER 0.0%, recall 100% |

Arabic PDFs were indexing garbage. Many PDF producers (Edge/Chrome among them)
emit **one item per glyph, in visual order, as presentation forms**, so joining
items in stream order reversed every Arabic word. `src/analyze/pdf.ts` now rebuilds
lines from glyph positions: order by x, split words at real gaps, reverse the
letters of Arabic words, restore reading order, and fold presentation forms. Two
subtleties, both regression-tested in `test/bidi.test.ts`:

- `2020-0762` displays as `0762-2020` inside Arabic (the hyphen splits the number
  into two runs), and is restored.
- pdf.js reverses every right-to-left item, which scrambles **ligatures** (one glyph
  mapped to several letters): `لم` comes back as `مل`. Only the lam ligatures of
  Naskh fonts are undone — a width test alone also broke ordinary thin pairs (`ري`).

The residual 6% of Arabic words are pairs Edge emits with **no space glyph between
them** (`مار يوسف` → `ماريوسف`); the spacing is not recoverable from the file.

## What the corpus caught downstream

Running the 907-file corpus through the real engine was also the first honest test
of document-type classification, and it failed loudly: **163 school registration
forms were filed under "Identity documents"**, a folder the corpus has no members
of. Three separate causes, all fixed in `src/analyze/dtype.ts`:

| | |
|---|---|
| "date of birth" was an identity keyword | it appears on forms, CVs and medical papers far more often than on ID papers. Identity now needs a passport or an ID card. Registration forms became their own type. |
| French keywords could never match | the dictionary stored `carte d identite`, but normalization splits elisions and drops the clitic, so real text became `carte identite`. Every French keyword with an apostrophe was dead: identity, tax, insurance. A test now asserts each keyword is in normalized form. |
| a mention outweighed the title | "Annual Report" scored 3 as one word in the head; the sentence "bring a copy of your identity card" scored 6 as a phrase in the same zone. Keywords are now scored in three zones - what the document calls itself (x6), its opening lines (x3), the rest (x1) - and equal scores break by position, then by name, so the outcome never depends on dictionary order. |

Same corpus, before and after:

| | Registration forms | Identity documents | Letters | typed as something |
|---|---|---|---|---|
| before | 0 | 163 | 86 | 837 |
| after | 151 | **9** | 80 | 843 |

Per language the counts are now near-symmetric (invoices 43/54/54 ar/en/fr,
receipts 35/52/54, registration 50/52/49), with Arabic trailing by exactly the
margin OCR recall predicts.

Note that `ANALYZER_VERSION` only re-analyzes a content when its file is read
again, so improving the dictionary does not retroactively re-type an existing
library. Re-analysis on demand is still to build.

## Real scans: RVL-CDIP

The synthetic set measures OCR against exact ground truth, but it cannot say how
Atlas types documents it did not write. RVL-CDIP small-200 (Hugging Face
`vaclavpechtor/rvl_cdip-small-200`) can: 3,200 real grayscale scans of 1980s-90s
business documents, 200 in each of 16 classes a person labelled. They are
fetched by `~/AtlasBench/rvl-cdip/fetch.mjs`, renamed `scan-0001.tif...` in a
shuffled order and the labels kept only in `truth.json`, so nothing about the
answer reaches Atlas through a name. `npm run bench:rvl` runs the real engine on
them and scores two things separately: how often a type Atlas has is found, and
how often a type is stamped on a class Atlas has no type for.

| | recall: invoice, letter, resume, report | typed anyway: adverts, news, handwriting, specs, folders |
|---|---|---|
| dictionary only | 22% | 3.1% |
| + shape (salutations, closings, section headings) | **39%** | **3.4%** |

OCR held up on real, bad scans: 87-99% of most classes gave readable text, at
~17 scans/s with 4 OCR workers. The typing did not, and reading the misses said
why. A letter is not identified by its vocabulary - "Dear Fred:" and "Very truly
yours" identify it, and the dictionary knew only "dear sir". An academic CV calls
itself a "biographical sketch". Billing paperwork says "amount due" and "please
remit", not "invoice". So `src/analyze/dtype.ts` now also recognises documents by
SHAPE: a salutation or closing standing on its own line (EN/FR/AR), and two or
more section headings of a CV or a research report. Letters went from 12% to 47%,
resumes from 33% to 64%, at the cost of a few forms and budgets read as letters.

What is left is honest: invoices (23%) and scientific reports (24%) in this set
are mostly vouchers, estimates, tables and fragments with nothing distinctive to
read, and many "letter" pages are the second page of a letter, which has neither
salutation nor closing. Pushing further on them would be tuning to one dataset.

## Where OCR sits in the pipeline

OCR runs **per unique content**, never per copy, on its own bounded pool so it
cannot starve reading and hashing. State lives on the content row
(`contents.ocr`), so a crash leaves it PENDING and it simply runs again. When OCR
finishes, its text is indexed next to any text layer (unless it came back as
noise), the document type and language are detected from it, and the files are
re-planned — which is how a photographed invoice moves into `Documents/Invoices`.

Without the helper (or with `ATLAS_OCR_WORKERS=0`) contents stay "waiting for
OCR" and everything else proceeds.
