// OCR stage.
//
// A separate queue from extract_text rather than a branch inside it, for the
// same reason every other stage is separate (docs/06-processing-pipeline.md
// §6.2): OCR is an order of magnitude slower than any other extractor and
// depends on an external binary. Sharing extract_text's queue would let a
// backlog of scans starve ordinary text extraction, and one missing
// dependency would fail a stage that has nothing to do with it.
//
// The processor itself is thin -- all of the decision-making is in
// services/ocr/ocrService.js, which is also what the manual "Run OCR" button
// calls. One implementation, two triggers, exactly as required for every
// other worker.
const ocrService = require("../../services/ocr/ocrService");

async function handle({ fileId, languages = undefined, force = false }) {
  if (!fileId) throw new Error("ocr requires a fileId.");
  const result = await ocrService.runForFile(fileId, { languages, force });

  // Returned rather than thrown even when OCR did not succeed.
  //
  // Throwing would hand the job to the queue's retry ladder, which is the wrong
  // response to every failure this stage actually has: a missing engine, a
  // missing language pack, and a PDF that cannot be rasterised are all fixed
  // by installing something, not by trying again in five seconds. ocrService
  // has already recorded the outcome on the file and moved it to a state the
  // user can see and act on, so the honest thing is to report the job as
  // finished with an unsuccessful result.
  return result;
}

module.exports = { handle };
