/**
 * The rules that decide what a finger meant, kept separate from the DOM.
 *
 * WHY THE LOGIC IS PURE AND THE HOOKS ARE THIN
 *
 * A row in the mobile Library has to serve four gestures that all start with
 * exactly the same event -- a finger touching it:
 *
 *   tap          open the file, or enter the folder
 *   long press   enter selection mode
 *   swipe X      reveal the actions underneath
 *   scroll Y     the list moves; the row must do nothing at all
 *
 * Which one it was is decided by distance and time, and getting those
 * thresholds wrong is what makes a phone interface feel broken: cancel the
 * long press too eagerly and it never fires because fingers are never still;
 * cancel it too late and every attempt to scroll selects something. That
 * decision is worth testing directly, and it cannot be tested through a
 * rendered component without synthesising a pointer stream.
 *
 * So the arithmetic lives here as plain functions, and the hooks below only
 * wire them to events.
 */

/** Movement past this many pixels means the finger is going somewhere. */
export const MOVE_TOLERANCE_PX = 10;

/**
 * How long a finger must stay still to mean "select this".
 *
 * 450ms: long enough that a slow tap is not mistaken for a press, short enough
 * that it does not feel like the phone has stopped listening. Both iOS and
 * Android sit in the 400-500ms range and borrowing the number people's hands
 * are already trained on is worth more than tuning it ourselves.
 */
export const LONG_PRESS_MS = 450;

/**
 * A swipe must be this much more horizontal than vertical to count.
 *
 * Without a ratio, any drag that happens to start sideways steals a scroll --
 * which on a list is the gesture people make hundreds of times more often. A
 * swipe is a deliberate sideways movement; a scroll that wobbles is not.
 */
export const SWIPE_AXIS_RATIO = 1.6;

/** Past this fraction of the action tray, the swipe settles open. */
export const SWIPE_OPEN_FRACTION = 0.4;

/**
 * Has the finger moved far enough that this is no longer a press?
 *
 * Deliberately generous and deliberately symmetric: a thumb resting on a phone
 * drifts a few pixels without its owner intending anything by it, and a press
 * cancelled by that drift reads as the gesture simply not working.
 */
export function movedEnoughToCancelPress(dx, dy, tolerance = MOVE_TOLERANCE_PX) {
  return Math.abs(dx) > tolerance || Math.abs(dy) > tolerance;
}

/**
 * Which axis is this drag on, once it has moved at all?
 *
 * Returns "x", "y", or null while it is still too small to say. Deciding ONCE
 * and then committing is what stops a row sliding around during a scroll: the
 * answer is latched by the caller, not recomputed every frame.
 */
export function dragAxis(dx, dy, tolerance = MOVE_TOLERANCE_PX, ratio = SWIPE_AXIS_RATIO) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < tolerance && ay < tolerance) return null;
  if (ax >= ay * ratio) return "x";
  return "y";
}

/**
 * Clamp a drag to what the row can actually reveal.
 *
 * Rubber-banding past the end rather than stopping dead: a hard stop feels
 * like the gesture failed, a little give feels like the end of the tray. Same
 * reason every native list does it.
 */
export function clampSwipe(dx, { leftWidth = 0, rightWidth = 0, give = 0.25 } = {}) {
  // dx < 0 is a leftward swipe, which reveals the RIGHT-hand tray.
  const max = leftWidth;
  const min = -rightWidth;
  if (dx > max) return max + (dx - max) * give;
  if (dx < min) return min + (dx - min) * give;
  return dx;
}

/**
 * Where the row should come to rest when the finger lifts.
 *
 * Past a fraction of the tray it opens; short of it, it snaps shut. A velocity
 * term is deliberately not used: a flick and a slow drag should settle the
 * same way, because the difference between them is not something a person is
 * consciously controlling.
 */
export function settleSwipe(offset, { leftWidth = 0, rightWidth = 0, fraction = SWIPE_OPEN_FRACTION } = {}) {
  if (offset > 0 && leftWidth > 0) return offset >= leftWidth * fraction ? leftWidth : 0;
  if (offset < 0 && rightWidth > 0) return -offset >= rightWidth * fraction ? -rightWidth : 0;
  return 0;
}

/**
 * What a completed press means.
 *
 * The one rule worth stating explicitly: once selection mode is on, a plain tap
 * TOGGLES rather than opens. Opening a file from a list where three others are
 * ticked is never what was meant, and every mail and messaging app resolves it
 * the same way.
 */
export function resolveTap({ selectionMode }) {
  return selectionMode ? "toggle" : "activate";
}
