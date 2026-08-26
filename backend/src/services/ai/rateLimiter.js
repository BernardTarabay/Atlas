// Optional client-side pacing for outgoing Gemini calls, plus the parser for
// Google's own retry hint.
//
// PACING IS OFF BY DEFAULT. env.ai.rateLimitPerMinute defaults to 0, and at 0
// acquireRateLimitSlot() returns immediately -- this application does not
// impose an artificial rate on itself (see config/env.js). What remains
// load-bearing here is parseRetryDelayMs: when Google answers 429 it says how
// long to wait, and every caller honours that and retries. That is real
// backpressure against the real quota, which is why guessing at a lower rate
// ourselves was only ever slowing down work that would have been allowed.
//
// The window below still exists so a deliberately constrained key can opt back
// in by setting GEMINI_RATE_LIMIT_PER_MINUTE to a positive number.
//
// WHY THIS WAS EXTRACTED
//
// This sliding window lived inside geminiClassifier.js, private to it. That
// was correct while the classifier was the only thing calling Gemini, and it
// stopped being correct the moment it wasn't: imageDescriber already called
// the API without passing through it, and describing files adds three more
// callers (text summaries, image/video/audio description, embeddings).
//
// Four private limiters each pacing at env.ai.rateLimitPerMinute do not
// enforce that limit -- they enforce four times it, which on the free tier
// (15 requests/minute for gemini-3.1-flash-lite, seen firsthand in the 429
// body) is a burst straight through the quota. A quota is a property of the
// API key, so the window that paces it has to be a property of the process,
// not of whichever module happens to be calling.
//
// The behaviour is deliberately unchanged from the classifier's original: a
// call WAITS for a free slot rather than being refused one, and acquisition is
// serialized through a single promise chain so concurrent callers cannot all
// read the same "under the limit" snapshot and proceed together.
const env = require("../../config/env");

const callTimestamps = [];
let rateLimitChain = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until this process may make another Gemini call.
 *
 * @returns {Promise<void>} resolves once a slot has been taken
 */
function acquireRateLimitSlot() {
  rateLimitChain = rateLimitChain.then(async () => {
    const limit = env.ai.rateLimitPerMinute;
    if (!limit || limit <= 0) return; // 0/unset = no client-side pacing
    const windowMs = 60_000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      while (callTimestamps.length && now - callTimestamps[0] >= windowMs) {
        callTimestamps.shift();
      }
      if (callTimestamps.length < limit) {
        callTimestamps.push(now);
        return;
      }
      await sleep(callTimestamps[0] + windowMs - now + 50);
    }
  });

  // A rejected link would poison the chain permanently: every later .then() on
  // it inherits the rejection, so one failure inside the block above would
  // mean acquireRateLimitSlot() rejects forever for the life of the process --
  // and since the AI tiers catch everything around their calls, that would
  // silently disable AI for the whole worker with no error anyone would see.
  // Keep the CHAIN resolved; hand the caller the real outcome.
  const acquired = rateLimitChain;
  rateLimitChain = rateLimitChain.then(
    () => {},
    () => {}
  );
  return acquired;
}

// Google's 429 body includes a human-readable hint like "Please retry in
// 25.054123681s." -- honor that instead of guessing, so a retry doesn't fire
// early and get rejected again.
function parseRetryDelayMs(bodyText) {
  const match = /retry in ([\d.]+)s/i.exec(bodyText || "");
  if (!match) return null;
  return Math.ceil(parseFloat(match[1]) * 1000) + 500; // small buffer
}

/** Test seam: forget the current window. Not used in production code. */
function _reset() {
  callTimestamps.length = 0;
  rateLimitChain = Promise.resolve();
}

module.exports = { acquireRateLimitSlot, parseRetryDelayMs, sleep, _reset };
