import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive as ArchiveIcon, Trash2, FolderInput, CheckSquare, X, MoreVertical, Eye, Share2,
} from "lucide-react";
import { MobileRow } from "./MobileRow";

/**
 * The Library, as a phone actually wants it.
 *
 * NOT THE DESKTOP LIST AT A NARROWER WIDTH
 *
 * The desktop Library is built around a pointer: a folder tree in one column, a
 * file list in another, hover-revealed row actions, double-click to open,
 * ctrl-click to add to a selection. Every one of those has no touch equivalent,
 * and the honest consequence is that shrinking it produces a screen where files
 * cannot be opened and cannot be selected -- which is exactly what it produced.
 *
 * So this is a different interaction model over the same data:
 *
 *   ONE LIST          folders first, then files, in a single vertical column.
 *                     A tree with disclosure arrows is a pointer control; on a
 *                     phone you navigate INTO a folder and come back out.
 *   TAP TO ACT        open the file, enter the folder. No double-tap anywhere:
 *                     it is undiscoverable, it fights the browser's own
 *                     double-tap-to-zoom, and there is no second click to
 *                     "confirm" anything with.
 *   LONG PRESS        the only way into selection mode, and the way every
 *                     phone user already expects to get there.
 *   SWIPE             the actions that were hover-revealed on desktop.
 *
 * SELECTION IS ONE SYSTEM FOR BOTH KINDS
 *
 * Folders and files select together and act together. The previous behaviour --
 * select-all then deselect what you did not want -- is not a selection model,
 * it is the absence of one.
 */
