import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ExternalLink, Eye, Download, Pencil, FolderInput, Trash2, Info,
} from "lucide-react";

/**
 * The actions available on a file, in one menu, reachable two ways.
 *
 * WHY THIS EXISTS
 *
 * The row used to carry five always-visible icon buttons and nothing else --
 * so every action had to be a button, every button competed with the filename
 * beside it, and anything that did not fit simply was not offered. A file
 * manager solves this with a context menu, and the reason is not tidiness: it
 * is that the SAME list of actions can hang off a right-click and off an
 * explicit button, so discovering one teaches you the other.
 *
 * OPENED BY: right-clicking a row, or the vertical-dots button on it. Both
 * call the same hook below and render this same component, so the two can
 * never drift apart.
 *
 * POSITIONING
 *
 * Fixed, at the pointer, then nudged back inside the viewport once its real
 * size is known -- a menu opened near the bottom edge would otherwise render
 * with half its items below the fold, which is exactly where "Delete" tends to
 * be. Measured in useLayoutEffect so the correction happens before paint
 * rather than as a visible jump.
 */
export function FileContextMenu({ file, at, actions = {}, onClose }) {
  const ref = useRef(null);
  // The CORRECTED position, or null until this particular opening has been
  // measured. Deliberately not seeded from `at`.
  //
  // It used to be `useState(at)`, and that was a crash rather than a detail.
  // This component is mounted for the whole life of the page (see LibraryPage
  // and FilesPage) so that one menu can serve every row -- which means it
  // first mounts with the menu CLOSED and `at` undefined. `useState` only ever
  // reads its argument on the first render, so `pos` stayed undefined forever,
  // and the first time the menu actually opened, `style={{ left: pos.x }}`
  // threw "Cannot read properties of undefined". The menu never appeared, and
  // because the throw happened during render there was nothing to see: no
  // menu, no error in the UI, nothing. Clicking the dots did nothing at all.
  //
  // Keying off `at` instead also fixes a second, subtler thing: holding the
  // PREVIOUS opening's corrected position across a new one made the menu paint
  // once at the old spot before jumping to the pointer.
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !at) {
      // Closed: forget the last correction so the next opening measures itself
      // rather than inheriting a position from a different row.
      setPos(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      x: Math.min(at.x, window.innerWidth - r.width - pad),
      y: Math.min(at.y, window.innerHeight - r.height - pad),
    });
  }, [at]);

  useEffect(() => {
    if (!at) return undefined;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => e.key === "Escape" && onClose();
    // `mousedown`, not `click`: closing on click would let the same press that
    // opened a different row's menu also close this one, and the menu would
    // flicker instead of moving.
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    // Scrolling the list under a fixed menu leaves it pointing at nothing.
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [at, onClose]);

  if (!at || !file) return null;

  const run = (fn) => (e) => {
    e.stopPropagation();
    onClose();
    fn?.(file);
  };

  // Order is deliberate: the default action first (it is what double-click
  // does, so the menu teaches the shortcut), then the other ways to get at the
  // file, then the ones that change it, then the destructive one -- last, and
  // separated, so it is never adjacent to the thing people click most.
  const items = [
    actions.onOpen && { key: "open", icon: ExternalLink, label: "Open", hint: "double-click", fn: actions.onOpen },
    actions.onPreview && { key: "preview", icon: Eye, label: "Preview", fn: actions.onPreview },
    actions.onDetails && { key: "details", icon: Info, label: "Details", fn: actions.onDetails },
    actions.onDownload && { key: "download", icon: Download, label: "Download", fn: actions.onDownload },
    actions.onRename && { key: "rename", icon: Pencil, label: "Rename", fn: actions.onRename },
    actions.onMove && { key: "move", icon: FolderInput, label: "Move to…", fn: actions.onMove },
  ].filter(Boolean);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${file.filename_current || "file"}`}
      className="fixed z-[60] min-w-[13rem] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-[var(--shadow-overlay)]"
      // Until useLayoutEffect has measured this opening, render at the raw
      // pointer. That is the right position in every case except one near the
      // viewport edge, and the correction lands before paint.
      style={{ left: (pos ?? at).x, top: (pos ?? at).y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <p className="truncate px-3 py-1.5 text-[11px] font-medium text-base-500">
        {file.ai_short_title || file.display_name || file.filename_current}
      </p>
      <div className="my-1 h-px bg-line" />

      {items.map((item) => (
        <button
          key={item.key}
          role="menuitem"
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-base-200 transition-colors hover:bg-row-hover hover:text-base-50"
          onClick={run(item.fn)}
        >
          <item.icon size={14} className="shrink-0 text-base-500" aria-hidden="true" />
          <span className="flex-1">{item.label}</span>
          {item.hint && <span className="text-[10px] text-base-600">{item.hint}</span>}
        </button>
      ))}

      {actions.onDelete && (
        <>
          <div className="my-1 h-px bg-line" />
          <button
            role="menuitem"
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-rose-600 transition-colors hover:bg-rose-50 hover:text-rose-700"
            onClick={run(actions.onDelete)}
          >
            <Trash2 size={14} className="shrink-0" aria-hidden="true" />
            Delete
          </button>
        </>
      )}
    </div>
  );
}

/**
 * State for the menu above. One per page: only one menu can be open at a time,
 * and keeping that in a single place is what guarantees it.
 *
 * `openAt(e, file)` works for both triggers -- a right-click event carries the
 * pointer position, and the dots button passes its own rect so the menu hangs
 * off the button rather than wherever the cursor happened to be.
 */
export function useFileContextMenu() {
  const [state, setState] = useState(null);

  const openAt = useCallback((e, file) => {
    e.preventDefault();
    e.stopPropagation();
    const at = e.currentTarget && e.type === "click"
      ? (() => {
          const r = e.currentTarget.getBoundingClientRect();
          return { x: r.right - 4, y: r.bottom + 4 };
        })()
      : { x: e.clientX, y: e.clientY };
    setState({ file, at });
  }, []);

  const close = useCallback(() => setState(null), []);

  return { menu: state, openAt, close };
}
