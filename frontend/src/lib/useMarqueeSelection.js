import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Rubber-band selection: drag a box over a list and everything it touches is
 * selected, the way every desktop file manager works.
 *
 * WHY THE RIGHT BUTTON
 *
 * Asked for explicitly. It is worth knowing it is unusual -- Explorer, Finder
 * and every web app that does this use the LEFT button -- and the reason they
 * do is that the right button is already spoken for by the context menu. That
 * conflict is handled here rather than avoided: a press-and-release without
 * movement is a click and the menu opens as normal; only once the pointer has
 * travelled past DRAG_THRESHOLD_PX does this become a drag, and only then is
 * the menu suppressed. So right-click still behaves exactly as it did unless
 * the user actually drags.
 *
 * WHAT IT SELECTS
 *
 * Any element inside the container carrying `data-select-id`. That attribute
 * is the whole contract -- files and folders both wear it, so one
 * implementation covers both and neither needs to know about the other.
 *
 * WHAT IT CANNOT SELECT
 *
 * The file list is windowed: rows outside the viewport have no DOM node, so a
 * marquee cannot touch them. That is the same limit a real file manager has
 * mid-drag, and it is why the box only ever adds what it actually crosses
 * rather than trying to infer a range from the first and last row it hit --
 * inferring would silently include rows nobody dragged over.
 *
 * @param {object}   opts
 * @param {Function} opts.onSelect      (ids, {additive}) => void, called live while dragging
 * @param {boolean}  opts.enabled
 */
const DRAG_THRESHOLD_PX = 6;

export function useMarqueeSelection({ onSelect, enabled = true } = {}) {
  const containerRef = useRef(null);
  const originRef = useRef(null);
  const draggedRef = useRef(false);
  // Held in a ref as well as state: the mousemove handler needs the current
  // value on every frame, and reading it from state would close over a stale
  // one for the life of the listener.
  const [rect, setRect] = useState(null);

  const finish = useCallback(() => {
    originRef.current = null;
    setRect(null);
  }, []);

  const onMouseDown = useCallback((e) => {
    if (!enabled || e.button !== 2) return;
    const host = containerRef.current;
    if (!host) return;
    // A drag that starts on a button or a link is that control's business.
    if (e.target.closest("button, a, input, textarea, select")) return;

    const bounds = host.getBoundingClientRect();
    originRef.current = {
      x: e.clientX,
      y: e.clientY,
      // Scroll position at the start, so the box stays anchored to the
      // CONTENT rather than the viewport if the list scrolls under it.
      scrollTop: host.scrollTop,
      bounds,
      additive: e.ctrlKey || e.metaKey || e.shiftKey,
    };
    draggedRef.current = false;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;

    const onMove = (e) => {
      const origin = originRef.current;
      if (!origin) return;

      const dx = Math.abs(e.clientX - origin.x);
      const dy = Math.abs(e.clientY - origin.y);
      if (!draggedRef.current && dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) return;
      draggedRef.current = true;

      // Text selection fights the marquee visually and makes the whole
      // interaction feel broken, so it is suppressed for the duration.
      e.preventDefault();

      const box = {
        left: Math.min(origin.x, e.clientX),
        top: Math.min(origin.y, e.clientY),
        right: Math.max(origin.x, e.clientX),
        bottom: Math.max(origin.y, e.clientY),
      };
      setRect(box);

      const host = containerRef.current;
      if (!host) return;
      const hits = [];
      for (const el of host.querySelectorAll("[data-select-id]")) {
        const r = el.getBoundingClientRect();
        // Intersection, not containment: clipping a row's edge counts, which
        // is what makes a quick diagonal drag feel right instead of demanding
        // the box swallow each row whole.
        const touches = r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
        if (touches) hits.push(el.getAttribute("data-select-id"));
      }
      onSelect(hits, { additive: origin.additive });
    };

    const onUp = () => {
      if (originRef.current) finish();
    };

    // A drag that ends outside the window still has to end.
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
    };
  }, [enabled, onSelect, finish]);

  /**
   * Suppress the context menu ONLY when a drag actually happened. This is the
   * whole reason right-drag can coexist with right-click.
   */
  const onContextMenu = useCallback((e) => {
    if (draggedRef.current) {
      e.preventDefault();
      draggedRef.current = false;
    }
  }, []);

  /**
   * "Did the gesture that just ended turn into a drag?" -- asked by the ROW's
   * own contextmenu handler, which runs before this container's and would
   * otherwise pop a menu at the end of every rubber-band selection.
   *
   * Consuming (rather than just reading) is what keeps the two handlers from
   * both trying to own the flag: whoever asks first clears it.
   */
  const consumeDrag = useCallback(() => {
    const did = draggedRef.current;
    draggedRef.current = false;
    return did;
  }, []);

  return {
    containerRef, onMouseDown, onContextMenu, consumeDrag,
    marqueeRect: rect, isDragging: Boolean(rect),
  };
}
