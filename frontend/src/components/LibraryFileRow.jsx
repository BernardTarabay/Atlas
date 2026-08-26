import {
  Sparkles, CheckSquare, Square, MoreVertical,
  Loader2, AlertTriangle, Archive, Cloud, Lock,
} from "lucide-react";
import { DocumentDateInline, LocationLabel } from "./DocumentDate";
import { SearchSnippet, MatchReason } from "./SearchSnippet";
import { fileTypeOf } from "../lib/fileType";
import { formatBytes } from "../utils/format";

/**
 * One file in the Library's file panel.
 *
 * Extracted from LibraryPage so the panel can be windowed: react-window asks
 * for "row N" and needs a component to render it, which a `.map()` inside the
 * page cannot provide.
 *
 * ROW HEIGHT IS MEASURED, NOT ASSUMED. These rows are genuinely variable --
 * a search hit carries a snippet and a match reason, a plain listing does not,
 * and a long path wraps. The list is given `useDynamicRowHeight`, which
 * observes the rendered rows (DynamicRowHeight.observeRowElements) and caches
 * what they actually measure. Hard-coding a height would either clip snippets
 * or leave a gap under every plain row.
 *
 * THE ROW IS BUILT AS ONE OBJECT, IN ONE ORDER
 *
 *   type tile -> name -> origin -> facts -> state -> actions
 *
 * That order is the order the questions get asked in ("what is it / what is it
 * called / where did it come from / how big, how old / is anything wrong with
 * it / what can I do"), and each answer gets exactly one level of emphasis.
 *
 * What changed, and why:
 *
 *   - EVERY file used to draw the same grey document glyph, so a contract, a
 *     spreadsheet and a photograph were the same shape. The type tile is the
 *     single biggest difference when scanning a thousand rows, because the eye
 *     sorts by shape and colour long before it reads any words (lib/fileType).
 *
 *   - The name now clearly outranks everything under it. Previously the title,
 *     the path and the metadata line were all within a step of each other in
 *     weight, so nothing led and the row read as a paragraph.
 *
 *   - SIZE was not shown at all, which is a strange omission in a file
 *     inventory -- it is one of the three facts people actually sort a folder
 *     by, alongside name and date.
 *
 *   - The five action buttons were painted on every row at all times. At fifty
 *     rows that is two hundred and fifty icons competing with the filenames
 *     they sit beside. They now appear on hover, and -- importantly --
 *     `focus-within` keeps them reachable by keyboard rather than trading one
 *     kind of user for another.
 */

/** Only the states worth interrupting a scan for. */
function StateChips({ file }) {
  const chips = [];
  const state = file.pipeline_state;
  const failed = file.failure_reason || state === "failed";

  if (failed) {
    chips.push({ key: "failed", cls: "badge-rose", icon: AlertTriangle, label: "Needs attention" });
  } else if (state && !["ready", "complete", "completed", "filed"].includes(state)) {
    // Anything mid-pipeline. Named by what it means to the person waiting
    // rather than by the stage name, which is an implementation detail.
    chips.push({ key: "processing", cls: "badge-blue", icon: Loader2, label: "Processing", spin: true });
  }
  if (file.archived_at) chips.push({ key: "archived", cls: "badge-neutral", icon: Archive, label: "Archived" });
  if (file.is_cloud_placeholder) {
    chips.push({ key: "cloud", cls: "badge-blue", icon: Cloud, label: "Cloud only" });
  }
  if (file.location_is_read_only) {
    chips.push({ key: "ro", cls: "badge-neutral", icon: Lock, label: "Read-only" });
  }

  if (!chips.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span key={c.key} className={c.cls}>
          <c.icon size={10} className={c.spin ? "animate-spin" : ""} aria-hidden="true" />
          {c.label}
        </span>
      ))}
    </div>
  );
}

