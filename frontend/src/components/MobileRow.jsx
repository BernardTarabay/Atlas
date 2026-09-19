import { Check, Folder, ChevronRight } from "lucide-react";
import { useRowGestures } from "../lib/useRowGestures";
import { fileTypeOf } from "../lib/fileType";
import { HighlightedText } from "./HighlightedText";

/**
 * One touchable row -- a file or a folder -- in the mobile Library.
 *
 * THE INTERACTION CONTRACT, WHICH IS THE WHOLE POINT
 *
 *   tap                  open the file / enter the folder
 *   tap in select mode   add or remove this row from the selection
 *   long press           enter select mode with this row selected
 *   swipe left           reveal the destructive tray (archive, trash)
 *   swipe right          reveal the constructive tray (select, move)
 *   vertical drag        nothing; the list scrolls
 *
 * A FOLDER IS NOT A SPECIAL CASE. It uses this same component, the same
 * selection system and the same trays, because "select three folders and move
 * them" is an ordinary thing to want and an interface that can only select
 * files makes it impossible. The only difference is what a tap does.
 *
 * WHY THE TRAYS ARE BEHIND THE ROW RATHER THAN INSIDE IT
 *
 * The row slides over a fixed layer. That is what makes the gesture feel
 * physical -- the actions are already there and the row is uncovering them,
 * rather than a menu appearing because a threshold was crossed. It also means
 * the buttons are real buttons at their final size the whole time, so a
 * half-open tray is still tappable instead of being a sliver.
 */

const TRAY_BUTTON_PX = 76;

function Tray({ actions, side }) {
  if (!actions.length) return null;
  return (
    <div
      className={`absolute inset-y-0 flex ${side === "right" ? "right-0" : "left-0"}`}
      aria-hidden="true"
    >
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          // pointerdown, not click: the row above is swallowing pointer events
          // for the gesture, and waiting for a synthesised click here loses the
          // first tap often enough to feel unreliable.
          onPointerDown={(e) => { e.stopPropagation(); a.onSelect(); }}
          style={{ width: TRAY_BUTTON_PX }}
          className={`flex flex-col items-center justify-center gap-1 text-[11px] font-medium text-white ${a.className}`}
        >
          <a.icon size={18} aria-hidden="true" />
          {a.label}
        </button>
      ))}
    </div>
  );
}

export function MobileRow({
  item,                 // { id, name, secondary, isFolder, ... }
  query = "",
  selected = false,
  selectionMode = false,
  onActivate,           // tap: open file / enter folder
  onToggle,             // tap in selection mode, or the Select tray action
  onLongPress,
  leftActions = [],     // revealed by swiping RIGHT
  rightActions = [],    // revealed by swiping LEFT
  meta = null,
}) {
  const leftWidth = leftActions.length * TRAY_BUTTON_PX;
  const rightWidth = rightActions.length * TRAY_BUTTON_PX;

  const { offset, dragging, close, handlers } = useRowGestures({
    leftWidth,
    rightWidth,
    onTap: () => (selectionMode ? onToggle?.() : onActivate?.()),
    onLongPress: () => onLongPress?.(),
  });

  const type = item.isFolder ? null : fileTypeOf(item);
  const Icon = item.isFolder ? Folder : type.icon;

  // Wrap tray actions so the row shuts itself afterwards -- leaving a tray
  // hanging open over a row that has just been archived is confusing about
  // whether the action happened.
  const wrap = (actions) => actions.map((a) => ({ ...a, onSelect: () => { close(); a.onSelect(); } }));

  return (
    <div className="relative overflow-hidden bg-surface">
      <Tray actions={wrap(leftActions)} side="left" />
      <Tray actions={wrap(rightActions)} side="right" />

      <div
        {...handlers}
        role="button"
        tabIndex={0}
        aria-label={item.name}
        aria-pressed={selectionMode ? selected : undefined}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          if (selectionMode) onToggle?.();
          else onActivate?.();
        }}
        style={{
          transform: `translateX(${offset}px)`,
          // No transition WHILE dragging or the row lags the finger; a short
          // one on release so it settles rather than jumping.
          transition: dragging ? "none" : "transform 180ms cubic-bezier(0.2,0,0,1)",
          // Tells the browser this element owns horizontal movement and the
          // page owns vertical -- without it Chrome claims the gesture before
          // any handler runs.
          touchAction: "pan-y",
        }}
        className={
          "relative flex min-h-[64px] w-full items-center gap-3 px-4 py-2.5 text-left " +
          (selected ? "bg-row-selected" : "bg-surface")
        }
      >
        {/* The selection affordance replaces the type icon rather than sitting
            beside it. A row cannot be both "a PDF" and "chosen" in the same
            glance, and the tick is the more urgent fact while selecting. */}
        <div
          className={
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 transition-colors " +
            (selected
              ? "bg-brand-600 text-white ring-brand-600"
              : item.isFolder
                ? "bg-amber-500/15 text-amber-600 ring-amber-500/25"
                : `${type.bg} ${type.fg} ${type.ring}`)
          }
        >
          {selected ? <Check size={18} aria-hidden="true" /> : <Icon size={18} aria-hidden="true" />}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium leading-tight text-base-100">
            <HighlightedText text={item.name} query={query} />
          </p>
          {item.secondary && (
            <p className="mt-0.5 truncate text-[13px] leading-tight text-base-400">
              <HighlightedText text={item.secondary} query={query} />
            </p>
          )}
          {meta && <div className="mt-1 flex items-center gap-2 text-[11px] text-base-500">{meta}</div>}
        </div>

        {item.isFolder && !selectionMode && (
          <ChevronRight size={16} className="shrink-0 text-base-500" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

export { TRAY_BUTTON_PX };
