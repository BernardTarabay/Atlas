// Describe stage.
//
// Thin, like ocrProcessor: all of the decision-making is in
// services/descriptionService.js, which is also what the manual "Describe
// again" action and the backfill script call. One implementation, three
// triggers.
const descriptionService = require("../../services/descriptionService");

async function handle({ fileId, force = false }) {
  if (!fileId) throw new Error("describe requires a fileId.");
  const result = await descriptionService.describeFile(fileId, { force });

  // Returned rather than thrown when the description could not be produced,
  // for the reason ocrProcessor documents: the queue's retry ladder is the wrong
  // answer to "the daily cap is reached", "AI is switched off" or "no
  // extractor can read this format". descriptionService has already recorded
  // the outcome on the file and moved it to a state the user can see, so the
  // honest report is a finished job with an unsuccessful result.
  //
  // A genuine exception -- a database error, a bug -- still propagates, and
  // that IS worth retrying.
  return result;
}

module.exports = { handle };