export function LibraryFileRow({
  index, style,
  documents, selectedFileIds, cursor, canMove, canModify,
  onSelectRow, onToggleSelect, onOpen, onContextMenu,
}) {
  const d = documents[index];
  if (!d) return null;
  const isSelected = selectedFileIds.has(d.id);
  const isCursor = index === cursor;
  const type = fileTypeOf(d);
  const TypeIcon = type.icon;

  // The name people mean, and the name on disk. When AI has proposed a better
  // title the original still has to be visible -- it is what the file is
  // actually called, and hiding it would make the row unverifiable.
  const primary = d.ai_short_title || d.display_name || d.filename_current;
  const secondary = d.ai_short_title ? (d.display_name || d.filename_current) : d.current_path;

  return (
    <div style={style} className="pb-1.5">
      <div
            // The marquee's contract: anything carrying data-select-id inside
            // the list container can be rubber-banded (lib/useMarqueeSelection).
            data-select-id={d.id}
            // Draggable straight onto a folder in the tree to reclassify.
            // The custom MIME type keeps this from being interpreted
            // as a text drop by anything else on the page.
            draggable={canModify}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/dms-file-id", d.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            className={
              "group/row relative flex items-start gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors " +
              (canModify ? "cursor-grab active:cursor-grabbing " : "cursor-pointer ") +
              (isSelected
                // EXACTLY the tables' selection, via the same class they use
                // (.row-selected in index.css): a quiet fill and a 2px blue
                // rule down the left edge, nothing more.
                //
                // This used to add `border-brand-300 bg-brand-50` on top of
                // that rule, which turned a marked row into a fully outlined,
                // blue-tinted card -- much louder than the same file looks in
                // the Files table, and different enough that the two views did
                // not read as the same application. The border stays neutral
                // so only ONE thing changes when you pick a row.
                ? "border-line row-selected"
                : isCursor
                  // The keyboard cursor is a ring, not a fill: it says
                  // "you are here", which is a different statement from
                  // "this is selected", and conflating them makes j/k
                  // feel like it is ticking things.
                  ? "border-line-strong bg-surface ring-1 ring-inset ring-brand-200"
                  : "border-line bg-surface hover:border-line-strong hover:bg-row-hover")
            }
            // SINGLE CLICK SELECTS. DOUBLE CLICK OPENS.
            //
            // Single click used to open the detail modal, and that is why
            // double-click never worked: the modal mounted over the row after
            // the first click, so the second click landed on the modal and the
            // dblclick event never reached the row at all. Selecting is a
            // cheap, reversible thing to do on click; opening a modal is not.
            onClick={(e) => onSelectRow(index, d, e)}
            onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpen?.(d); }}
            // Right-click opens the same menu the dots button does. The row is
            // selected first, because acting on something you have not visibly
            // selected is how a context menu deletes the wrong file.
            onContextMenu={(e) => onContextMenu?.(e, d, index)}
          >
            {canMove && (
              <button
                className="mt-0.5 shrink-0 p-0.5 text-base-600 transition-colors hover:text-brand-700"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect(index, { shiftKey: e.shiftKey });
                }}
                title={isSelected ? "Deselect" : "Select (shift-click for a range)"}
                aria-pressed={isSelected}
              >
                {isSelected
                  ? <CheckSquare size={15} className="text-brand-600" />
                  : <Square size={15} />}
              </button>
            )}

            {/* WHAT IT IS. A tinted tile rather than a bare glyph: at row
                height a filled shape is findable in peripheral vision, where a
                thin outline icon is not. */}
            <div
              className={`mt-px flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ${type.bg} ${type.ring}`}
              title={`${type.label}${type.ext ? ` · .${type.ext}` : ""}`}
            >
              <TypeIcon size={15} className={type.fg} aria-hidden="true" />
            </div>

            <div className="min-w-0 flex-1">
              {/* WHAT IT IS CALLED. The one dominant element in the row. */}
              <p className="truncate font-medium text-base-100">{primary}</p>

              {/* WHERE IT CAME FROM. Quieter, and monospaced when it is a path
                  so directory structure lines up down the list. */}
              {secondary && (
                <p
                  className={
                    "truncate text-xs text-base-500 " +
                    (d.ai_short_title ? "flex items-center gap-1" : "font-mono")
                  }
                  title={secondary}
                >
                  {d.ai_short_title && (
                    <Sparkles size={10} className="shrink-0 text-brand-600" aria-hidden="true" />
                  )}
                  {secondary}
                </p>
              )}

              {/* THE FACTS. One line, tabular figures, separated by middots so
                  the eye can jump between columns of them down the list. */}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] tabular text-base-500">
                <span className="uppercase tracking-wide text-base-600">{type.ext || type.label}</span>
                {d.size_bytes != null && (
                  <>
                    <span aria-hidden="true" className="text-base-700">·</span>
                    <span>{formatBytes(d.size_bytes)}</span>
                  </>
                )}
                <span aria-hidden="true" className="text-base-700">·</span>
                <DocumentDateInline date={d.document_date} source={d.document_date_source} />
                <span aria-hidden="true" className="text-base-700">·</span>
                <LocationLabel name={d.location_name} isReadOnly={d.location_is_read_only} />
              </div>

              <StateChips file={d} />
              <SearchSnippet snippet={d.snippet} />
              <MatchReason file={d} />
            </div>

            {/* ONE BUTTON, NOT FIVE.
                Every action now lives in the context menu, so the row carries
                a single affordance instead of a row of icons competing with
                the filename. Always visible rather than hover-revealed: it is
                the only way to reach the actions with a mouse without knowing
                that right-click works, and a control you have to hover to
                discover is not discoverable. */}
            <button
              className="mt-0.5 shrink-0 rounded-lg p-1 text-base-500 transition-colors hover:bg-base-850 hover:text-base-100"
              onClick={(e) => onContextMenu?.(e, d, index)}
              title="Actions"
              aria-label={`Actions for ${primary}`}
              aria-haspopup="menu"
            >
              <MoreVertical size={16} />
            </button>
          </div>
    </div>
  );
}
