import { createPortal } from "react-dom";

/**
 * Render children at the end of <body>, outside whatever ancestor they were
 * written inside.
 *
 * WHY THIS IS NOT OPTIONAL DECORATION
 *
 * `position: fixed` is famously "relative to the viewport" and famously not,
 * once any ancestor creates a containing block. `transform`, `filter`,
 * `perspective`, `contain` and -- the one that bit this app --
 * `backdrop-filter` all do.
 *
 * The navigation drawer was written inside <header>, which carries
 * `backdrop-blur-xl`. So `fixed inset-y-0 right-0` did not mean "full height of
 * the screen, pinned right"; it meant "full height of the 56-pixel header".
 * Tapping the menu button on a phone opened a drawer the height of the header
 * bar and immediately clipped -- which reads, correctly, as "nothing happens".
 *
 * The fix is not to remove the blur. It is to stop overlays caring what they
 * were written next to. Anything that must position against the VIEWPORT --
 * drawers, sheets, context menus, dialogs -- renders through here, and then no
 * future ancestor's styling can silently move it.
 */
export function Portal({ children }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
