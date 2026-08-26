import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, X, Maximize2, Minimize2 } from "lucide-react";

/**
 * A window that floats above the app: drag it by the header, resize it from
 * the bottom-left grip, collapse it to just its title bar, maximise it, or
 * dismiss it entirely. Position and size are remembered per panel id.
 *
 * Exists because some things need to be watched WHILE you work -- background
 * jobs being the obvious one. A dedicated page for those is the wrong shape:
 * you have to leave what you were doing to look, and by the time you get
 * there the thing you wanted to watch has finished.
 *
 * Kept generic rather than baked into the jobs dock so anything else that
 * wants this treatment gets it for free.
 */

const MIN_WIDTH = 300;
const MIN_HEIGHT = 180;
const EDGE_MARGIN = 8;

function loadGeometry(id, fallback) {
  try {
    const raw = localStorage.getItem(`atlas.panel.${id}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

/** Keep a panel on screen after the window is resized or the geometry is
 *  restored from a session with a bigger monitor. */
function clampToViewport(g) {
  const maxX = Math.max(EDGE_MARGIN, window.innerWidth - g.width - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, window.innerHeight - 48 - EDGE_MARGIN);
  return {
    ...g,
    width: Math.min(g.width, Math.max(MIN_WIDTH, window.innerWidth - EDGE_MARGIN * 2)),
    height: Math.min(g.height, Math.max(MIN_HEIGHT, window.innerHeight - EDGE_MARGIN * 2)),
    x: Math.min(Math.max(g.x, EDGE_MARGIN), maxX),
    y: Math.min(Math.max(g.y, EDGE_MARGIN), maxY),
  };
}

export function FloatingPanel({
  id,
  title,
  icon: Icon,
  badge = null,
  onClose,
  children,
  defaultWidth = 420,
  defaultHeight = 340,
}) {
  const [geometry, setGeometry] = useState(() =>
    clampToViewport(
      loadGeometry(id, {
        // Bottom-right by default, clear of the assistant launcher.
        x: Math.max(EDGE_MARGIN, window.innerWidth - defaultWidth - 24),
        y: Math.max(EDGE_MARGIN, window.innerHeight - defaultHeight - 96),
        width: defaultWidth,
        height: defaultHeight,
      })
    )
  );
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const drag = useRef(null);

  useEffect(() => {
    localStorage.setItem(`atlas.panel.${id}`, JSON.stringify(geometry));
  }, [id, geometry]);

  useEffect(() => {
    const onResize = () => setGeometry((g) => clampToViewport(g));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startDrag = useCallback((e, mode) => {
    // Ignore clicks on the header's own buttons.
    if (e.target.closest("button")) return;
    e.preventDefault();
    drag.current = { mode, startX: e.clientX, startY: e.clientY, origin: geometry };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [geometry]);

  const onPointerMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;

    if (d.mode === "move") {
      setGeometry(clampToViewport({ ...d.origin, x: d.origin.x + dx, y: d.origin.y + dy }));
    } else {
      // Resizing from the bottom-LEFT: width grows as the pointer moves
      // left, so x has to move with it or the panel would appear to slide.
      const width = Math.max(MIN_WIDTH, d.origin.width - dx);
      const height = Math.max(MIN_HEIGHT, d.origin.height + dy);
      setGeometry(clampToViewport({
        ...d.origin,
        width,
        height,
        x: d.origin.x + (d.origin.width - width),
      }));
    }
  }, []);

  const endDrag = useCallback((e) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  const style = maximized
    ? { left: EDGE_MARGIN, top: EDGE_MARGIN, width: `calc(100vw - ${EDGE_MARGIN * 2}px)`, height: `calc(100vh - ${EDGE_MARGIN * 2}px)` }
    : { left: geometry.x, top: geometry.y, width: geometry.width, height: collapsed ? undefined : geometry.height };

  return (
    <div
      className="glass-card fixed z-40 flex flex-col overflow-hidden p-0 shadow-2xl"
      style={style}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
    >
      <div
        className="flex shrink-0 cursor-move select-none items-center gap-2 border-b border-line bg-base-900 px-3 py-2"
        onPointerDown={(e) => !maximized && startDrag(e, "move")}
      >
        {Icon && <Icon size={14} className="shrink-0 text-brand-700" />}
        <p className="truncate text-xs font-medium text-base-100">{title}</p>
        {badge}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            className="btn-ghost btn-sm"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand" : "Collapse"}
          >
            <Minus size={13} />
          </button>
          <button
            className="btn-ghost btn-sm"
            onClick={() => setMaximized((m) => !m)}
            title={maximized ? "Restore" : "Maximize"}
          >
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button className="btn-ghost btn-sm" onClick={onClose} title="Close">
            <X size={13} />
          </button>
        </div>
      </div>

      {!collapsed && <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>}

      {/* Bottom-LEFT grip: the panel lives in the bottom-right corner by
          default, so a bottom-right handle would sit off the edge of the
          screen exactly where it is least reachable. */}
      {!collapsed && !maximized && (
        <div
          className="absolute bottom-0 left-0 h-4 w-4 cursor-nesw-resize"
          onPointerDown={(e) => startDrag(e, "resize")}
          title="Drag to resize"
        >
          <svg viewBox="0 0 16 16" className="h-full w-full text-base-600">
            <path d="M2 14 L14 14 M2 14 L2 2" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>
  );
}
