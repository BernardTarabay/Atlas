// The body-size split: 1MB everywhere, one exception for the endpoint that
// genuinely carries file bytes.
//
// WHAT THIS IS GUARDING
//
// The agent's `read_file` returns a file base64-encoded inside an operation
// result, so bytes travel through the JSON parser on
// POST /api/agents/operations/:id/result. That route needs a large body limit.
// Nothing else does, and giving it to everything would let an unauthenticated
// caller make the API buffer hundreds of megabytes.
//
// Both halves of that are easy to break silently and neither shows up in a
// unit test of any single module:
//
//   * app.js's general parser runs FIRST, so if it does not step aside for the
//     agent path it 413s the large body before the route's own parser exists.
//     Symptom: the agent's uploads fail at ~750KB with a 413 while every
//     constant in the codebase says 200MB.
//   * the large parser is mounted AFTER authenticateAgent on purpose. If that
//     order is ever swapped, an anonymous caller can make the process buffer
//     280MB. Symptom: none, until someone notices the memory.
//
// So this exercises the real Express app over a real socket.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const app = require("../src/app");

let server, base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/**
 * POST a JSON body of approximately `bytes`, without building the string twice.
 *
 * Streamed rather than passed to fetch as one string: the point of these tests
 * is bodies too large to want a second copy of, and a helper that doubles peak
 * memory to test a memory limit would be its own joke.
 */
function postJson(path, bytes, headers = {}) {
  return new Promise((resolve, reject) => {
    const prefix = '{"success":true,"result":{"contentBase64":"';
    const suffix = '"}}';
    const filler = "A".repeat(64 * 1024);
    const total = prefix.length + bytes + suffix.length;

    const req = http.request(
      `${base}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": total, ...headers },
      },
      (res) => {
        res.resume(); // drain, we only care about the status
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);

    req.write(prefix);
    let written = 0;
    while (written < bytes) {
      const chunk = Math.min(filler.length, bytes - written);
      req.write(chunk === filler.length ? filler : filler.slice(0, chunk));
      written += chunk;
    }
    req.write(suffix);
    req.end();
  });
}

const TWO_MB = 2 * 1024 * 1024;

test("a >1MB body to an ordinary route is refused", async () => {
  const status = await postJson("/api/ai/chat", TWO_MB);
  assert.strictEqual(status, 413, "the general 1MB limit should reject this");
});

test("a >1MB body to an unmatched API route is refused too", async () => {
  // Proves the skip is scoped to the agent result path specifically, rather
  // than to anything under /api/agents or -- worse -- to everything.
  const status = await postJson("/api/agents/operations", TWO_MB);
  assert.strictEqual(status, 413);
});

test("a >1MB body to the agent result route is NOT refused on size", async () => {
  // 401 from authenticateAgent is the pass condition: it means the body got
  // past the general parser and the request reached route code. A 413 here is
  // the exact regression this file exists to catch.
  const status = await postJson("/api/agents/operations/abc-123/result", TWO_MB);
  assert.notStrictEqual(status, 413, "the general parser should have stepped aside for this path");
  assert.strictEqual(status, 401, "unauthenticated, but only after the body was allowed through");
});

test("the agent result route rejects an anonymous caller BEFORE parsing the body", async () => {
  // The ordering property. authenticateAgent reads a header, so it can answer
  // 401 without the body having been buffered; if the large parser were mounted
  // first, this would still be 401 but would have held the whole body to say so.
  // Timing is the only observable difference from outside, so this asserts the
  // thing that is checkable -- that auth answers at all -- and the comment in
  // agentRoutes.js carries the rest.
  const status = await postJson("/api/agents/operations/abc-123/result", 1024, {
    Authorization: "Bearer not-a-real-agent-token",
  });
  assert.strictEqual(status, 401);
});

test("the trailing-slash form of the agent path is also exempted", async () => {
  // Express matches "/result/" to the same route, so the skip regex has to as
  // well or the two disagree about which parser applies.
  const status = await postJson("/api/agents/operations/abc-123/result/", TWO_MB);
  assert.notStrictEqual(status, 413);
});
