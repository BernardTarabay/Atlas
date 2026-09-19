import { useEffect, useRef } from "react";
import { TopNav } from "./TopNav";

/**
 * THE FLOATING CHROME: the navigation, hovering over the page.
 *
 * WHAT CHANGED AND WHY IT NEEDED A COMPONENT
 *
 * The header used to be a full-width bar in the document flow -- `sticky`,
 * edge to edge, with a border under it. It is now a centred pill wearing the
 * same surface as the toolbar the Library raises when you tick files
 * (`.floating-bar`), because that is what was asked for and because the two
 * looking identical is the point: one is what the app offers you, the other
 * is what it offers your selection, and they are the same kind of object.
 *
 * WHY THE SPACE IS STILL RESERVED
 *
 * "Make sure it doesn't affect the rest of the page" is the hard part of
 * floating something. Taking the header out of the flow means the first
 * screenful of every page slides up underneath it -- page titles hidden
 * behind the pill, and the top of every table unreachable because scrolling
 * to it puts it under the bar. So the height is measured here and published
 * as `--app-chrome-h`, and the scroll container pads itself by exactly that.
 *
 * Measured rather than hard-coded because this stack is not one fixed height:
 * the pill is 48px on a phone and 56px above `sm`, and a wide arrangement of
 * pinned navigation items can wrap the row. A constant would be right at one
 * width and wrong at the two either side of it -- which is the bug the
 * Library's own CHROME_HEIGHT comment already describes having had once.
 *
 * WHY THE WRAPPER DOES NOT TAKE THE POINTER
 *
 * A fixed, full-width band across the top of every page would swallow clicks
 * across its whole width, including the empty air either side of the pill --
 * so the wrapper is `pointer-events-none` and each bar turns it back on. The
 * page underneath stays clickable everywhere the chrome is not.
 */
export function FloatingHeader() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const publish = () => {
      // The pill is offset from the top of the viewport as well as being
      // tall, and content has to clear both. `getBoundingClientRect().bottom`
      // is that sum directly, and it stays correct if the offset changes.
      const bottom = el.getBoundingClientRect().bottom;
      document.documentElement.style.setProperty("--app-chrome-h", `${Math.ceil(bottom)}px`);
    };

    publish();

    // ResizeObserver rather than a window resize listener: what changes this
    // height is not a window resize at all -- a nav item dragged out of
    // "More" wraps the row while the window sits still.
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    window.addEventListener("resize", publish);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", publish);
    };
  }, []);

  return (
    <div
      ref={ref}
      className="pointer-events-none fixed inset-x-0 top-0 z-40 flex flex-col items-center gap-2 px-3 pt-3"
    >
      <TopNav />
    </div>
  );
}
