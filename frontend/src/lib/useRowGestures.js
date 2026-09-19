import { useCallback, useEffect, useRef, useState } from "react";
import {
  LONG_PRESS_MS, clampSwipe, dragAxis, movedEnoughToCancelPress, settleSwipe,
} from "./touchGestures";

/**
 * One pointer stream, four meanings, decided once per gesture.
 *
 * WHY THIS IS A SINGLE HOOK AND NOT THREE
 *
 * Tap, long press and swipe all begin with the identical event, and a scroll
 * begins with it too. Implemented separately they fight: a swipe handler that
 * does not know about the press timer leaves selection mode firing mid-swipe;
 * a press timer that does not know about the scroll axis selects a row every
 * time someone flicks the list.
 *
 * So the gesture is resolved ONCE, here, and latched:
 *
 *   finger down            start the press timer, record the origin
 *   moves past tolerance   decide the axis, and never revisit it
 *     -> "y"               this is a scroll. Release the row entirely; the
 *                          list scrolls natively and nothing else happens.
 *     -> "x"               this is a swipe. Cancel the press timer and follow
 *                          the finger.
 *   timer fires first      it was a long press. Cancel everything else.
 *   finger up, no move     it was a tap.
 *
 * WHY POINTER EVENTS AND NOT TOUCH EVENTS
 *
 * The same code then works for a mouse, which is what makes this testable at a
 * desktop browser at all, and it is the API that reports a `pointerId` so a
 * second finger cannot confuse a drag in progress.
 */
export function useRowGestures({
  onTap, onLongPress, onSwipeSettle,
  leftWidth = 0, rightWidth = 0,
  enabled = true,
} = {}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const state = useRef(null);
  const timer = useRef(null);

  const clearTimer = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  };

  // A row unmounting mid-press must not fire a selection into a component that
  // is no longer there -- windowed lists recycle rows constantly.
  useEffect(() => clearTimer, []);

  const close = useCallback(() => setOffset(0), []);

  const onPointerDown = useCallback((e) => {
    if (!enabled) return;
    // Secondary buttons are the desktop context menu's business.
    if (e.pointerType === "mouse" && e.button !== 0) return;

    state.current = {
      id: e.pointerId, x: e.clientX, y: e.clientY,
      axis: null, longPressed: false, startOffset: offset,
    };
    setDragging(false);

    clearTimer();
    timer.current = setTimeout(() => {
      const s = state.current;
      // Only if the finger never committed to a direction. A press that has
      // become a swipe is not a press any more.
      if (!s || s.axis) return;
      s.longPressed = true;
      // Snap shut first: entering selection mode with a half-open tray leaves
      // two different interaction states visible at once.
      setOffset(0);
      onLongPress?.();
    }, LONG_PRESS_MS);
  }, [enabled, offset, onLongPress]);

  const onPointerMove = useCallback((e) => {
    const s = state.current;
    if (!s || s.id !== e.pointerId) return;

    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;

    if (!s.axis) {
      if (!movedEnoughToCancelPress(dx, dy)) return;
      clearTimer();
      s.axis = dragAxis(dx, dy);
      // A scroll is the list's gesture, not the row's. Letting go here is what
      // keeps vertical flicks from dragging rows sideways.
      if (s.axis === "y") { state.current = null; setOffset(0); return; }
      setDragging(true);
    }

    if (s.axis === "x") {
      // Once dragging, the browser must stop trying to scroll or text-select.
      // touch-action on the element covers touch; this covers the rest.
      if (e.cancelable) e.preventDefault();
      setOffset(clampSwipe(s.startOffset + dx, { leftWidth, rightWidth }));
    }
  }, [leftWidth, rightWidth]);

  const finish = useCallback((e) => {
    const s = state.current;
    clearTimer();
    if (!s || (e && s.id !== e.pointerId)) return;
    state.current = null;
    setDragging(false);

    if (s.longPressed) return;           // already handled
    if (s.axis === "x") {
      const settled = settleSwipe(offset, { leftWidth, rightWidth });
      setOffset(settled);
      onSwipeSettle?.(settled);
      return;
    }
    if (s.axis) return;                  // a scroll; nothing to do

    // No movement, no timer: a tap. If a tray is open, the tap closes it
    // rather than activating the row -- the first tap after revealing actions
    // is almost always "put that away".
    if (offset !== 0) { setOffset(0); return; }
    onTap?.();
  }, [offset, leftWidth, rightWidth, onSwipeSettle, onTap]);

  return {
    offset,
    dragging,
    close,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      // Without this the row keeps receiving moves after the finger leaves it,
      // which is what makes a swipe "stick" when it crosses into another row.
      onPointerLeave: (e) => { if (state.current && state.current.axis === null) finish(e); },
    },
  };
}
