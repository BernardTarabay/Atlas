// The six-hour rotation, exercised.
//
// WHY THIS EXISTS
//
// The rotation is the one part of the verse with no visible failure mode. A
// verse with the wrong words shows the wrong words and somebody notices in a
// second. A rotation that is wrong shows a perfectly good verse -- the wrong
// one, or the same one for two days, or a different one in every browser --
// and nobody can tell by looking, because the only way to observe it is to
// look twice, six hours apart, on two machines.
//
// So the properties that make it correct are asserted here rather than
// trusted: that the slot is a function of the clock alone (which is what makes
// it agree everywhere) and that it turns over exactly on the boundary.
//
// The tests for the fetch, the cache and the English half went with the code
// they covered. That code was a hundred lines serving a request helmet's CSP
// refused in production; see the header of src/lib/verses.js.
//
//   npm test        (from frontend/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { SLOT_MS, VERSES, currentSlot, verseFor } from "../src/lib/verses.js";

const HOUR = 60 * 60 * 1000;

test("the rotation period is six hours", () => {
  assert.equal(SLOT_MS, 6 * HOUR);
});

test("every entry is Arabic text with an Arabic reference", () => {
  assert.ok(VERSES.length >= 40, "too few verses to be worth calling a rotation");
  for (const [i, v] of VERSES.entries()) {
    assert.ok(v.text && v.text.trim().length > 0, `entry ${i} has no text`);
    assert.ok(/[؀-ۿ]/.test(v.text), `entry ${i} is not Arabic`);
    assert.ok(/[؀-ۿ]/.test(v.ref), `entry ${i} has no Arabic reference`);
    // The reference carries Arabic-Indic digits, not Western ones. A label
    // reading "يوحنا 3: 16" is half-translated, and that is precisely the
    // detail a hand-written table gets wrong.
    assert.ok(/[٠-٩]/.test(v.ref), `entry ${i} reference has no Arabic-Indic digits`);
    assert.ok(!/[0-9]/.test(v.ref), `entry ${i} reference has Western digits`);
    // Nothing left over from the source's markup.
    assert.ok(!/[<>]/.test(v.text), `entry ${i} still carries markup`);
  }
});

test("references are unique -- a repeat inside one fortnight reads as a bug", () => {
  const refs = new Set(VERSES.map((v) => v.ref));
  assert.equal(refs.size, VERSES.length);
});

test("the slot is a pure function of the clock", () => {
  // Same instant, two "machines": same integer. This is the whole reason the
  // rotation is computed rather than stored.
  const at = Date.UTC(2026, 2, 14, 9, 30);
  assert.equal(currentSlot(at), currentSlot(at));
  assert.equal(currentSlot(0), 0);
  assert.equal(currentSlot(SLOT_MS - 1), 0);
  assert.equal(currentSlot(SLOT_MS), 1);
});

test("the slot turns over exactly on the boundary, four times a day", () => {
  const midnight = Date.UTC(2026, 2, 14);
  const slots = [0, 6, 12, 18].map((h) => currentSlot(midnight + h * HOUR));
  assert.deepEqual(slots, [slots[0], slots[0] + 1, slots[0] + 2, slots[0] + 3]);
  // And nothing changes in between.
  assert.equal(currentSlot(midnight + 5.99 * HOUR), slots[0]);
});

test("verseFor wraps in both directions and never returns undefined", () => {
  for (const slot of [0, 1, VERSES.length - 1, VERSES.length, VERSES.length * 7 + 3, -1, -VERSES.length - 1]) {
    const v = verseFor(slot);
    assert.ok(v && v.text, `slot ${slot} produced nothing`);
  }
  assert.equal(verseFor(0), VERSES[0]);
  assert.equal(verseFor(VERSES.length), VERSES[0]);
  // A negative slot cannot happen from the clock, but modulo in JavaScript is
  // signed and an out-of-range index would render an empty line rather than
  // throwing -- which is exactly the kind of failure nobody reports.
  assert.equal(verseFor(-1), VERSES[VERSES.length - 1]);
});
