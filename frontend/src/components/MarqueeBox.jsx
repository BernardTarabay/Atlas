/**
 * The rubber-band rectangle itself. Driven by lib/useMarqueeSelection, which
 * owns the pointer maths; this only paints what that hook reports.
 *
 * Fixed-position on purpose: the box is drawn in viewport coordinates, so it
 * is never clipped by the scrolling list it is stretched across.
 */
export function MarqueeBox({ rect }) {
  if (!rect) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-50 rounded-sm border border-brand-500 bg-brand-500/15"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      }}
    />
  );
}
