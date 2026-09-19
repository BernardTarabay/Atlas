import { test } from "node:test";
import assert from "node:assert/strict";
import {
  movedEnoughToCancelPress, dragAxis, clampSwipe, settleSwipe, resolveTap,
  MOVE_TOLERANCE_PX, SWIPE_AXIS_RATIO,
} from "../src/lib/touchGestures.js";

/*
 * These are the rules that decide whether a finger meant to open a file,
 * select it, reveal its actions, or just scroll past it. Four gestures share
 * one starting event, so the thresholds ARE the interaction -- and they are
 * the part that cannot be checked by looking at a mobile viewport, because
 * nothing about them is visible until a real finger gets them wrong.
 */

test("a thumb resting still is a press, not a drag", () => {
  assert.equal(movedEnoughToCancelPress(0, 0), false);
  // Fingers are never perfectly still. Cancelling on a 3px tremor would mean
  // long-press simply never fires for most people.
  assert.equal(movedEnoughToCancelPress(3, 4), false);
});

test("a press is cancelled once the finger genuinely travels", () => {
  assert.equal(movedEnoughToCancelPress(MOVE_TOLERANCE_PX + 1, 0), true);
  assert.equal(movedEnoughToCancelPress(0, MOVE_TOLERANCE_PX + 1), true);
});

test("a drag has no axis until it has actually moved", () => {
  // Latching an axis from the first pixel is how rows twitch sideways during
  // a scroll: at 1px the direction is noise, not intent.
  assert.equal(dragAxis(0, 0), null);
  assert.equal(dragAxis(4, 3), null);
});

test("a clearly sideways drag is a swipe", () => {
  assert.equal(dragAxis(40, 2), "x");
  assert.equal(dragAxis(-40, 5), "x");
});

test("a vertical drag is a scroll and must never be a swipe", () => {
  assert.equal(dragAxis(2, 40), "y");
  assert.equal(dragAxis(-6, 60), "y");
});

test("a diagonal drag resolves to scrolling, which is the safer default", () => {
  // Equal parts sideways and down, on a list, is someone scrolling with an
  // imperfect thumb. Stealing that for a swipe is the more annoying mistake:
  // a missed swipe costs one retry, a stolen scroll fights every drag.
  assert.equal(dragAxis(30, 30), "y");
  // ...and it only becomes a swipe once it is decisively more horizontal.
  assert.equal(dragAxis(30 * SWIPE_AXIS_RATIO + 1, 30), "x");
});

test("a swipe cannot drag further than the tray it reveals", () => {
  assert.equal(clampSwipe(-50, { rightWidth: 160 }), -50);
  // Rubber-band past the end rather than stopping dead -- a hard stop reads as
  // the gesture having failed.
  const past = clampSwipe(-200, { rightWidth: 160, give: 0.25 });
  assert.ok(past < -160 && past > -200, `expected give past the end, got ${past}`);
});

test("a row with no tray on that side barely moves", () => {
  const dragged = clampSwipe(80, { leftWidth: 0, rightWidth: 160, give: 0.25 });
  assert.ok(dragged < 80 && dragged > 0, `expected resistance, got ${dragged}`);
});

test("a short swipe snaps shut and a committed one opens", () => {
  const tray = { rightWidth: 160 };
  assert.equal(settleSwipe(-30, tray), 0, "a nudge must not leave the row hanging open");
  assert.equal(settleSwipe(-120, tray), -160, "a committed swipe opens fully");
});

test("settling is symmetric, so both trays feel the same", () => {
  assert.equal(settleSwipe(30, { leftWidth: 160 }), 0);
  assert.equal(settleSwipe(120, { leftWidth: 160 }), 160);
});

test("a swipe toward a side with no actions always closes", () => {
  assert.equal(settleSwipe(120, { leftWidth: 0, rightWidth: 160 }), 0);
});

test("tapping opens normally, but toggles once anything is selected", () => {
  // The rule that stops a tap opening a file while three others are ticked --
  // which is never what was meant, and is how every mail app behaves.
  assert.equal(resolveTap({ selectionMode: false }), "activate");
  assert.equal(resolveTap({ selectionMode: true }), "toggle");
});