export function MobileLibrary({
  folders = [],
  files = [],
  query = "",
  loading = false,
  emptyMessage = "Nothing here yet.",
  selectedFileIds,
  selectedFolderIds,
  onToggleFile,
  onToggleFolder,
  onEnterFolder,
  onOpenFile,
  onPreviewFile,
  onClearSelection,
  onSelectAll,
  onMove,
  onArchive,
  onTrash,
  onFileMenu,
  onShare,
  canModify = true,
  canDelete = true,
  header = null,
}) {
  // Selection mode is a MODE, not merely "something is selected". It has to
  // survive deselecting the last item -- otherwise removing your final tick
  // silently re-arms tap-to-open and the next tap launches a file.
  const [selectionMode, setSelectionMode] = useState(false);
  const selectedCount = selectedFileIds.size + selectedFolderIds.size;

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    onClearSelection?.();
  }, [onClearSelection]);

  // BACK LEAVES SELECTION BEFORE IT LEAVES THE SCREEN.
  //
  // On a phone, back is the universal "undo this state" gesture, and the state
  // a person most wants out of is a selection they did not mean to start. If
  // back navigated away instead, an accidental long press would cost them
  // their place in the folder tree.
  useEffect(() => {
    if (!selectionMode) return undefined;
    const onPop = (e) => { e.preventDefault?.(); exitSelection(); };
    window.history.pushState({ selectionMode: true }, "");
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Tidy the sentinel entry if selection ended some other way, or the
      // history stack grows an entry per selection for the whole session.
      if (window.history.state?.selectionMode) window.history.back();
    };
  }, [selectionMode, exitSelection]);

  const enterSelectionWith = useCallback((kind, id) => {
    setSelectionMode(true);
    if (kind === "folder") onToggleFolder?.(id);
    else onToggleFile?.(id);
    // A long press that selects should feel like something happened even
    // before the bar animates in.
    if (navigator.vibrate) navigator.vibrate(12);
  }, [onToggleFile, onToggleFolder]);

  const rows = useMemo(() => [
    ...folders.map((f) => ({
      key: `d:${f.id}`, kind: "folder",
      item: { id: f.id, name: f.name, isFolder: true, secondary: null },
      count: f.totalFileCount ?? f.fileCount ?? 0,
      raw: f,
    })),
    ...files.map((f) => ({
      key: `f:${f.id}`, kind: "file",
      item: {
        id: f.id,
        name: f.ai_short_title || f.display_name || f.filename_current,
        secondary: f.ai_short_title ? (f.display_name || f.filename_current) : null,
        isFolder: false,
        extension: f.extension,
        filename_current: f.filename_current,
        mime_type_detected: f.mime_type_detected,
      },
      raw: f,
    })),
  ], [folders, files]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The contextual bar REPLACES the header while selecting, the way every
          mail app does it -- two headers stacked would push the list down and
          move the rows out from under the finger that just selected one. */}
      {selectionMode ? (
        <div className="sticky top-0 z-20 flex items-center gap-1 border-b border-line bg-brand-50 px-2 py-2">
          <button
            type="button"
            onClick={exitSelection}
            aria-label="Leave selection"
            className="flex h-10 w-10 items-center justify-center rounded-xl text-brand-700 hover:bg-brand-500/10"
          >
            <X size={18} />
          </button>
          <span className="flex-1 text-[15px] font-semibold text-brand-700">
            {selectedCount} selected
          </span>
          <button
            type="button"
            onClick={onSelectAll}
            aria-label="Select all"
            className="flex h-10 w-10 items-center justify-center rounded-xl text-brand-700 hover:bg-brand-500/10"
          >
            <CheckSquare size={18} />
          </button>
          {onShare && (
            <button
              type="button"
              onClick={() => onShare()}
              disabled={!selectedCount}
              aria-label="Share selected"
              className="flex h-10 w-10 items-center justify-center rounded-xl text-brand-700 hover:bg-brand-500/10 disabled:opacity-40"
            >
              <Share2 size={18} />
            </button>
          )}
          {canModify && (
            <button
              type="button"
              onClick={() => onMove?.()}
              disabled={!selectedCount}
              aria-label="Move selected"
              className="flex h-10 w-10 items-center justify-center rounded-xl text-brand-700 hover:bg-brand-500/10 disabled:opacity-40"
            >
              <FolderInput size={18} />
            </button>
          )}
          {canDelete && (
            <>
              <button
                type="button"
                onClick={() => onArchive?.()}
                disabled={!selectedCount}
                aria-label="Archive selected"
                className="flex h-10 w-10 items-center justify-center rounded-xl text-brand-700 hover:bg-brand-500/10 disabled:opacity-40"
              >
                <ArchiveIcon size={18} />
              </button>
              <button
                type="button"
                onClick={() => onTrash?.()}
                disabled={!selectedCount}
                aria-label="Trash selected"
                className="flex h-10 w-10 items-center justify-center rounded-xl text-rose-600 hover:bg-rose-500/10 disabled:opacity-40"
              >
                <Trash2 size={18} />
              </button>
            </>
          )}
        </div>
      ) : (
        header
      )}

      <div className="min-h-0 flex-1 divide-y divide-row-divider overflow-y-auto">
        {loading ? (
          <p className="px-4 py-8 text-center text-sm text-base-400">Loading…</p>
        ) : !rows.length ? (
          <p className="px-4 py-8 text-center text-sm text-base-400">{emptyMessage}</p>
        ) : (
          rows.map((row) => {
            const isFolder = row.kind === "folder";
            const selected = isFolder ? selectedFolderIds.has(row.item.id) : selectedFileIds.has(row.item.id);
            const toggle = () => (isFolder ? onToggleFolder?.(row.item.id) : onToggleFile?.(row.item.id));

            return (
              <MobileRow
                key={row.key}
                item={row.item}
                query={query}
                selected={selected}
                selectionMode={selectionMode}
                onActivate={() => (isFolder ? onEnterFolder?.(row.raw) : onOpenFile?.(row.raw))}
                onToggle={toggle}
                onLongPress={() => enterSelectionWith(row.kind, row.item.id)}
                meta={
                  isFolder
                    ? <span>{row.count.toLocaleString()} file{row.count === 1 ? "" : "s"}</span>
                    : null
                }
                // Swiping RIGHT is the safe direction, so the constructive
                // actions live there. Swiping LEFT reaches the destructive
                // ones, which is the harder gesture to make by accident on a
                // right-handed grip and the convention every mail app uses.
                leftActions={[
                  {
                    key: "select", label: "Select", icon: CheckSquare,
                    className: "bg-brand-600",
                    onSelect: () => { setSelectionMode(true); toggle(); },
                  },
                  ...(canModify ? [{
                    key: "move", label: "Move", icon: FolderInput,
                    className: "bg-base-600",
                    onSelect: () => { if (!selected) toggle(); onMove?.(row.raw, row.kind); },
                  }] : []),
                ]}
                rightActions={[
                  ...(!isFolder ? [{
                    key: "open", label: "Preview", icon: Eye,
                    className: "bg-base-600",
                    onSelect: () => onPreviewFile?.(row.raw),
                  }] : []),
                  ...(canDelete ? [
                    {
                      key: "archive", label: "Archive", icon: ArchiveIcon,
                      className: "bg-amber-600",
                      onSelect: () => onArchive?.(row.raw, row.kind),
                    },
                    {
                      key: "trash", label: "Trash", icon: Trash2,
                      className: "bg-rose-600",
                      onSelect: () => onTrash?.(row.raw, row.kind),
                    },
                  ] : []),
                  ...(!isFolder && onShare ? [{
                    key: "share", label: "Share", icon: Share2,
                    className: "bg-brand-600",
                    onSelect: () => onShare(row.raw),
                  }] : []),
                  ...(!isFolder && onFileMenu ? [{
                    key: "more", label: "More", icon: MoreVertical,
                    className: "bg-base-700",
                    onSelect: () => onFileMenu(row.raw),
                  }] : []),
                ]}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
