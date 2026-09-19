import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List } from "react-window";
import { ChevronRight, Folder, FolderOpen, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import {
  buildTree, buildTreeIndex, matchSubjects, flattenVisible, ancestorsOf, MAX_FILTER_ROWS,
} from "../lib/subjectTree";

/**
 * The Library's folder pane, windowed.
 *
 * WHY THIS IS NOT A RECURSIVE TREE ANY MORE
 *
 * It was, and it worked fine on a demo taxonomy. At the size this is actually
 * for -- someone pointing Atlas at a drive with tens of thousands of folders --
 * the recursion mounted a React component per visible node, which measured at
 * 13,706 mounted nodes on a synthetic 55,000-folder tree
 * (scripts/bench-subject-tree.mjs). That is not a slow render, it is a page
 * that stops responding.
 *
 * So the tree is flattened to an array of visible rows and handed to
 * react-window, which mounts only what fits on screen (~40 rows) no matter how
 * large the library is. The shaping lives in lib/subjectTree.js as plain
 * functions so it can be measured outside a browser.
 *
 * THE CONSEQUENCE THAT DRIVES THE REST OF THIS FILE: a windowed list unmounts
 * rows that scroll out of view. Anything a row remembers is therefore lost the
 * moment you scroll past it, so the open/closed state of every branch has to
 * live HERE, above the list, as one Set of ids. That is not incidental
 * bookkeeping -- it is the whole reason the row component is a leaf that
 * renders one line and nothing else.
 */

// 38, not 34. The pane is windowed, so this constant IS the row height --
// changing the class alone would leave the list measuring one thing and
// painting another. Four more pixels is the difference between a folder list
// that reads as a dense config panel and one that reads as somewhere you
// browse; at tree depth the rows also carry an indent, an icon and a count,
// and 34 left those touching.
const ROW_HEIGHT = 38;
const FILTER_DEBOUNCE_MS = 150;

/** Marks the matched substring inside a folder name. */
function HighlightedName({ name, term }) {
  const needle = (term || "").trim();
  if (!needle) return <span className="truncate">{name}</span>;

  const at = name.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return <span className="truncate">{name}</span>;

  return (
    <span className="truncate">
      {name.slice(0, at)}
      <mark className="rounded bg-brand-500/30 px-0.5 text-brand-700">{name.slice(at, at + needle.length)}</mark>
      {name.slice(at + needle.length)}
    </span>
  );
}

function SubjectCount({ node }) {
  const direct = node.fileCount ?? 0;
  const total = node.totalFileCount ?? direct;
  if (!total) return null;
  return (
    <span className="ml-auto shrink-0 pl-2 tabular-nums text-[11px] text-base-500" title={
      total === direct ? `${direct} document(s)` : `${direct} here, ${total} including subfolders`
    }>
      {total.toLocaleString()}
    </span>
  );
}

/**
 * One row. A leaf by construction: it renders a single line and holds no state
 * of its own, because react-window will unmount it as soon as it scrolls away.
 */
function TreeRow({
  index, style, rows, selectedId, selectedSubjectIds, term, canManage,
  onToggle, onSelect, onAddChild, onEdit, onDelete,
  onDropFile, onDropSubject, onSubjectDragStart, onSubjectDragEnd, draggingSubjectId,
}) {
  const row = rows[index];
  const [dropTarget, setDropTarget] = useState(false);
  if (!row) return null;
  const { node, depth, hasChildren, expanded } = row;

  const has = (e, type) => [...e.dataTransfer.types].includes(type);
  const canDragFolders = Boolean(canManage && onDropSubject);
  // Ctrl-picked, as opposed to `selectedId` which is the folder being viewed.
  const picked = Boolean(selectedSubjectIds?.has?.(node.id));

  /**
   * A folder will not accept itself. Its own DESCENDANTS are refused by the
   * server as well, and deliberately are NOT rejected here: a windowed row does
   * not know the shape of the branch in flight, and guessing would either allow
   * a bad drop or block a good one. The server answers with both folder names,
   * which is more use than a cursor that silently declines.
   */
  const rejectsSubject = draggingSubjectId && draggingSubjectId === node.id;

  return (
    <div style={style} className="px-1">
      <div
        draggable={canDragFolders}
        onDragStart={(e) => {
          if (!canDragFolders) return;
          e.dataTransfer.setData("text/dms-subject-id", node.id);
          e.dataTransfer.effectAllowed = "move";
          onSubjectDragStart?.(node.id);
        }}
        onDragEnd={() => onSubjectDragEnd?.()}
        onDragOver={(e) => {
          if (has(e, "text/dms-file-id") && onDropFile) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(true);
          } else if (has(e, "text/dms-subject-id") && onDropSubject && !rejectsSubject) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(true);
          }
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(e) => {
          setDropTarget(false);
          if (has(e, "text/dms-file-id") && onDropFile) {
            e.preventDefault();
            const fileId = e.dataTransfer.getData("text/dms-file-id");
            if (fileId) onDropFile(fileId, node);
            return;
          }
          if (has(e, "text/dms-subject-id") && onDropSubject && !rejectsSubject) {
            e.preventDefault();
            const subjectId = e.dataTransfer.getData("text/dms-subject-id");
            if (subjectId) onDropSubject(subjectId, node);
          }
        }}
        data-select-id={node.id}
        className={`group relative flex h-[38px] w-full items-center gap-1 overflow-hidden rounded-lg pr-1 text-left text-sm transition-colors
          ${dropTarget ? "bg-brand-500/25 ring-1 ring-inset ring-brand-400/60" : ""}
          ${draggingSubjectId === node.id ? "opacity-40" : ""}
          ${canDragFolders ? "cursor-grab active:cursor-grabbing" : ""}
          ${selectedId === node.id
            ? "bg-brand-50 font-medium text-brand-700 shadow-[inset_2px_0_0_var(--color-brand-500)]"
            : picked
              // Picked-but-not-open: the same blue language as a selected
              // file row, so a mixed selection of files and folders looks
              // like one selection rather than two systems.
              ? "bg-brand-50/70 text-brand-700 ring-1 ring-inset ring-brand-200"
              : "text-base-300 hover:bg-base-850"}`}
      >
        {/* Its own control, not part of the select button -- expanding a branch
            and choosing a folder are different intentions, and merging them
            means you cannot look inside a folder without navigating to it. */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
            className="shrink-0 rounded p-1 text-base-500 hover:text-base-200"
            style={{ marginLeft: 2 + depth * 10 }}
          >
            <ChevronRight size={12} className={"transition-transform " + (expanded ? "rotate-90" : "")} />
          </button>
        ) : (
          <span aria-hidden="true" className="shrink-0" style={{ marginLeft: 2 + depth * 10, width: 18 }} />
        )}
        <button
          type="button"
          // The event is passed through so the page can tell a plain click
          // (navigate into the folder) from a ctrl-click (add it to the
          // selection) -- see LibraryPage.
          onClick={(e) => onSelect(node, e)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
        >
          {/* Folders get a glyph of their own. It is the amber every file
              manager uses for a container, which is worth borrowing: it means
              "folder" to people before they have read a word of the UI, and it
              is deliberately a different hue from every file-type tint in
              lib/fileType so a folder can never be mistaken for a file. */}
          {expanded && hasChildren
            ? <FolderOpen size={15} className="shrink-0 text-amber-500" aria-hidden="true" />
            : <Folder size={15} className="shrink-0 text-amber-500" aria-hidden="true" />}
          <HighlightedName name={node.name} term={term} />
          <SubjectCount node={node} />
        </button>
        {/* THE ROW ACTIONS FLOAT OVER THE NAME, THEY DO NOT SIT BESIDE IT.
            These were `opacity-0 group-hover:opacity-100`, which hides a
            control without giving its width back -- three buttons' worth of
            row, ~70px, was reserved on every folder for something visible on
            one of them at a time. Combined with the indent and the chevron
            that left a nested folder perhaps forty pixels to spell its name
            in, so anything with children truncated to nothing.
            Absolutely positioned instead: invisible means zero width now, and
            the fade behind them keeps a long name from running under the
            buttons when they do appear. */}
        {canManage && (
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
            {/* Blurred rather than filled with a colour: a row can be neutral,
                hovered, picked or open, and a hard-coded background would be
                wrong on three of those four. */}
            <div className="flex shrink-0 items-center gap-0.5 rounded-lg px-0.5 backdrop-blur-sm">
            <button type="button" className="btn-ghost btn-sm" onClick={() => onAddChild(node)}
              title="Add a folder inside this one" aria-label={`Add a folder inside ${node.name}`}>
              <Plus size={12} />
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => onEdit(node)}
              title="Rename" aria-label={`Rename ${node.name}`}>
              <Pencil size={12} />
            </button>
            <button type="button" className="btn-ghost btn-sm text-rose-600 hover:text-rose-700"
              onClick={() => onDelete(node)} title="Delete" aria-label={`Delete ${node.name}`}>
              <Trash2 size={12} />
            </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function SubjectTreePane({
  selectedSubjectIds,
  subjects, selectedId, onSelect, canManage,
  onAddChild, onEdit, onDelete, onDropFile, onDropSubject, header,
}) {
  const [term, setTerm] = useState("");
  const [debouncedTerm, setDebouncedTerm] = useState("");
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  // Which folder is in flight, so its own row can refuse itself and dim.
  const [draggingSubjectId, setDraggingSubjectId] = useState(null);
  const [rootDropActive, setRootDropActive] = useState(false);
  const listRef = useRef(null);

  /**
   * HOW TALL THE LIST IS, MEASURED RATHER THAN CALCULATED.
   *
   * This was `h-[calc(100%-2.75rem)]` -- the pane's height minus a hand-tuned
   * guess at how tall the header above it is. Then Archive and Trash were added
   * to that header, taking it from roughly 44px to roughly 110px, and the list
   * box stayed 66px too tall: the folders ran off the bottom of the card.
   *
   * LibraryPage's CHROME_HEIGHT comment already records this exact failure --
   * "three separate hand-tuned numbers ... so adding the overview strip above
   * them silently invalidated all three at once". A constant that encodes the
   * height of something else is wrong the moment that something else changes,
   * and it fails silently, because nothing anywhere asserts the two agree.
   *
   * So the wrapper reports its own height and the list uses it. Adding another
   * pinned destination tomorrow costs nothing.
   */
  const listWrapRef = useRef(null);
  const [availableHeight, setAvailableHeight] = useState(0);
  useEffect(() => {
    const el = listWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setAvailableHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Debounced, because the search is the one interaction that touches every
   * folder. Filtering 55,000 names is single-digit milliseconds, but a term
   * matching most of the tree costs ~10 ms to resolve, and running that on
   * every keypress of a fast typist is how an input starts feeling sticky.
   */
  useEffect(() => {
    const id = setTimeout(() => setDebouncedTerm(term), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [term]);

  const flat = useMemo(() => subjects || [], [subjects]);
  const roots = useMemo(() => buildTree(flat), [flat]);
  // Built once per tree, not per keystroke -- this is the pre-lowercased name
  // list, and rebuilding it per keystroke was most of the old cost.
  const index = useMemo(() => buildTreeIndex(flat), [flat]);

  // Top level opens by default: it shows the shape of the library. Opening all
  // of it just shows a list, which is what the tree exists to avoid.
  useEffect(() => {
    setExpandedIds((current) => (current.size === 0 && roots.length ? new Set(roots.map((r) => r.id)) : current));
  }, [roots]);

  const filtering = debouncedTerm.trim().length > 0;
  const { matched, keep } = useMemo(
    () => (filtering ? matchSubjects(index, debouncedTerm) : { matched: new Set(), keep: new Set() }),
    [index, debouncedTerm, filtering]
  );

  const { rows, truncated } = useMemo(
    () => flattenVisible(roots, { expandedIds, matched, keep, filtering }),
    [roots, expandedIds, matched, keep, filtering]
  );

  const toggle = useCallback((id) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * JUMP TO A FOLDER, rather than hunting for it by expanding.
   *
   * Selecting a folder anywhere else in the app -- a search result, the
   * assistant locating a file -- has to be able to reveal it here. In a tree of
   * this size the folder is usually inside several collapsed branches and
   * nowhere near the current scroll position, so revealing it means opening
   * every ancestor AND scrolling the windowed list to it. Doing only the first
   * leaves the user looking at an unchanged screen.
   */
  useEffect(() => {
    if (!selectedId || filtering) return;
    const ancestors = ancestorsOf(index, selectedId);
    if (ancestors.length) {
      setExpandedIds((current) => {
        if (ancestors.every((id) => current.has(id))) return current; // already open
        const next = new Set(current);
        for (const id of ancestors) next.add(id);
        return next;
      });
    }
  }, [selectedId, index, filtering]);

  // Scroll after the rows have been recomputed with the ancestors opened.
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const at = rows.findIndex((r) => r.node.id === selectedId);
    if (at >= 0) listRef.current.scrollToRow({ index: at, align: "auto", behavior: "auto" });
  }, [selectedId, rows]);

  // Must be a stable callback: react-window calls this during render and
  // cannot memoize an inline function.
  const rowKey = useCallback((index) => rows[index]?.node.id ?? index, [rows]);

  /**
   * The list is as tall as its contents, up to the space available.
   *
   * Both directions matter. Six folders should not sit at the top of a
   * viewport-tall empty box -- the container should be six rows tall. Forty-six
   * thousand cannot be, so past that point the list stops growing and scrolls
   * inside itself, which is what makes windowing possible at all.
   *
   * Before the observer has reported (first paint), fall back to the content
   * height: too tall for one frame is better than a list of height zero, which
   * is what a `0` fallback would render.
   */
  const contentHeight = rows.length * ROW_HEIGHT;
  const listHeight = availableHeight > 0 ? Math.min(contentHeight, availableHeight) : contentHeight;

  const rowProps = useMemo(
    () => ({
      rows, selectedId, selectedSubjectIds, term: debouncedTerm, canManage,
      onToggle: toggle, onSelect, onAddChild, onEdit, onDelete,
      onDropFile, onDropSubject,
      onSubjectDragStart: setDraggingSubjectId,
      onSubjectDragEnd: () => setDraggingSubjectId(null),
      draggingSubjectId,
    }),
    [rows, selectedId, selectedSubjectIds, debouncedTerm, canManage, toggle, onSelect, onAddChild, onEdit, onDelete,
     onDropFile, onDropSubject, draggingSubjectId]
  );

  return (
    <>
      <div className="border-b border-line p-3">
        {/* Finding a FOLDER by name, which is a different job from finding a
            document -- so it is a small input next to the thing it affects,
            not the prominent search at the top of the page. */}
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-base-500" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Find a folder…"
            aria-label="Find a folder by name"
            className="input-field w-full py-1.5 pl-8 pr-8 text-xs"
          />
          {term && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-base-500 hover:text-base-200"
              onClick={() => setTerm("")}
              title="Clear"
            >
              <X size={13} />
            </button>
          )}
        </div>
        {filtering && rows.length === 0 && (
          <p className="mt-2 text-xs text-base-500">No folder matches “{debouncedTerm}”.</p>
        )}
        {/* The cap is reported, never silently applied. "Showing 2,000" with no
            note would read as "you only have 2,000 folders matching", which is
            a different and wrong statement. */}
        {truncated && (
          <p className="mt-2 text-xs text-amber-700/90">
            Showing the first {MAX_FILTER_ROWS.toLocaleString()} of {matched.size.toLocaleString()} matches — keep typing to narrow it.
          </p>
        )}
      </div>

      {/* `lg:pb-10` leaves room for the Library's collapse button, which is
          absolutely positioned over the bottom-left of this pane. Without it
          the last folder in a long list sits underneath the button and cannot
          be clicked -- a dead row at the bottom of the tree with no visible
          cause. */}
      <div className="flex min-h-0 flex-1 flex-col p-3 pt-2 lg:pb-10">
        {/* The header is whatever it is -- Unfiled, Archive, Trash, and
            whatever gets pinned next. It sizes itself and the list takes what
            is left, so neither has to know the other's height. */}
        <div className="shrink-0">{header}</div>
        <div ref={listWrapRef} className="min-h-0 flex-1 overflow-hidden">
          {rows.length > 0 && (
            <List
              listRef={listRef}
              rowComponent={TreeRow}
              rowCount={rows.length}
              rowHeight={ROW_HEIGHT}
              rowProps={rowProps}
              // (index, rowProps) -- two positional arguments, not an object.
              // Keying by folder id rather than by index is what stops a row's
              // drop-target state from sticking to a position when the list is
              // filtered and different folders occupy the same slots.
              rowKey={rowKey}
              style={{ height: listHeight }}
              overscanCount={8}
            />
          )}
          {!filtering && rows.length === 0 && (
            <p className="px-2 text-xs text-base-500">No folders yet. Create one, or ask the assistant to set up a structure.</p>
          )}
        </div>

        {/* MOVING A FOLDER BACK OUT.
            Dragging INTO a folder nests it; without a target that means "not
            inside anything", a folder can be nested but never un-nested by
            dragging, and the gesture is only half there. This strip is that
            target -- it only appears while a folder is actually in flight, so
            it costs no space the rest of the time. */}
        {draggingSubjectId && onDropSubject && (
          <div
            /* shrink-0: it is an affordance, not content -- it must keep its
               height and let the list give up space instead. */
            onDragOver={(e) => {
              if (![...e.dataTransfer.types].includes("text/dms-subject-id")) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setRootDropActive(true);
            }}
            onDragLeave={() => setRootDropActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setRootDropActive(false);
              const subjectId = e.dataTransfer.getData("text/dms-subject-id");
              setDraggingSubjectId(null);
              if (subjectId) onDropSubject(subjectId, null);
            }}
            className={
              "mt-2 shrink-0 rounded-lg border border-dashed px-3 py-2 text-center text-xs transition-colors " +
              (rootDropActive
                ? "border-brand-400/70 bg-brand-500/15 text-brand-700"
                : "border-line-strong text-base-500")
            }
          >
            Drop here to move it to the top level
          </div>
        )}
      </div>
    </>
  );
}
