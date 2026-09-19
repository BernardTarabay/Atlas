// What an ATTACHED document looks like by the time it reaches the model.
//
// WHY THIS IS WORTH A TEST
//
// Drag-and-drop into the assistant is the kind of feature that is easy to
// implement as theatre: the chip appears, the panel lights up, the request is
// sent, an answer comes back -- and the answer is about whatever the page
// happened to be showing, because the attachment never made it into the
// prompt. Nothing about that failure is visible. The reply is fluent and
// plausible and about the wrong documents.
//
// So the assertions here are about the PROMPT TEXT, which is the only place
// the feature is real. buildInput is exported for exactly this reason (see the
// note at the bottom of geminiChatService.js).
//
//   npm test        (from backend/)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildInput } = require("../src/services/ai/geminiChatService");

const base = {
  message: "what are these about?",
  history: [],
  subjectTree: [{ id: "s1", level: 1, materialized_path: "/Finance", name: "Finance" }],
  selectedSubject: null,
  pageContext: null,
};

test("an attached file is marked, and an unattached one is not", () => {
  const out = buildInput({
    ...base,
    visibleFiles: [
      { id: "a1", filename: "contract.pdf", attached: true },
      { id: "b2", filename: "holiday.jpg" },
    ],
  });

  const attachedLine = out.split("\n").find((l) => l.includes("id: a1"));
  const plainLine = out.split("\n").find((l) => l.includes("id: b2"));

  assert.ok(attachedLine.includes("ATTACHED BY THE USER"), "the attached file is not marked");
  assert.ok(!plainLine.includes("ATTACHED"), "an unattached file was marked");

  // The mark comes BEFORE the filename. A model scanning a two-hundred-line
  // list has to know which entries were pointed at before it starts matching
  // the request against them; a flag after the description arrives too late.
  assert.ok(
    attachedLine.indexOf("ATTACHED BY THE USER") < attachedLine.indexOf("filename:"),
    "the attachment mark is not the first thing on the line"
  );
});

test("the number of attachments is stated, not left to be counted", () => {
  const three = buildInput({
    ...base,
    visibleFiles: [
      { id: "a", filename: "1.pdf", attached: true },
      { id: "b", filename: "2.pdf", attached: true },
      { id: "c", filename: "3.pdf", attached: true },
      { id: "d", filename: "unrelated.pdf" },
    ],
  });
  assert.match(three, /attached 3 documents to this message/);

  // Singular, because "attached 1 documents" is the kind of detail that makes
  // a prompt read as machine-generated to the thing reading it.
  const one = buildInput({ ...base, visibleFiles: [{ id: "a", filename: "1.pdf", attached: true }] });
  assert.match(one, /attached 1 document to this message/);
});

test("with nothing attached, the prompt says nothing about attachments", () => {
  const out = buildInput({
    ...base,
    visibleFiles: [{ id: "a", filename: "1.pdf" }, { id: "b", filename: "2.pdf" }],
  });
  assert.ok(!out.includes("ATTACHED BY THE USER |"), "a file was marked with nothing attached");
  assert.ok(!/attached \d+ document/.test(out), "an attachment count appeared with nothing attached");
});

test('the model is told that "these" means the attachments and not the whole list', () => {
  const out = buildInput({ ...base, visibleFiles: [{ id: "a", filename: "1.pdf", attached: true }] });
  // The instruction is the difference between an answer about four documents
  // and an answer about four hundred. Asserted by its substance rather than
  // word-for-word, so rewording the prompt does not fail this.
  assert.match(out, /do not widen the request/i);
  assert.match(out, /ATTACHED BY THE USER/);
});

test("attachments survive the trim that drops the tail of a long list", () => {
  // buildInput keeps the first MAX_VISIBLE_FILES entries, so this is really a
  // check that the ORDER the controller builds is the order that matters: an
  // attachment placed late would be trimmed away on a busy page and the
  // feature would fail only for the users with the most files.
  const many = Array.from({ length: 400 }, (_, i) => ({ id: `f${i}`, filename: `file${i}.pdf` }));
  const out = buildInput({ ...base, visibleFiles: [{ id: "att", filename: "the-one.pdf", attached: true }, ...many] });
  assert.match(out, /id: att \| ATTACHED BY THE USER/);
  assert.match(out, /attached 1 document/);

  const trimmedAway = buildInput({ ...base, visibleFiles: [...many, { id: "att", filename: "the-one.pdf", attached: true }] });
  assert.ok(
    !trimmedAway.includes("id: att"),
    "the trim no longer drops the tail -- if MAX_VISIBLE_FILES changed, the ordering argument in aiChatController needs re-reading"
  );
});
