import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Plus, Archive as ArchiveIcon, Trash2, RotateCcw,
  FolderInput, Search, X, ListTree, PanelLeftClose, PanelLeftOpen,
  FolderOpen, CheckSquare, Square, Keyboard, Table2, ChevronUp, ChevronDown, Sparkles, Share2,
} from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { ErrorState } from "../components/ErrorState";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Pagination } from "../components/Pagination";
import { FileDetailModal } from "../components/FileDetailModal";
import { PreviewModal } from "../components/PreviewModal";
import { EditFileModal } from "../components/EditFileModal";
import { MoveFileModal } from "../components/MoveFileModal";
// FolderImportZone removed alongside FolderUploadZone: both uploaded file
// BYTES into backend/storage/uploads. Folders are registered and indexed in
// place now -- see StorageLocationsPage.
import { FileFilters, EMPTY_FILTERS, filtersToParams, countActiveFilters } from "../components/FileFilters";
import { usePublishAssistantContext, useAssistantChanges, useAssistantReveal } from "../context/AssistantContext";
import { List, useDynamicRowHeight, useListRef } from "react-window";
import { LibraryFileRow } from "../components/LibraryFileRow";
import { SubjectTreePane } from "../components/SubjectTreePane";
import { LibraryOnboarding } from "../components/LibraryOnboarding";
import { LibraryOverview } from "../components/LibraryOverview";
import { MoveManyModal } from "../components/MoveManyModal";
import { LibraryTable } from "../components/LibraryTable";
import { LibraryBreadcrumb } from "../components/LibraryBreadcrumb";
import { useMarqueeSelection } from "../lib/useMarqueeSelection";
import { MarqueeBox } from "../components/MarqueeBox";
import { FileContextMenu, useFileContextMenu } from "../components/FileContextMenu";
import { openFileSmart } from "../lib/openFile";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { hasMatch } from "../components/HighlightedText";
import { MobileLibrary } from "../components/MobileLibrary";
import { useFileActions } from "../lib/useFileActions";
import { shareFiles } from "../lib/shareFile";

/**
 * Files per page in the list view.
 *
 * Was 20, which on a normal screen meant roughly five rows visible and a lot of
 * scrolling to reach a pager -- the specific complaint that started this work.
 * The list is windowed now, so the cost of a page is a screenful of DOM
 * regardless of how many rows it contains, and a bigger page means far less
 * paging. Still paged rather than infinite: a pager is what makes "of 1,240"
 * expressible, and an unbounded list is a tab that stops responding.
 */
const FILES_LIMIT = 100;
// The table view is for scanning, so it pages in bigger bites. Still paged
// rather than infinite: at a few thousand files an unbounded list is a browser
// tab that stops responding, and the pager is also what makes "of 1,240"
// meaningful.
const TABLE_LIMIT = 100;

/**
 * How much vertical space the page chrome above the content occupies:
 * the header, the search box, the overview strip and the filter bar.
 *
 * ONE constant, used by all three panes that size themselves as "the rest of
 * the viewport". It was three separate hand-tuned numbers inline in the class
 * strings (15rem, 7rem, 13rem), which encoded that same height in three
 * places -- so adding the overview strip above them silently invalidated all
 * three at once and pushed the pager below the fold on a 720px screen. They
 * cannot drift apart now, and there is one obvious thing to change when the
 * chrome changes again.
 */
/*
 * It is no longer ONE number, because the header stopped being one height.
 * The navigation floats now (components/FloatingHeader.jsx) with the verse
 * ribbon above it, and that stack is 48px, 56px, or taller again when a long
 * verse wraps. `--app-chrome-h` is what it actually measured; 15.5rem is
 * everything below it that this page puts above these panes -- the search
 * box, the overview strip, the filter bar and the pager -- which is the old
 * 19rem less the 3.5rem the fixed-height bar used to occupy.
 */
const CHROME_HEIGHT = "(15.5rem + var(--app-chrome-h, 7.5rem))";

/**
 * How tall the two panes on this page are.
 *
 * ONE expression, used by BOTH, and that is the fix rather than a detail. The
 * folder pane used to be `maxHeight: calc(100vh - CHROME)` while the file
 * panel beside it was `height: calc(100vh - CHROME + 11rem)`. Same page, same
 * row of the same grid, 176px apart -- so on a 900px screen the folder list
 * had roughly nine rows of usable space while the panel next to it had
 * fourteen, and the pane whose whole job is browsing a deep tree was the
 * short one. Nobody chose that; the two numbers were written at different
 * times and nothing made them agree.
 *
 * `height`, not `maxHeight`, for both: the tree inside is windowed and can
 * only size itself against a parent that has a height to give it.
 */
const PANE_HEIGHT = `calc(100vh - ${CHROME_HEIGHT} + 11rem)`;

/**
 * THE FOLDER PANE'S WIDTH.
 *
 * It was `minmax(14rem, 17%)`: 224px on a laptop, which after the card's
 * padding, a chevron, a folder glyph and a file count leaves a nested folder
 * about forty characters, and every name at depth three truncated. 17% of the
 * viewport is also the wrong rule -- a wider screen does not mean you want
 * proportionally more folder, it means you can afford a bit more and want the
 * rest for files.
 *
 * So it is a real number the user owns, dragged and remembered. The default is
 * 20rem rather than a percentage; MIN is the narrowest at which a two-level
 * name still reads, and MAX exists so the pane cannot be dragged over the
 * files it is there to navigate.
 */
const TREE_WIDTH_KEY = "atlas.library.treeWidth";
const TREE_COLLAPSED_KEY = "atlas.library.treeCollapsed";
const TREE_WIDTH_DEFAULT = 320;
const TREE_WIDTH_MIN = 200;
const TREE_WIDTH_MAX = 640;
/** The files area never goes below this, whatever the pane is dragged to. */
const FILES_MIN_WIDTH = 420;
/** Collapsed, the pane is a rail wide enough for one icon. */
const TREE_RAIL_WIDTH = 36;
/**
 * The `gap-4` between the two columns, in pixels.
 *
 * Counted, because it is not free: the container holds pane + gap + files, so
 * subtracting only FILES_MIN_WIDTH leaves the files area a gap's width SHORT
 * of its own floor. Measured at 1024px it produced 414px of files against a
 * stated minimum of 420 -- six pixels, and wrong for the reason that matters:
 * a floor that is not the floor is a number nobody can rely on.
 */
const SPLIT_GAP = 16;

const clampTreeWidth = (px, containerWidth = Infinity) => {
  const room = containerWidth - FILES_MIN_WIDTH - SPLIT_GAP;
  const ceiling = Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, room));
  return Math.round(Math.min(ceiling, Math.max(TREE_WIDTH_MIN, px)));
};

/**
 * Remembered per browser, and a broken read falls back to the default rather
 * than propagating -- localStorage throws outright in private-mode Safari, and
 * a page that fails to render because it could not recall a pane width is a
 * worse outcome than a pane at its default width.
 */
function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* the layout still works for this session; it just is not remembered */ }
}

/**
 * THE LIBRARY.
 *
 * This page used to be called "Subjects", which named the table it reads
 * rather than the job it does. It is the front door of the application: the
 * organized view of everything the system holds, and the place where a person
 * turns a heap of files into an archive.
 *
 * It is built around one loop, which is the loop somebody has after pointing
 * Atlas at a drive containing twenty years of accumulated documents:
 *
 *   see how much is unsorted  ->  open that pile  ->  select a stack of it
 *   ->  file it somewhere in one action  ->  watch the number go down
 *
 * Everything here serves that loop. The overview strip exists so the unfiled
 * count is the first thing you see and one click away. The unfiled pile is a
 * destination in the tree rather than a filter buried in a panel. Selection is
 * multi-file with shift-ranges and a keyboard path, because the difference
 * between filing two thousand files and giving up is whether it takes one
 * click per file or one click per stack.
 */

export function LibraryPage() {
  const { hasPermission } = useAuth();
  const { push } = useToast();
  const canManage = hasPermission("subject.manage");

  // Filters apply to the whole page: the counts drawn on the tree AND the
  // file list inside whichever subject is open. A tree whose numbers ignored
  // the filter would be advertising files the panel below then refuses to
  // show. There is deliberately no SUBJECT filter here -- the tree is the
  // subject picker, and a dropdown duplicating it would be a second, quieter
  // way to disagree with what is selected.
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const filterParams = filtersToParams(filters);
  const filterKey = JSON.stringify(filterParams);
  const activeFilters = countActiveFilters(filters);

  const { data: subjects, loading, error: subjectsError, reload: reloadSubjects } = useApiData(
    () => api.get("/subjects", filterParams),
    [filterKey]
  );

  /**
   * WHAT IS OPEN LIVES IN THE URL.
   *
   * `?subject=<id>`, or `?unfiled=1` for the unsorted pile. Previously the
   * selection was component state only, which meant the browser Back button
   * left the page entirely instead of stepping back through the branches you
   * had opened, a link to "the Invoices folder" could not be sent to anyone,
   * and a refresh dumped you at the root. For the page someone lands on first,
   * every one of those is a daily annoyance.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("subject") || null;
  const unfiledMode = searchParams.get("unfiled") === "1";
  /* ARRIVING FROM ANOTHER VIEW, POINTED AT ONE FILE.
   * Types (and anything else) can link to ?subject=<id>&file=<id>. Landing in
   * the right folder is only half of "show me where this lives" -- the other
   * half is not making someone find one row among two hundred, which is why
   * the id travels too. Cleared once acted on so a later reload does not
   * re-highlight a file the person has moved on from. */
  const focusFileId = searchParams.get("file") || null;
  /**
   * Archive and Trash are destinations, not folders (migration 037), so they
   * live in the URL the same way the Unfiled pile does -- addressable, and
   * steppable with the Back button -- rather than as a selected subject id.
   */
  const lifecycleMode = ["archive", "trash"].includes(searchParams.get("bin")) ? searchParams.get("bin") : null;

  const openSubject = useCallback((id) => {
    setSearchParams(id ? { subject: id } : {}, { replace: false });
  }, [setSearchParams]);

  const openUnfiled = useCallback(() => {
    setSearchParams({ unfiled: "1" }, { replace: false });
  }, [setSearchParams]);

  const openBin = useCallback((bin) => {
    setSearchParams({ bin }, { replace: false });
  }, [setSearchParams]);

  /**
   * How much is in Archive and Trash.
   *
   * Polled alongside the overview rather than derived from the tree, because
   * neither is in the tree -- they are statuses, and nothing in the subject
   * list knows how many files carry them.
   */
  /** What is inside the open bin. Nothing is fetched unless one is open. */
  const { data: binContents, loading: loadingBin, reload: reloadBinContents } = useApiData(
    () => (lifecycleMode ? api.get(`/files/lifecycle/${lifecycleMode}`, { limit: 200 }) : Promise.resolve(null)),
    [lifecycleMode]
  );

  const { data: binSummary, reload: reloadBins } = useApiData(
    () => api.get("/files/lifecycle/summary"),
    []
  );

  // The overview strip's numbers. The same endpoint the Dashboard uses, so
  // the two can never disagree about how much is unfiled.
  const { data: overview, loading: loadingOverview, reload: reloadOverview } = useApiData(
    () => api.get("/dashboard/summary"),
    []
  );

  const [fileOffset, setFileOffset] = useState(0);

  /**
   * Remembered, because whichever view someone prefers they prefer it every
   * time -- resetting to the default on each visit would make the toggle feel
   * like it did not work.
   *
   * List or table. The map/graph view is gone.
   *
   * It existed to give more room to browse folders, and at any real size it
   * gave less: a force-directed canvas of 55,000 nodes is not navigable, and
   * the two views it sat between answer the question better -- the tree for
   * structure, the table for "biggest files" and "what came in last week".
   *
   * The stored key is REUSED rather than abandoned, and anything that is not a
   * view we still have falls back to "list". Someone whose browser last saved
   * "graph" would otherwise load a view that no longer renders.
   */
  const [view, setView] = useState(() => {
    const saved = localStorage.getItem("atlas.subjectView");
    return ["list", "table"].includes(saved) ? saved : "list";
  });
  function changeView(next) {
    setView(next);
    localStorage.setItem("atlas.subjectView", next);
  }

  /**
   * Sorting, for the table view.
   *
   * Server-side, against a whitelist (repositories/fileFilters.parseSort) --
   * sorting the twenty rows currently on screen would be a lie at any size
   * that matters. "Largest file in the archive" has to mean the archive, not
   * this page.
   */
  const [sort, setSort] = useState({ sortBy: "imported", sortDir: "desc" });
  const sortParams = { sortBy: sort.sortBy, sortDir: sort.sortDir };
  const sortKey = `${sort.sortBy}:${sort.sortDir}`;

  function toggleSort(column) {
    setSort((current) =>
      current.sortBy === column
        ? { sortBy: column, sortDir: current.sortDir === "asc" ? "desc" : "asc" }
        : // First click on a new column uses that column's natural direction:
          // newest and largest first, names A-Z. Ascending dates would open on
          // 1970 every time.
          { sortBy: column, sortDir: ["date", "size", "imported"].includes(column) ? "desc" : "asc" }
    );
    setFileOffset(0);
  }

  // The table exists to scan a lot at once, so it pages in bigger bites.
  const pageSize = view === "table" ? TABLE_LIMIT : FILES_LIMIT;

  /**
   * ONE SEARCH BOX, AND IT SEARCHES DOCUMENTS.
   *
   * This is the fix for the page's worst confusion. There used to be two
   * inputs that looked identical and did different things: the box at the top
   * filtered SUBJECT NAMES in list view but searched FILES in map view, and a
   * second box inside the panel searched files within one subject. So on the
   * front door of a document management system, typing "plumber invoice" into
   * the most prominent field returned "no subject matches" -- a true answer to
   * a question nobody asked -- unless you happened to be in the other view.
   *
   * Now: this box searches documents, everywhere, in every view. Finding a
   * FOLDER by name is a different and much rarer job, so it gets its own small
   * input inside the tree pane, physically next to the thing it affects.
   *
   * Debounced because it is a ranked full-text query over the whole archive;
   * `q` is fed from the debounced value only, never from the keystroke.
   */
  const [docQuery, setDocQuery] = useState("");
  const [debouncedDocQuery, setDebouncedDocQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedDocQuery(docQuery.trim()); setFileOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [docQuery]);

  const searching = debouncedDocQuery.length >= 2;

  /**
   * "Show me where this lives", asked by the assistant after it found a file.
   *
   * This used to switch to the map, on the reasoning that the route lighting up
   * WAS the answer. With the map gone the answer is simpler and survives at
   * scale: switch to the list, open the folder, and let the tree pane reveal it
   * -- SubjectTreePane expands every ancestor and scrolls the windowed list to
   * the row, which is the same "here it is" without a canvas.
   *
   * Deliberately forces the list view: the table has no tree, so revealing a
   * folder there would highlight nothing.
   */
  useAssistantReveal((subjectId) => {
    if (!subjectId) return;
    changeView("list");
    openSubject(subjectId);
  });

  const selected = useMemo(
    () => (subjects || []).find((s) => s.id === selectedId) || null,
    [subjects, selectedId]
  );

  /* ---------------------------------------------------------------------
   * MOBILE
   *
   * The phone gets a different interaction model over the same data, not the
   * same components at a narrower width -- see components/MobileLibrary.jsx
   * for why that distinction is the whole point. What it needs from here is
   * three things the desktop layout expresses differently:
   *
   *   the folders to show     desktop renders a whole tree in a side pane;
   *                           a phone shows the CHILDREN of where you are and
   *                           you walk into them.
   *   id-based selection      toggleFile takes a row INDEX, which suits a
   *                           keyboard cursor and a shift-click range and is
   *                           meaningless to a finger on a specific row.
   *   folders in the same     so a selection can contain both and one action
   *   selection              bar can act on it.
   * ------------------------------------------------------------------- */
  const mobileFolders = useMemo(() => {
    const all = subjects || [];
    if (searching || unfiledMode) return [];   // a result set is files, not a place
    return all.filter((sub) => (sub.parent_id || null) === (selectedId || null));
  }, [subjects, selectedId, searching, unfiledMode]);

  const toggleFileById = useCallback((id) => {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleFolderById = useCallback((id) => {
    setSelectedSubjectIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Subject create/rename/delete state.
  const [formTarget, setFormTarget] = useState(null); // { mode: 'create'|'edit', parentId?, subject? }
  const [binDropTarget, setBinDropTarget] = useState(null);
  /**
   * The second step of permanently deleting.
   *
   * The API requires the literal string "permanently delete" in the body, and
   * this dialog is where it is typed. That is not ceremony: it is the only
   * irreversible action in the application, and it should not be reachable by
   * a mis-aimed click or a mis-wired handler. Holding the phrase in state also
   * means the confirm button can stay disabled until it matches.
   */
  const [purgeTarget, setPurgeTarget] = useState(null);
  const [purgePhrase, setPurgePhrase] = useState("");
  const [purging, setPurging] = useState(false);
  const [deleteSubjectTarget, setDeleteSubjectTarget] = useState(null);
  const [deletingSubject, setDeletingSubject] = useState(false);
  /**
   * What deleting the chosen folder would take with it.
   *
   * Fetched when the dialog opens so the confirmation can NAME the
   * consequences -- "3 folders and 128 documents" -- instead of asking "are
   * you sure?" about an unknown quantity, which is a question people click
   * through rather than answer.
   */
  const [removalPreview, setRemovalPreview] = useState(null);
  /**
   * What happens to the documents inside a folder being deleted.
   *
   * "unfile" (default) leaves them in the repository with no folder; "trash"
   * sends them to the Trash with it, recoverable for the retention window.
   * There is deliberately no option that destroys them outright -- a folder
   * delete is an action about ORGANISATION, and tidying your tree should not
   * be one click from losing documents.
   */
  const [deleteContents, setDeleteContents] = useState("unfile");
  useEffect(() => {
    if (!deleteSubjectTarget) { setRemovalPreview(null); return undefined; }
    setDeleteContents("unfile");
    let cancelled = false;
    api.get(`/subjects/${deleteSubjectTarget.id}/removal-preview`)
      .then((r) => { if (!cancelled) setRemovalPreview(r); })
      .catch(() => { if (!cancelled) setRemovalPreview(null); });
    return () => { cancelled = true; };
  }, [deleteSubjectTarget]);

  // File action state -- same shape as FilesPage, reusing the same modals.
  const [selectedFileId, setSelectedFileId] = useState(null);
  const [previewFileId, setPreviewFileId] = useState(null);
  const [editFileTarget, setEditFileTarget] = useState(null);
  const [moveFileTarget, setMoveFileTarget] = useState(null);
  const [removeFileTarget, setRemoveFileTarget] = useState(null);
  const [removingFile, setRemovingFile] = useState(false);

  /**
   * Multi-selection, held as a Set of file ids.
   *
   * Ids rather than indexes so a selection survives paging and reordering --
   * selecting rows 3-9, paging forward and coming back must not leave a
   * different nine files ticked. `anchorIndex` is what makes shift-click mean
   * "everything between here and there", which is the interaction that turns
   * filing a hundred documents from a hundred clicks into three.
   */
  const [selectedFileIds, setSelectedFileIds] = useState(() => new Set());
  const rowsRef = useRef([]);

  /**
   * Folders the user has ctrl-clicked.
   *
   * Kept SEPARATE from `selectedId` on purpose. `selectedId` answers "which
   * folder am I looking inside", which is navigation and is always exactly
   * one. This answers "which folders have I picked out", which is selection
   * and is any number -- including none, which is the normal state. Merging
   * them would mean ctrl-clicking a second folder had to either navigate
   * somewhere or leave the file list showing a folder that is no longer
   * highlighted.
   */
  const [selectedSubjectIds, setSelectedSubjectIds] = useState(() => new Set());

  /**
   * Rubber-band selection over whatever the list is currently showing.
   *
   * `additive` is what a modifier key means here: without one the box REPLACES
   * the selection (drag somewhere empty to clear, as in any file manager),
   * with one it adds to it. Files and folders both answer to this because both
   * carry `data-select-id`; the hook does not know or care which is which.
   */
  const onMarqueeSelect = useCallback((ids, { additive }) => {
    const fileIdSet = new Set(rowsRef.current.map((r) => r.id));
    setSelectedFileIds((current) => {
      const next = additive ? new Set(current) : new Set();
      for (const id of ids) if (fileIdSet.has(id)) next.add(id);
      return next;
    });
    setSelectedSubjectIds((current) => {
      const next = additive ? new Set(current) : new Set();
      for (const id of ids) if (!fileIdSet.has(id)) next.add(id);
      return next;
    });
  }, []);

  const marquee = useMarqueeSelection({ onSelect: onMarqueeSelect });
  const fileMenu = useFileContextMenu();

  const toggleSubject = useCallback((id) => {
    setSelectedSubjectIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const [anchorIndex, setAnchorIndex] = useState(null);
  const [bulkFileOpen, setBulkFileOpen] = useState(false);

  // Which row the keyboard is on. Separate from the selection: you move
  // through a list to look at it, and tick things as you go.
  const [cursor, setCursor] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const detailPanelRef = useRef(null);
  const fileSearchRef = useRef(null);

  /* ------------------------------------------------------------------ *
   * THE FOLDER PANE'S WIDTH, AND WHY IT IS DRAGGED RATHER THAN CHOSEN.
   *
   * The complaint was that the folder container is too small, worst with many
   * folders. There are three separate causes and this addresses all three:
   * the pane is now as tall as the panel beside it (PANE_HEIGHT), it starts
   * wider, and its width is the user's to set -- because how much folder you
   * want is a function of how deep YOUR taxonomy is, which no default can
   * know. Someone with three top-level folders wants the room for files;
   * someone with `Clients / Acme / 2026 / Invoices` wants to read the names.
   *
   * A drag rather than a preference screen, because this is a direct
   * manipulation of a thing you can see, and because the whole gesture is
   * discoverable from a cursor change.
   * ------------------------------------------------------------------ */
  const splitRef = useRef(null);
  /**
   * TWO NUMBERS, NOT ONE, AND THE DISTINCTION IS LOAD-BEARING.
   *
   * `preferredTreeWidth` is what the USER asked for. It changes only when they
   * drag the splitter, press an arrow key, or reset -- never because the
   * window moved.
   *
   * `containerWidth` is how much room there is. The width actually rendered is
   * the preference clamped to the room, computed at render time.
   *
   * The obvious single-state version is wrong in a way that only shows up
   * later: clamping the stored value on every resize means narrowing the
   * window permanently overwrites the preference, and widening it again does
   * not bring the pane back -- a clamp is one-way. Someone who drags the pane
   * to 500px, docks their laptop to a small second screen, and comes back the
   * next day finds it at 200 with no memory that they ever chose otherwise.
   * Deriving instead means the squeeze is temporary and the preference
   * survives it, which is what "remembered" has to mean.
   */
  const [preferredTreeWidth, setPreferredTreeWidth] = useState(
    () => readStored(TREE_WIDTH_KEY, TREE_WIDTH_DEFAULT)
  );
  const [containerWidth, setContainerWidth] = useState(Infinity);
  const treeWidth = clampTreeWidth(preferredTreeWidth, containerWidth);
  const [treeCollapsed, setTreeCollapsed] = useState(() => readStored(TREE_COLLAPSED_KEY, false) === true);
  const [resizing, setResizing] = useState(false);

  const commitTreeWidth = useCallback((px) => {
    const container = splitRef.current?.getBoundingClientRect().width ?? Infinity;
    const next = clampTreeWidth(px, container);
    setPreferredTreeWidth(next);
    writeStored(TREE_WIDTH_KEY, next);
    return next;
  }, []);

  const toggleTreeCollapsed = useCallback(() => {
    setTreeCollapsed((was) => {
      writeStored(TREE_COLLAPSED_KEY, !was);
      return !was;
    });
  }, []);

  /**
   * The drag itself, on the WINDOW rather than on the handle.
   *
   * Pointer capture on the handle would be the tidier-looking version and is
   * the wrong one here: the pointer routinely leaves the 6px strip during a
   * fast drag, and any listener attached to the handle stops receiving moves
   * the moment it does -- the pane sticks and then jumps when you come back.
   * Listening on the window for the duration means the drag follows the
   * cursor anywhere, including outside the browser window.
   *
   * `user-select: none` on the body for the duration, because dragging across
   * a list of folder names otherwise selects them, and the blue smear looks
   * like the app has broken.
   */
  useEffect(() => {
    if (!resizing) return undefined;
    const onMove = (e) => {
      const box = splitRef.current?.getBoundingClientRect();
      if (!box) return;
      commitTreeWidth(e.clientX - box.left);
    };
    const stop = () => setResizing(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.userSelect = previous;
    };
  }, [resizing, commitTreeWidth]);

  /**
   * How much room there is, measured rather than assumed.
   *
   * This exists so the files area keeps its floor: a width dragged out on a
   * large monitor, or restored from another machine's localStorage, must not
   * squeeze the file list into a column too narrow to read.
   *
   * A CALLBACK REF, NOT `useEffect` OVER A REF OBJECT.
   *
   * The obvious version -- `useEffect(() => { observe(splitRef.current) }, [])`
   * -- was written first and silently did nothing. This grid renders inside
   * the "loaded" branch, so on the mount that the effect runs on there is no
   * element yet; `splitRef.current` is null, the effect returns early, and
   * with an empty dependency array it never runs again. The observer was never
   * attached, `containerWidth` stayed Infinity, and the clamp that keeps the
   * files area above its floor never applied. Measured at a 1024px viewport it
   * left the file list 414px wide against a stated minimum of 420 -- a floor
   * that was not a floor, failing quietly in exactly the direction nobody
   * checks.
   *
   * React calls a callback ref WHEN THE NODE ATTACHES, whenever that is, so
   * the observer is set up at the moment there is something to observe.
   */
  const observerRef = useRef(null);
  const measureSplit = useCallback(() => {
    const el = splitRef.current;
    if (el) setContainerWidth(el.getBoundingClientRect().width);
  }, []);

  const attachSplit = useCallback((el) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    splitRef.current = el;
    if (!el) return;
    // Measured synchronously here, so the first render after the element
    // exists already has a real number rather than Infinity.
    setContainerWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    ro.observe(el);
    observerRef.current = ro;
  }, []);

  /**
   * BOTH SIGNALS, because they cover different things and neither is
   * guaranteed.
   *
   * ResizeObserver catches what a window resize cannot: the collapsed rail
   * replacing the pane, a scrollbar appearing, the page chrome changing height
   * -- all of which resize this element while the window sits still.
   *
   * The window listener catches what ResizeObserver missed. That is not a
   * hypothetical: in the embedded browser this was verified in, a
   * ResizeObserver on this element never fired at all -- not even the initial
   * callback the spec promises on `observe()` -- so the pane kept a width
   * measured at the previous viewport and the files area silently stayed below
   * its floor. Whether that is a quirk of one environment hardly matters: a
   * layout that is correct only where one particular API works is a layout
   * with a single point of failure, and the fallback is four lines.
   *
   * Both write the same measured value, so running both is idempotent.
   */
  useEffect(() => {
    window.addEventListener("resize", measureSplit);
    return () => {
      window.removeEventListener("resize", measureSplit);
      observerRef.current?.disconnect();
    };
  }, [measureSplit]);

  // Collapsing changes this element's width without any event the listener
  // above can see, so re-measure when it flips.
  useEffect(() => { measureSplit(); }, [treeCollapsed, measureSplit]);

  useEffect(() => setFileOffset(0), [selectedId, unfiledMode]);

  // Changing what you are looking at clears what you had ticked. Carrying a
  // selection across from another folder and then filing it would move files
  // the user can no longer see, which is the single worst thing a bulk action
  // can do.
  useEffect(() => {
    setSelectedFileIds(new Set());
    setAnchorIndex(null);
    setCursor(0);
  }, [selectedId, unfiledMode, filterKey]);

  // On narrow screens the two columns stack, so the file panel sits BELOW
  // the whole tree and selecting a subject appears to do nothing until you
  // scroll. Sticky positioning only applies at lg and up, so bring the
  // panel into view here instead. Guarded on the breakpoint so this never
  // fights the sticky behaviour on a wide screen.
  useEffect(() => {
    if (!selectedId || !detailPanelRef.current) return;
    const isStacked = window.matchMedia("(max-width: 1023px)").matches;
    if (isStacked) {
      detailPanelRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedId]);

  // The per-subject search box that used to live inside the panel is gone. It
  // was the second of the two look-alike inputs, and having removed the
  // ambiguity at the top there is no reason to reintroduce it here: the page
  // search finds the document wherever it is and tells you which folder that
  // was, which is strictly more useful than being told it is not in the one
  // you happen to have open.

  /**
   * The files on show: either a subject's, or the unfiled pile's.
   *
   * The unfiled branch goes to GET /files with `unfiled=true` rather than a
   * bespoke endpoint, so it runs the same one filter builder as everything
   * else and cannot develop its own idea of what a filter means. Both shapes
   * are rendered by the same row markup -- `/subjects/:id/documents` returns
   * `display_name` and `/files` does not, which the row already falls back
   * through.
   */
  const { data: documents, loading: loadingDocs, reload: reloadFiles } = useApiData(
    () => {
      // A search outranks the open folder. Someone who types a query wants the
      // document, and making them first guess which branch it is in is exactly
      // the friction this page had. The result rows carry their own subject,
      // so the answer still says where each one lives.
      if (searching) {
        return api.get("/files", {
          q: debouncedDocQuery,
          limit: pageSize,
          offset: fileOffset,
          ...filterParams,
        });
      }
      if (unfiledMode) {
        return api.get("/files", {
          unfiled: true,
          limit: pageSize,
          offset: fileOffset,
          ...sortParams,
          ...filterParams,
          // The page's subject filter is meaningless here and the API rejects
          // the combination outright, so it is dropped rather than sent and
          // 400'd.
          subjectId: undefined,
        });
      }
      if (selected) {
        return api.get(`/subjects/${selected.id}/documents`, {
          limit: pageSize,
          offset: fileOffset,
          ...sortParams,
          ...filterParams,
        });
      }
      // The table has an "Everything" scope that the tree views do not: with
      // no folder chosen they show a prompt to choose one, but a table with no
      // rows is just an empty box. At this size "show me everything, sorted by
      // size" is a real question and this is the view that answers it.
      if (view === "table") {
        return api.get("/files", { limit: pageSize, offset: fileOffset, ...sortParams, ...filterParams });
      }
      return Promise.resolve(null);
    },
    [selected?.id, unfiledMode, fileOffset, debouncedDocQuery, searching, filterKey, pageSize, sortKey, view]
  );

  /**
   * How many the current scope holds in total, so the pager can say "of 1,240".
   *
   * Deliberately not attempted while searching: counting a ranked full-text
   * query means running the expensive half of the search twice and throwing
   * the rows away, which the API refuses outright. With a search term the
   * honest thing to report is the page you are on.
   */
  const { data: scopeCount } = useApiData(
    () => {
      if (searching) return Promise.resolve(null);
      if (unfiledMode) return api.get("/files/count", { unfiled: true, ...filterParams, subjectId: undefined });
      if (selected) return api.get(`/subjects/${selected.id}/documents/count`, filterParams);
      if (view === "table") return api.get("/files/count", filterParams);
      return Promise.resolve(null);
    },
    [selected?.id, unfiledMode, searching, filterKey, view]
  );
  const scopeTotal = scopeCount?.count ?? null;

  // How many are in the pile, for the panel heading and the overview tile.
  const unfiledCount = overview?.attention?.unfiled ?? 0;

  /** Everything reloads together: filing changes counts in three places. */
  const reloadEverything = useCallback(() => {
    reloadFiles();
    reloadSubjects();
    reloadOverview();
    reloadBins();
    reloadBinContents();
  }, [reloadFiles, reloadSubjects, reloadOverview, reloadBins, reloadBinContents]);

  // --- selection ----------------------------------------------------------

  // Memoized so the identity is stable: `documents || []` hands back a fresh
  // array on every render while the fetch is in flight, which would re-create
  // the selection callbacks and tear down and re-add the window keydown
  // listener on each pass.
  const rows = useMemo(() => documents || [], [documents]);

  /* FIND-IN-PAGE OVER THE RESULT SET.
   *
   * The server search is hybrid -- it matches filenames, the text inside
   * documents, and each file's description BY MEANING. That is what makes it
   * good, and also why a result set can contain rows with no visible
   * connection to what was typed: "kid blowing out candles" legitimately
   * returns a photo described as "a child at a party with a cake".
   *
   * So these two questions are different, and the page was only answering the
   * first:
   *
   *   which files are RELEVANT?          the server decided; that is the list
   *   which ones literally SAY this?     nobody was saying, and it is the one
   *                                      you can act on with your eyes
   *
   * matchIndexes answers the second, over the rows already on screen. Marking
   * them yellow and putting a next/previous control on them turns a result
   * list into something you can walk, the way find-in-page does -- without
   * re-filtering, so the semantic hits are still there when the literal ones
   * run out.
   */
  const listRef = useListRef(null);
  const [matchPos, setMatchPos] = useState(0);

  const matchIndexes = useMemo(() => {
    if (!searching) return [];
    const out = [];
    rows.forEach((d, i) => {
      const name = d.ai_short_title || d.display_name || d.filename_current;
      const other = d.ai_short_title ? (d.display_name || d.filename_current) : d.current_path;
      if (hasMatch(name, debouncedDocQuery) || hasMatch(other, debouncedDocQuery)) out.push(i);
    });
    return out;
  }, [rows, debouncedDocQuery, searching]);

  // A new query is a new search: start from its first hit, not wherever the
  // last one happened to leave the pointer.
  useEffect(() => { setMatchPos(0); }, [debouncedDocQuery, fileOffset]);

  useEffect(() => {
    if (!focusFileId || !rows.length) return;
    const index = rows.findIndex((r) => r.id === focusFileId);
    if (index < 0) return;

    setCursor(index);
    setSelectedFileIds(new Set([focusFileId]));
    listRef.current?.scrollToRow({ index, align: "center", behavior: "smooth" });

    // Drop the parameter, keeping the folder. The highlight has done its job
    // the moment it is seen; leaving it in the URL would make every later
    // reload of this folder re-select a file for no reason anyone remembers.
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("file");
        return next;
      },
      { replace: true }
    );
  }, [focusFileId, rows, setSearchParams]);

  const goToMatch = useCallback((pos) => {
    if (!matchIndexes.length) return;
    // Wrap in both directions, like every find bar. Running off the end of a
    // list of matches should return you to the top, not stop dead.
    const next = ((pos % matchIndexes.length) + matchIndexes.length) % matchIndexes.length;
    setMatchPos(next);
    const rowIndex = matchIndexes[next];
    setCursor(rowIndex);
    listRef.current?.scrollToRow({ index: rowIndex, align: "center", behavior: "smooth" });
  }, [matchIndexes, listRef]);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  const previewFile = useMemo(
    () => (previewFileId ? rows.find((r) => r.id === previewFileId) || null : null),
    [previewFileId, rows]
  );

  const selectedCount = selectedFileIds.size;
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selectedFileIds.has(r.id));

  /**
   * Make this the selection, replacing whatever was selected before.
   *
   * The plain-click behaviour of every file manager. `toggleFile` remains for
   * ctrl-click and the checkbox, which ADD rather than replace.
   */
  const selectOnly = useCallback((index, d) => {
    setSelectedFileIds(new Set([d.id]));
    setAnchorIndex(index);
  }, []);

  const toggleFile = useCallback((index, { shiftKey = false } = {}) => {
    const row = rows[index];
    if (!row) return;

    setSelectedFileIds((current) => {
      const next = new Set(current);
      if (shiftKey && anchorIndex !== null) {
        const [from, to] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
        // Shift-click ADDS the range rather than replacing the selection, so
        // you can gather several runs before filing them in one go.
        for (let i = from; i <= to; i += 1) {
          if (rows[i]) next.add(rows[i].id);
        }
      } else if (next.has(row.id)) {
        next.delete(row.id);
      } else {
        next.add(row.id);
      }
      return next;
    });
    setAnchorIndex(index);
  }, [rows, anchorIndex]);

  const toggleAllOnPage = useCallback(() => {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      if (rows.every((r) => next.has(r.id))) rows.forEach((r) => next.delete(r.id));
      else rows.forEach((r) => next.add(r.id));
      return next;
    });
    setAnchorIndex(null);
  }, [rows]);

  const clearSelection = useCallback(() => {
    setSelectedFileIds(new Set());
    setAnchorIndex(null);
  }, []);

  /**
   * Everything the windowed file rows need, as one memoized object.
   *
   * react-window re-renders rows whenever any value in `rowProps` changes, so
   * this has to be stable -- an inline object would re-render every visible row
   * on every keystroke elsewhere on the page.
   */
  const fileRowHeight = useDynamicRowHeight({ defaultRowHeight: 84 });
  // Keyed by file id, not index: with paging and filtering the same slot holds
  // different documents, and index keys would let one row's state land on
  // another row's file.
  const fileRowKey = useCallback((index) => rows[index]?.id ?? index, [rows]);
  const fileRowProps = useMemo(
    () => ({
      documents: rows,
      selectedFileIds,
      cursor,
      canMove: hasPermission("document.move"),
      canModify: hasPermission("classification.modify"),
      /**
       * SINGLE CLICK SELECTS. That is the whole change.
       *
       * It used to open the detail modal, which is why double-click to open
       * never worked -- the modal mounted over the row between the two clicks
       * and swallowed the second one. It also meant there was no way to pick a
       * file without launching something, which is backwards: selecting is the
       * cheap, reversible act and every file manager binds it to a plain click.
       *
       * Ctrl and Shift keep their native meanings on top of that -- add one,
       * add a range -- so multi-select still works; it just is no longer the
       * ONLY way to select anything.
       */
      onSelectRow: (index, d, e) => {
        setCursor(index);
        if (e && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          toggleFile(index, {});
          return;
        }
        if (e && e.shiftKey) {
          e.preventDefault();
          toggleFile(index, { shiftKey: true });
          return;
        }
        selectOnly(index, d);
      },
      onToggleSelect: (index, opts) => toggleFile(index, opts),
      // More than one picked changes what the marked rows MEAN: this is a
      // batch, and double-clicking will not open it. The rows say so in
      // their own colour rather than leaving the count in a toolbar the
      // eye is not on.
      isMulti: selectedCount > 1,
      query: searching ? debouncedDocQuery : "",
      activeMatchIndex: matchIndexes.length ? matchIndexes[matchPos] : -1,
      onOpen: (d) => openFile(d),
      onContextMenu: (e, d, index) => {
        // A right-DRAG that just finished is a marquee selection, not a
        // request for this row's menu. The row's handler runs before the
        // container's, so it has to ask.
        if (marquee.consumeDrag()) {
          e.preventDefault();
          return;
        }
        // Select what the menu is about to act on, unless it is already part
        // of a multi-file selection the user built deliberately.
        if (!selectedFileIds.has(d.id)) selectOnly(index, d);
        fileMenu.openAt(e, d);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, selectedFileIds, selectedCount, cursor, toggleFile, searching, debouncedDocQuery, matchIndexes, matchPos]
  );

  /**
   * Tick one row, or -- with shift held -- everything between the last row
   * you ticked and this one. The range is inclusive and direction-agnostic,
   * because "from here to there" does not care which end you started at.
   */

  /**
   * Select everything matching, not just what is rendered.
   *
   * Asks the server for the ids, because the browser only ever has one page.
   * The response says whether the cap bit, and that is reported rather than
   * swallowed -- a "select all" that silently means "the first five thousand"
   * would file a different set from the one the user asked for, which is the
   * worst outcome a bulk action has available.
   */
  const [selectingAll, setSelectingAll] = useState(false);
  const selectAllMatching = useCallback(async () => {
    setSelectingAll(true);
    try {
      const result = await api.get("/files/ids", {
        ...filterParams,
        ...(unfiledMode ? { unfiled: true, subjectId: undefined } : {}),
        ...(!unfiledMode && selectedId ? { inSubjectId: selectedId } : {}),
      });
      setSelectedFileIds(new Set(result.ids || []));
      setAnchorIndex(null);
      if (result.capped) {
        push(
          `Selected the first ${result.cap.toLocaleString()} — that is the most that can be filed at once.`,
          "info"
        );
      }
    } catch (err) {
      push(err.message, "error");
    } finally {
      setSelectingAll(false);
    }
    // filterKey is the stable serialization of filterParams.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, unfiledMode, selectedId, push]);

  // --- keyboard -----------------------------------------------------------

  /**
   * Filing a backlog is a repetitive job, and repetitive jobs belong on the
   * keyboard. j/k to move, x to tick, f to file what is ticked -- which means
   * clearing a hundred-file pile never requires taking a hand off the keys.
   *
   * Deliberately inert while focus is in a text field: someone typing "file
   * from january" into the search box must not have every letter interpreted
   * as a command.
   */
  useEffect(() => {
    function onKeyDown(e) {
      const el = e.target;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

      if (e.key === "/" && !typing) {
        e.preventDefault();
        fileSearchRef.current?.focus();
        return;
      }
      if (e.key === "Escape") {
        if (typing) return; // let the field handle its own clear first
        if (selectedCount > 0) { clearSelection(); return; }
        if (showShortcuts) setShowShortcuts(false);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "?") { setShowShortcuts((s) => !s); return; }
      if (!rows.length) return;

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, rows.length - 1));
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          setCursor((c) => Math.max(c - 1, 0));
          break;
        case "x":
          e.preventDefault();
          toggleFile(cursor, { shiftKey: e.shiftKey });
          break;
        case "a":
          e.preventDefault();
          toggleAllOnPage();
          break;
        case "Enter":
          e.preventDefault();
          if (rows[cursor]) setSelectedFileId(rows[cursor].id);
          break;
        case "f":
          e.preventDefault();
          // Filing nothing is a no-op rather than an error dialog: the key
          // was pressed in the right spirit, there was just nothing ticked.
          if (selectedCount > 0 && hasPermission("document.move")) setBulkFileOpen(true);
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rows, cursor, selectedCount, showShortcuts, toggleFile, toggleAllOnPage, clearSelection, hasPermission]);

  // Keep the cursor on a row that exists after paging or filtering.
  useEffect(() => {
    setCursor((c) => (rows.length === 0 ? 0 : Math.min(c, rows.length - 1)));
  }, [rows.length]);

  /* LET THE ASSISTANT BUILD THE FOLDERS THE ARCHIVE IS MISSING.
   *
   * The unfiled pile is not a backlog of work someone forgot to do -- it is
   * every document the classifier looked at against the whole taxonomy and
   * honestly reported that nothing fit. Re-running classification cannot move
   * one of them, because the folder each needs does not exist and the
   * classifier cannot create one.
   *
   * This runs ONE batch inline (~120 files, half a minute) rather than
   * queueing the whole pile, deliberately: the first thing a person needs from
   * a feature that edits their folder tree is to see what it does on a sample
   * they can still take back. The full backlog is the same endpoint without
   * `batch`, which returns a job.
   */
  const [organizing, setOrganizing] = useState(false);

  async function organizeUnfiled() {
    setOrganizing(true);
    try {
      const r = await api.post("/subjects/unfiled/organize", { batch: true });
      const made = (r.createdFolders || []).length;
      if (r.reason) {
        push(r.reason, "info");
      } else if (!r.filed) {
        push("Nothing in this batch could be filed confidently. The rest stays unfiled.", "info");
      } else {
        push(
          `Filed ${r.filed} file(s)` +
            (made ? `, creating ${made} folder(s): ${r.createdFolders.map((f) => f.name).join(", ")}` : ""),
          "success"
        );
      }
      reloadSubjects();
      reloadFiles();
      reloadOverview();
    } catch (err) {
      push(err.message || "Could not organize the unfiled pile.", "error");
    } finally {
      setOrganizing(false);
    }
  }

  /** Share the current selection. Same implementation as a single file's
   *  Share -- lib/shareFile decides between the system share sheet and an
   *  export, and says which it did. */
  const shareSelection = useCallback(async () => {
    const chosen = rows.filter((r) => selectedFileIds.has(r.id));
    if (!chosen.length) return;
    await shareFiles(chosen, { onNotice: push });
  }, [rows, selectedFileIds, push]);

  /* Every file action this page offers, from the one shared definition.
   * Share and export live in lib/useFileActions so Library, Files and Types
   * cannot drift apart; what is passed in here is only what is genuinely
   * local -- what "open" means on this screen, and which modals its edit and
   * move actions raise. */
  const fileActions = useFileActions({
    push,
    onOpen: (d) => openFile(d),
    onPreview: (d) => setPreviewFileId(d.id),
    onDetails: (d) => setSelectedFileId(d.id),
    onRename: hasPermission("document.rename") || hasPermission("classification.modify") ? (d) => setEditFileTarget(d) : null,
    onMove: hasPermission("document.move") ? (d) => setMoveFileTarget(d) : null,
    onDelete: hasPermission("document.delete") ? (d) => setRemoveFileTarget(d) : null,
  });

  // Tell the assistant what is on screen so "move this file" resolves.
  usePublishAssistantContext({
    page: "Library",
    description: unfiledMode
      ? "Viewing the unfiled pile: documents that have not been placed under any subject yet."
      : selected
        ? `Viewing the folder "${selected.name}" (${selected.materialized_path}); the listed files are the ones classified under it.`
        : "Browsing the library; no folder is open, so no files are visible.",
    files: documents || [],
    selectedSubjectId: selected?.id || null,
    // So "file these" said to the assistant means the same set the user can
    // see ticked on screen.
    selectedFileIds: [...selectedFileIds],
  });

  // Reload after the assistant applies something, since it changes the same
  // data this page is showing.
  useAssistantChanges(() => { reloadSubjects(); reloadFiles(); reloadOverview(); });

  /**
   * OPEN a file, the way double-clicking one in a file manager does.
   *
   * On this machine that means launching it in its real application. From a
   * phone it means the best view the browser can give. The decision lives in
   * lib/openFile so the Library and the Files page cannot answer it
   * differently.
   */
  function openFile(d) {
    return openFileSmart(d, {
      onPreview: (f) => setPreviewFileId(f.id),
      onDownload: (f) => downloadFile(f.id, f.display_name || f.filename_current),
      onNotice: (msg, tone) => push(msg, tone),
    });
  }

  async function downloadFile(id, filename) {
    try {
      await api.download(`/files/${id}/download`, filename);
    } catch (err) {
      push(err.message, "error");
    }
  }

  async function confirmRemoveFile() {
    if (!removeFileTarget) return;
    setRemovingFile(true);
    try {
      await api.del(`/files/${removeFileTarget.id}`);
      push(`"${removeFileTarget.display_name || removeFileTarget.filename_current}" removed.`, "success");
      setRemoveFileTarget(null);
      reloadFiles();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setRemovingFile(false);
    }
  }

  /**
   * Dropping a file onto a subject node reclassifies it.
   *
   * This writes a manual classification, exactly as the Edit dialog's
   * subject dropdown does -- it is the same operation, reached faster. It
   * does NOT move or rename anything on disk; on a read-only location
   * nothing there ever changes, and the new subject shows up in the mirror
   * the next time it syncs.
   */
  /**
   * Drag a FOLDER onto another folder -- ordinary file-manager nesting, which
   * this tree did not have.
   *
   * `targetSubject` of null means the strip below the tree: move it back out to
   * the top level. Every refusal (into itself, into its own branch, too deep, a
   * name already taken there) comes from the server with both folder names in
   * it, so the toast is worth showing verbatim rather than replacing with
   * something vaguer.
   */
  async function moveSubjectByDrop(subjectId, targetSubject) {
    if (!canManage) {
      push("You don't have permission to rearrange folders.", "error");
      return;
    }
    const moving = (subjects || []).find((sub) => sub.id === subjectId);
    if (!moving) return;
    if ((moving.parent_id || null) === (targetSubject?.id || null)) return; // already there

    try {
      await api.patch(`/subjects/${subjectId}/parent`, { parentId: targetSubject?.id || null });
      push(
        targetSubject
          ? `"${moving.name}" moved into "${targetSubject.name}".`
          : `"${moving.name}" moved to the top level.`,
        "success"
      );
      reloadSubjects();
    } catch (err) {
      push(err.message, "error");
    }
  }

  /**
   * Put files in Archive or Trash, or take them out again.
   *
   * One function for all three directions because they differ only in the
   * endpoint and the sentence: the selection handling, the reload and the
   * error path are identical, and three copies of that is three chances for
   * one of them to forget to refresh a count.
   */
  async function sendToBin(fileIds, bin) {
    const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
    if (ids.length === 0) return;
    try {
      if (bin === "restore") {
        const res = await api.post("/files/lifecycle/restore", { fileIds: ids });
        push(`Restored ${res.restored.length} file${res.restored.length === 1 ? "" : "s"}.`, "success");
      } else {
        const res = await api.post(`/files/lifecycle/${bin}`, { fileIds: ids });
        push(
          bin === "trash"
            ? `${res.moved.length} file${res.moved.length === 1 ? "" : "s"} moved to Trash — recoverable for ${binSummary?.retentionDays ?? 30} days.`
            : `${res.moved.length} file${res.moved.length === 1 ? "" : "s"} archived.`,
          "success"
        );
      }
      clearSelection();
      reloadEverything();
    } catch (err) {
      push(err.message, "error");
    }
  }

  async function reclassifyByDrop(fileId, targetSubject) {
    if (!hasPermission("classification.modify")) {
      push("You don't have permission to reclassify files.", "error");
      return;
    }
    if (targetSubject.id === selectedId) return; // already there

    try {
      await api.patch(`/files/${fileId}`, { subjectId: targetSubject.id });
      push(`Moved to ${targetSubject.name}.`, "success");
      // Counts changed on the old subject, the new one, and -- if the file
      // came out of the unfiled pile -- the strip at the top of the page.
      reloadEverything();
    } catch (err) {
      push(err.message, "error");
    }
  }

  async function confirmDeleteSubject() {
    if (!deleteSubjectTarget) return;
    setDeletingSubject(true);
    try {
      // force: the dialog has already spelled out the branch and the document
      // count, so this click IS the confirmation. Sending it without force
      // would bounce back an error describing what the user just agreed to.
      await api.del(`/subjects/${deleteSubjectTarget.id}?force=true&contents=${deleteContents}`);
      const freed = removalPreview?.filesAffected || 0;
      push(
        `"${deleteSubjectTarget.name}" deleted.` +
        (freed
          ? deleteContents === "trash"
            ? ` ${freed.toLocaleString()} document${freed === 1 ? "" : "s"} moved to the Trash.`
            : ` ${freed.toLocaleString()} document${freed === 1 ? " is" : "s are"} now unfiled.`
          : ""),
        "success"
      );
      if (selectedId === deleteSubjectTarget.id) openSubject(null);
      setDeleteSubjectTarget(null);
      reloadSubjects();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setDeletingSubject(false);
    }
  }

  /**
   * The file panel for the selected subject.
   *
   * A function rather than inline JSX because both views need it: the
   * list view puts it in a sticky right-hand column, the map view puts it
   * under the table. Two copies of this much markup would drift apart.
   */
  /** Archive or Trash, in the panel where a folder's files would be. */
  function renderBinPanel() {
    const isTrash = lifecycleMode === "trash";
    const rows = binContents?.files || [];
    const retention = binContents?.retentionDays ?? binSummary?.retentionDays ?? 30;

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="mb-3 flex shrink-0 items-center gap-2">
          {isTrash ? <Trash2 size={16} className="text-rose-700" /> : <ArchiveIcon size={16} className="text-base-300" />}
          <h3 className="text-sm font-semibold text-base-50">{isTrash ? "Trash" : "Archive"}</h3>
          <span className="text-xs text-base-500">
            {isTrash
              ? `Removed for good ${retention} days after being trashed`
              : "Hidden from every listing and search, kept until you restore it"}
          </span>
          {selectedCount > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <button className="btn-secondary btn-sm" onClick={() => sendToBin([...selectedFileIds], "restore")}>
                <RotateCcw size={13} /> Restore {selectedCount}
              </button>
              {isTrash && (
                <button
                  className="btn-ghost btn-sm text-rose-700 hover:text-rose-700"
                  onClick={() => { setPurgeTarget([...selectedFileIds]); setPurgePhrase(""); }}
                >
                  <Trash2 size={13} /> Delete forever
                </button>
              )}
            </div>
          )}
        </div>

        {loadingBin ? (
          <p className="text-sm text-base-500">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-base-500">
            {isTrash ? "The Trash is empty." : "Nothing is archived."}
          </div>
        ) : (
          <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
            {rows.map((d, index) => {
              const isSelected = selectedFileIds.has(d.id);
              return (
                <li
                  key={d.id}
                  onClick={() => toggleFile(index)}
                  className={
                    "flex cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm " +
                    (isSelected ? "border-brand-500/40 bg-brand-500/10" : "border-line bg-base-900")
                  }
                >
                  {isSelected ? <CheckSquare size={15} className="shrink-0 text-brand-600" /> : <Square size={15} className="shrink-0 text-base-500" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-base-100">
                      {d.ai_short_title || d.display_name || d.filename_current}
                    </p>
                    <p className="truncate font-mono text-xs text-base-500">{d.current_path}</p>
                  </div>
                  {/* The deadline is the whole point of a Trash. One you
                      cannot see the countdown in is just a folder you forgot
                      about. */}
                  {isTrash && (
                    <span
                      className={
                        "shrink-0 rounded-full px-2 py-0.5 text-[11px] " +
                        (d.days_left <= 3 ? "bg-rose-500/15 text-rose-700" : "bg-base-850 text-base-400")
                      }
                    >
                      {d.days_left === 0 ? "removed today" : `${d.days_left} day${d.days_left === 1 ? "" : "s"} left`}
                    </span>
                  )}

                  {/* PER-ROW RESTORE.
                      Restoring existed already, but only as a bulk action that
                      appeared once something was ticked -- so getting one file
                      back meant finding a checkbox first, and the Trash looked
                      like a place things only went one way. Undo belongs on the
                      thing being undone. The bulk button stays for handfuls. */}
                  <button
                    className="btn-secondary btn-sm shrink-0"
                    onClick={(e) => { e.stopPropagation(); sendToBin([d.id], "restore"); }}
                    title={isTrash
                      ? "Put this file back where it was"
                      : "Return this file to the library"}
                  >
                    <RotateCcw size={13} /> Restore
                  </button>

                  {isTrash && (
                    <button
                      className="btn-ghost btn-sm shrink-0 text-rose-600 hover:text-rose-700"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPurgeTarget([d.id]);
                        setPurgePhrase("");
                      }}
                      title="Remove this file's record for good"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  function renderFilePanel() {
    // `searching` first: a query outranks the open folder, and with no folder
    // open — which is how the page starts — this guard would otherwise answer
    // a search with "pick a folder", reproducing the exact dead end the single
    // search box was introduced to remove.
    if (!searching && !selected && !unfiledMode) {
      return (
        <div className="py-10 text-center">
          <p className="text-sm text-base-400">
            Search above, or pick a folder on the left to see what's in it.
          </p>
          {unfiledCount > 0 && (
            <button className="btn-secondary btn-sm mt-3" onClick={openUnfiled}>
              <FolderOpen size={13} /> Or start with the {unfiledCount.toLocaleString()} unfiled
            </button>
          )}
        </div>
      );
    }

    const scopeName = searching ? "your documents" : unfiledMode ? "Unfiled" : selected.name;

    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* WHERE YOU ARE. One control for all three modes -- a folder, the
            unfiled pile, and a search across everything -- so the answer to
            "where am I" is always in the same place at the same size. Every
            ancestor is clickable, which is the part the old static
            `materialized_path` label could not do. */}
        <LibraryBreadcrumb
          subjects={subjects}
          selected={selected}
          unfiledMode={unfiledMode}
          searching={searching}
          query={debouncedDocQuery}
          count={searching ? null : unfiledMode ? unfiledCount : scopeTotal}
          countLabel="file"
          onNavigate={(id) => (id ? openSubject(id) : openSubject(null))}
          onClearSearch={() => setDocQuery("")}
          actions={
            unfiledMode && canManage ? (
              <button
                className="btn-primary btn-sm"
                onClick={organizeUnfiled}
                disabled={organizing || !unfiledCount}
                title="Let the assistant file these, creating folders where nothing suitable exists"
              >
                <Sparkles size={13} />
                {organizing ? "Organizing…" : "Organize with AI"}
              </button>
            ) : !searching && !unfiledMode && selected && canManage && selected.level !== "subcategory" ? (
              <button
                className="btn-secondary btn-sm"
                onClick={() => setFormTarget({ mode: "create", parentId: selected.id })}
              >
                <Plus size={13} /> Add {selected.level === "subject" ? "category" : "subcategory"}
              </button>
            ) : null
          }
        />

        {/* THE SELECTION BAR FLOATS. IT IS NOT IN THE LAYOUT.
            It used to sit inline above the list with `mb-3`, so the instant
            you clicked a file it appeared and shoved every row down by its own
            height. The row you had just pressed was no longer under the
            pointer, so the second click of a double-click landed on whatever
            had slid into its place -- you had to chase the file downward to
            open it. A toolbar that moves the thing it acts on is worse than no
            toolbar.
            Pinned to the bottom of the viewport instead: it appears and
            disappears without a single row moving, and it is closer to the
            pointer than the top of the panel ever was. */}
        {selectedCount > 0 && (
          <div className="floating-bar fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 px-3 py-2">
            <span className="text-sm font-medium text-brand-700">
              {selectedCount.toLocaleString()} selected
            </span>
            {hasPermission("document.move") && (
              <button className="btn-primary btn-sm" onClick={() => setBulkFileOpen(true)}>
                <FolderInput size={13} /> File {selectedCount.toLocaleString()}…
              </button>
            )}
            {hasPermission("document.download") && (
              <button className="btn-secondary btn-sm" onClick={shareSelection}>
                <Share2 size={13} /> Share
              </button>
            )}
            {/* Putting a selection away. Dragging onto Archive or Trash works
                for one file; a selection of two thousand needs a button. */}
            {hasPermission("document.delete") && (
              <>
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => sendToBin([...selectedFileIds], "archive")}
                  title="Hide these from every listing, keep them"
                >
                  <ArchiveIcon size={13} /> Archive
                </button>
                <button
                  className="btn-ghost btn-sm text-rose-700 hover:text-rose-700"
                  onClick={() => sendToBin([...selectedFileIds], "trash")}
                  title={`Recoverable for ${binSummary?.retentionDays ?? 30} days`}
                >
                  <Trash2 size={13} /> Trash
                </button>
              </>
            )}
            <button className="btn-ghost btn-sm" onClick={toggleAllOnPage}>
              {allOnPageSelected ? "Deselect page" : "Select page"}
            </button>

            {/* Selecting beyond the page. Without this, filing a backlog of
                two thousand means sixty page-selects, which is the point at
                which people stop and the archive stays a mess. */}
            {scopeTotal !== null && scopeTotal > rows.length && (
              <button className="btn-ghost btn-sm" onClick={selectAllMatching} disabled={selectingAll}>
                {selectingAll ? "Selecting…" : `Select all ${scopeTotal.toLocaleString()}`}
              </button>
            )}

            <button className="btn-ghost btn-sm text-base-400" onClick={clearSelection}>
              Clear
            </button>
            <span className="hidden pl-1 text-[11px] text-base-500 sm:block">
              shift-click for a range · <kbd>f</kbd> to file
            </span>
          </div>
        )}

        {loadingDocs ? (
          <PageSpinner />
        ) : !documents?.length ? (
          <p className="text-sm text-base-400">
            {searching
              ? `Nothing in your library matches “${debouncedDocQuery}”.`
              : activeFilters > 0
                ? `No files in ${scopeName} match the current filters.`
                : unfiledMode
                  ? "Nothing is waiting to be filed. The whole archive has a home."
                  : "No files placed under this folder yet."}
          </p>
        ) : (
          <>
            {/* Select-all sits above the list rather than inside it, so it
                cannot be mistaken for a row and ticked by accident. */}
            {hasPermission("document.move") && (
              <div className="mb-2 flex items-center gap-2 px-1">
                <button
                  className="flex items-center gap-1.5 text-xs text-base-400 hover:text-base-200"
                  onClick={toggleAllOnPage}
                  title="Select everything on this page (a)"
                >
                  {allOnPageSelected ? <CheckSquare size={14} className="text-brand-600" /> : <Square size={14} />}
                  {allOnPageSelected ? "Deselect all" : "Select all"}
                </button>
                <button
                  className="ml-auto flex items-center gap-1 text-[11px] text-base-500 hover:text-base-300"
                  onClick={() => setShowShortcuts(true)}
                  title="Keyboard shortcuts (?)"
                >
                  <Keyboard size={12} /> shortcuts
                </button>
              </div>
            )}
            {/* WINDOWED. The page size below is deliberately large -- the
                complaint this answers was "at best you can see five files at
                once and then you scroll forever" -- and a large page is only
                affordable because the DOM holds a screenful regardless of how
                many rows the page contains. Heights are measured rather than
                assumed: a search hit carries a snippet and a plain row does
                not. */}
            {/* MARQUEE HOST. Right-drag anywhere over the list draws a
                selection box; a right-click without movement still opens the
                normal context menu (lib/useMarqueeSelection). */}
            <div
              ref={marquee.containerRef}
              onMouseDown={marquee.onMouseDown}
              onContextMenu={marquee.onContextMenu}
              className={"min-h-0 flex-1" + (marquee.isDragging ? " select-none" : "")}
              style={{ minHeight: 320 }}
            >
              <List
                listRef={listRef}
                rowComponent={LibraryFileRow}
                rowCount={documents.length}
                rowHeight={fileRowHeight}
                rowProps={fileRowProps}
                rowKey={fileRowKey}
                style={{ height: "100%" }}
                overscanCount={6}
              />
            </div>
            {/* NEXT / PREVIOUS LITERAL MATCH.
                Only while searching, and only when something on this page
                actually says what was typed -- a control that is always
                present but usually does nothing teaches people to ignore it.
                Fixed to the right edge rather than placed above the list for
                the reason the selection bar is: appearing must not move the
                rows it is pointing at. */}
            {searching && matchIndexes.length > 0 && (
              <div className="fixed right-4 top-1/2 z-40 flex -translate-y-1/2 flex-col items-center gap-1 rounded-xl border border-line bg-surface/95 p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur">
                <button
                  className="rounded-lg p-1.5 text-base-500 transition-colors hover:bg-base-850 hover:text-base-100"
                  onClick={() => goToMatch(matchPos - 1)}
                  title="Previous match (shift+enter)"
                  aria-label="Previous match"
                >
                  <ChevronUp size={16} />
                </button>
                <span className="tabular px-1 text-[11px] leading-tight text-base-400">
                  {matchPos + 1}
                  <span className="text-base-600">/</span>
                  {matchIndexes.length}
                </span>
                <button
                  className="rounded-lg p-1.5 text-base-500 transition-colors hover:bg-base-850 hover:text-base-100"
                  onClick={() => goToMatch(matchPos + 1)}
                  title="Next match (enter)"
                  aria-label="Next match"
                >
                  <ChevronDown size={16} />
                </button>
              </div>
            )}

            <div className="mt-2">
              <Pagination offset={fileOffset} limit={FILES_LIMIT} pageCount={documents?.length} onChange={setFileOffset} />
            </div>
          </>
        )}
      </div>
    );
  }

  if (loading) return <PageSpinner />;

  return (
    <div>
      {/* Fixed-position, so it is never clipped by the scrolling list it is
          drawn over. */}
      <MarqueeBox rect={marquee.marqueeRect} />

      {/* One menu for the whole page, driven by right-click and by the dots
          button on each row. */}
      <FileContextMenu
        file={fileMenu.menu?.file}
        at={fileMenu.menu?.at}
        onClose={fileMenu.close}
        nativeShare={fileActions.nativeShareAvailable}
        actions={fileActions.actions}
      />
      <PageHeader
        title="Library"
        description="Everything you have, organized — and everything still waiting for a home."
        actions={
          <>
            {/* OUTSIDE the canManage gate, unlike before. Choosing how to LOOK
                at the library is not an editing privilege, and gating it meant
                a read-only user could not reach the map or the table at all --
                hiding the two views that are best at browsing from the people
                most likely to only be browsing. */}
            {/* Desktop only. On a phone both views render the same touch list
                (see the md:hidden block below), because a seven-column table
                on a 375px screen is not a view, it is a horizontal scroll with
                a table in it -- and offering a toggle that changes nothing is
                worse than not offering one. */}
            <div className="hidden items-center gap-0.5 rounded-lg border border-line-strong bg-base-900 p-0.5 md:flex">
              <button
                className={view === "list" ? "btn-secondary btn-sm" : "btn-ghost btn-sm"}
                onClick={() => changeView("list")}
                title="Folders beside their files"
              >
                <ListTree size={13} /> List
              </button>
              <button
                className={view === "table" ? "btn-secondary btn-sm" : "btn-ghost btn-sm"}
                onClick={() => changeView("table")}
                title="Dense sortable table — for scanning thousands at once"
              >
                <Table2 size={13} /> Table
              </button>
            </div>
            {canManage && (
              <button className="btn-secondary btn-sm" onClick={() => setFormTarget({ mode: "create", parentId: null })}>
                <Plus size={13} /> Add folder
              </button>
            )}
          </>
        }
      />

      {/* THE search box. One input, and it searches documents -- see the note
          on docQuery. Full width and above everything because on the front
          door of a document system, "find me the thing" is the primary verb. */}
      <div className="relative mb-3">
        <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-base-400" />
        <input
          ref={fileSearchRef}
          className="input pl-10 text-sm"
          placeholder="Search your documents — by name, contents, or what they're about…   (press /)"
          value={docQuery}
          onChange={(e) => setDocQuery(e.target.value)}
          // Enter walks the matches without leaving the search box, which is
          // the gesture this borrows from -- browser find, chat search, every
          // editor. Shift reverses it. Doing nothing on Enter would be the
          // one keystroke a person is certain to try here.
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !matchIndexes.length) return;
            e.preventDefault();
            goToMatch(e.shiftKey ? matchPos - 1 : matchPos + 1);
          }}
        />
        {docQuery && (
          <button
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-base-500 hover:text-base-200"
            onClick={() => setDocQuery("")}
            title="Clear"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* The state of the archive, above everything, because "how much of my
          stuff is sorted" is the question this page exists to answer and the
          unfiled count is the one number that leads somewhere. */}
      <LibraryOverview
        summary={overview}
        loading={loadingOverview}
        unfiledActive={unfiledMode}
        onShowUnfiled={openUnfiled}
      />

      {/* Above the tree, because it changes the tree: the counts on every
          node are counts of the filtered set. showSubject is off -- the tree
          IS the subject picker. */}
      <FileFilters value={filters} onChange={setFilters} showSubject={false} />

      {activeFilters > 0 && (
        <p className="mb-3 text-xs text-amber-700/90">
          Filters are on — every count in the tree, and the files listed for a subject, describe only the
          matching files.
        </p>
      )}

      {subjectsError ? (
        <ErrorState error={subjectsError} onRetry={reloadSubjects} title="Couldn't load the taxonomy" />
      ) : (!subjects?.length && unfiledCount === 0) ? (
        /* NOTHING AT ALL: no folders, no documents. A brand-new account.
           The whole page becomes the invitation, because there is genuinely
           nothing else to show and the one useful thing to do is decide how
           this library should be shaped. */
        <LibraryOnboarding
          unfiledCount={0}
          canManage={canManage}
          onCreateFolder={() => setFormTarget({ mode: "create", parentId: null })}
        />
      ) : view === "table" ? (
        /* THE TABLE.
           No tree column: this view exists for the case where the archive is
           too big to browse a hierarchy, and giving two fifths of the screen
           to a folder list would be spending the space on the thing that
           stopped working at that size. The scope bar replaces it in one
           line. */
        <LibraryTable
          rows={rows}
          loading={loadingDocs}
          scopeLabel={searching ? `“${debouncedDocQuery}”` : unfiledMode ? "Unfiled" : selected ? selected.name : "Everything"}
          scopeTotal={scopeTotal}
          searching={searching}
          sort={sort}
          onSort={toggleSort}
          selectedFileIds={selectedFileIds}
          cursor={cursor}
          onToggle={toggleFile}
          onToggleAll={toggleAllOnPage}
          allOnPageSelected={allOnPageSelected}
          canSelect={hasPermission("document.move")}
          // The exact handlers the card list uses, so the two views cannot
          // disagree about what a click means (see fileRowProps above).
          onRowClick={fileRowProps.onSelectRow}
          onOpenFile={fileRowProps.onOpen}
          onContextMenu={fileRowProps.onContextMenu}
          offset={fileOffset}
          limit={pageSize}
          onOffsetChange={setFileOffset}
          selectionBar={selectedCount > 0 ? (
            // Floating, for the same reason the list view's bar is -- see the
            // comment there. Both views must agree about whether picking a
            // file moves the page.
            <div className="floating-bar fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 px-3 py-2">
              <span className="text-sm font-medium text-brand-700">{selectedCount.toLocaleString()} selected</span>
              {hasPermission("document.move") && (
                <button className="btn-primary btn-sm" onClick={() => setBulkFileOpen(true)}>
                  <FolderInput size={13} /> File {selectedCount.toLocaleString()}…
                </button>
              )}
              {scopeTotal !== null && scopeTotal > rows.length && (
                <button className="btn-ghost btn-sm" onClick={selectAllMatching} disabled={selectingAll}>
                  {selectingAll ? "Selecting…" : `Select all ${scopeTotal.toLocaleString()}`}
                </button>
              )}
              <button className="btn-ghost btn-sm text-base-400" onClick={clearSelection}>Clear</button>
            </div>
          ) : null}
          scopePicker={
            <select
              className="input h-8 w-auto py-0 text-xs"
              value={unfiledMode ? "__unfiled__" : selectedId || ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__unfiled__") openUnfiled();
                else openSubject(v || null);
              }}
            >
              <option value="">Everything</option>
              <option value="__unfiled__">Unfiled ({unfiledCount.toLocaleString()})</option>
              {(subjects || []).map((s) => (
                <option key={s.id} value={s.id}>{s.materialized_path || s.name}</option>
              ))}
            </select>
          }
        />
      ) : (
        <>
        {/* DOCUMENTS BUT NO FOLDERS. Not an empty library -- a library that
            has everything and no shelves yet. The documents stay visible and
            the invitation sits above them, because someone in this state can
            act on either one and hiding half of it helps nobody. */}
        {!subjects?.length && (
          <LibraryOnboarding
            unfiledCount={unfiledCount}
            canManage={canManage}
            onCreateFolder={() => setFormTarget({ mode: "create", parentId: null })}
            compact
          />
        )}
        {/* A MEASURED FLOOR FOR THE TREE, EVERYTHING ELSE TO THE FILES.
              This was a 12-column grid, and the file list wanted more of it --
              but taking the tree from 3/12 to 2/12 made folder names
              unreadable, because a percentage has no idea how wide a word is.
              At 1280px, 2/12 is ~200px minus padding, and the names truncated
              to nothing.
              So the tree is sized in rem instead: 14rem is enough for a real
              folder name and its count, and it never gets less no matter how
              narrow the window. Past ~82rem the 17% cap takes over so it does
              not sprawl on a wide monitor. `minmax(0,1fr)` on the file column
              is load-bearing -- without the 0 floor a long filename sets the
              column's min-content width and pushes the grid wider than the
              page. */}
          {/* PHONE: one touch list, folders then files. The two-pane grid
              below is a pointer layout -- a tree beside a table, hover-revealed
              actions, double-click to open -- and none of that survives a
              finger, which is why the mobile Library had no way to open a file
              or select two of them. Same data, same handlers, different model. */}
          <div className="md:hidden">
            <MobileLibrary
              folders={mobileFolders}
              files={rows}
              query={searching ? debouncedDocQuery : ""}
              loading={loadingDocs}
              emptyMessage={
                searching ? `Nothing matches “${debouncedDocQuery}”.`
                  : unfiledMode ? "Nothing is waiting to be filed."
                    : "This folder is empty."
              }
              selectedFileIds={selectedFileIds}
              selectedFolderIds={selectedSubjectIds}
              onToggleFile={toggleFileById}
              onToggleFolder={toggleFolderById}
              onEnterFolder={(folder) => openSubject(folder.id)}
              onOpenFile={(file) => openFile(file)}
              onPreviewFile={(file) => setPreviewFileId(file.id)}
              onClearSelection={() => { clearSelection(); setSelectedSubjectIds(new Set()); }}
              onSelectAll={() => {
                setSelectedFileIds(new Set(rows.map((r) => r.id)));
                setSelectedSubjectIds(new Set(mobileFolders.map((f) => f.id)));
              }}
              onMove={(row, kind) => {
                // One row swiped -> move just that one. No row -> the action
                // bar, which acts on the whole selection.
                if (row && kind === "file") setMoveFileTarget(row);
                else setBulkFileOpen(true);
              }}
              onArchive={(row) => sendToBin(row ? [row.id] : [...selectedFileIds], "archive")}
              onTrash={(row) => sendToBin(row ? [row.id] : [...selectedFileIds], "trash")}
              onFileMenu={(file) => setSelectedFileId(file.id)}
              // One row swiped shares that file; the action bar shares the
              // whole selection. Same lib/shareFile either way.
              onShare={(file) => (file ? shareFiles([file], { onNotice: push }) : shareSelection())}
              canModify={hasPermission("document.move")}
              canDelete={hasPermission("document.delete")}
              header={
                <LibraryBreadcrumb
                  subjects={subjects}
                  selected={selected}
                  unfiledMode={unfiledMode}
                  searching={searching}
                  query={debouncedDocQuery}
                  count={searching ? null : unfiledMode ? unfiledCount : scopeTotal}
                  countLabel="file"
                  onNavigate={(id) => (id ? openSubject(id) : openSubject(null))}
                  onClearSearch={() => setDocQuery("")}
                />
              }
            />
          </div>

          {/* Two things fix the "click a subject at the bottom, then scroll
              back up to see its files" problem:
              1. The tree scrolls inside its own pane instead of growing the
                 page, so the file panel (which renders at the TOP of the
                 next column) never ends up scrolled off screen above.
              2. `items-start` on the grid, so the detail panel below has
                 room to travel and `position: sticky` actually applies --
                 grid items stretch to equal height by default, which leaves
                 sticky nothing to stick within.

              THE COLUMN WIDTH COMES FROM A CSS VARIABLE, not from an inline
              `gridTemplateColumns`. Below `lg` this is a single stacked
              column, and an inline template would have won at every width --
              putting a 320px folder pane beside a 60px sliver of files on a
              tablet. `.library-split` (index.css) applies the variable only
              inside the `lg` media query, so the responsive behaviour stays
              where the rest of the app keeps it. */}
          <div
            ref={attachSplit}
            className="library-split hidden grid-cols-1 items-start gap-4 md:grid"
            style={{ "--library-tree-w": treeCollapsed ? `${TREE_RAIL_WIDTH}px` : `${treeWidth}px` }}
          >
          {treeCollapsed ? (
            /* COLLAPSED: a rail, not a hidden pane.
               Removing the column entirely would give the files everything and
               leave nothing to click to get the folders back -- so the way out
               has to live where the pane was. One button, the full height of
               the pane, so it is impossible to miss and impossible to hit by
               accident on the way to something else. */
            <button
              type="button"
              onClick={toggleTreeCollapsed}
              title="Show folders"
              aria-label="Show the folder pane"
              aria-expanded={false}
              className="glass-card flex w-full flex-col items-center gap-2 py-3 text-base-500 transition-colors hover:bg-base-850 hover:text-brand-700"
              style={{ height: PANE_HEIGHT }}
            >
              <PanelLeftOpen size={16} aria-hidden="true" />
              {/* Upright, so the rail can be narrow enough to be worth
                  collapsing to. `writing-mode` rather than a rotation: a
                  rotated element keeps its original box, so the column would
                  still have to be as wide as the word is long. */}
              <span className="text-[11px] font-medium [writing-mode:vertical-rl]">Folders</span>
            </button>
          ) : (
          <div className="glass-card relative flex flex-col" style={{ height: PANE_HEIGHT }}>
            {/* Windowed: see components/SubjectTreePane.jsx. The folder search,
                the open/closed state and the flattening all live in there,
                because none of them can work per-row once rows unmount. */}
            <SubjectTreePane
              subjects={subjects}
              selectedId={selectedId}
              onSelect={(node, e) => {
                // Same rule as the file rows, so one gesture means one thing
                // across the whole Library: ctrl-click picks things out,
                // a plain click goes somewhere.
                if (e && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  toggleSubject(node.id);
                  return;
                }
                openSubject(node.id);
              }}
              selectedSubjectIds={selectedSubjectIds}
              canManage={canManage}
              onAddChild={(parent) => setFormTarget({ mode: "create", parentId: parent.id })}
              onEdit={(subject) => setFormTarget({ mode: "edit", subject })}
              onDelete={(subject) => setDeleteSubjectTarget(subject)}
              onDropFile={hasPermission("classification.modify") ? reclassifyByDrop : null}
              onDropSubject={canManage ? moveSubjectByDrop : null}
              header={
                /* THE UNFILED PILE, PINNED ABOVE THE TREE. It is not a folder
                   and deliberately does not pretend to be one -- it is the
                   absence of one. But it is the most-visited destination on
                   this page for anyone still sorting, so it sits where a
                   destination sits. */
                <>
                  <button
                    onClick={openUnfiled}
                    className={
                      "mb-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors " +
                      (unfiledMode
                        ? "bg-amber-500/15 text-amber-700 ring-1 ring-inset ring-amber-400/40"
                        : "text-base-300 hover:bg-base-850")
                    }
                    title="Everything that hasn't been filed under a folder yet"
                  >
                    <FolderOpen size={14} className={unfiledMode ? "text-amber-700" : "text-base-500"} />
                    <span className="min-w-0 flex-1 truncate font-medium">Unfiled</span>
                    <span className={"shrink-0 tabular-nums text-xs " + (unfiledCount ? "text-amber-700/90" : "text-base-600")}>
                      {unfiledCount.toLocaleString()}
                    </span>
                  </button>
                  {/* ARCHIVE AND TRASH, PINNED LIKE UNFILED.
                      They render as destinations rather than folders because
                      that is what they are -- there is no row in `subjects` to
                      rename or delete, which is exactly why they cannot be
                      renamed or deleted. Both accept a dropped file. */}
                  {[
                    { key: "archive", label: "Archive", icon: ArchiveIcon, count: binSummary?.archived || 0,
                      hint: "Hidden from listings, kept forever" },
                    { key: "trash", label: "Trash", icon: Trash2, count: binSummary?.trashed || 0,
                      hint: `Removed for good after ${binSummary?.retentionDays ?? 30} days` },
                  ].map((bin) => (
                    <button
                      key={bin.key}
                      onClick={() => openBin(bin.key)}
                      title={bin.hint}
                      onDragOver={(e) => {
                        if (![...e.dataTransfer.types].includes("text/dms-file-id")) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setBinDropTarget(bin.key);
                      }}
                      onDragLeave={() => setBinDropTarget(null)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setBinDropTarget(null);
                        const fileId = e.dataTransfer.getData("text/dms-file-id");
                        if (fileId) sendToBin(fileId, bin.key);
                      }}
                      className={
                        "mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors " +
                        (binDropTarget === bin.key
                          ? "bg-brand-500/25 ring-1 ring-inset ring-brand-400/60 text-brand-700"
                          : lifecycleMode === bin.key
                            ? "bg-base-800 text-base-100"
                            : "text-base-400 hover:bg-base-850")
                      }
                    >
                      <bin.icon size={14} className="shrink-0 text-base-500" />
                      <span className="min-w-0 flex-1 truncate">{bin.label}</span>
                      {bin.count > 0 && (
                        <span className="shrink-0 tabular-nums text-xs text-base-500">{bin.count.toLocaleString()}</span>
                      )}
                    </button>
                  ))}
                  <div className="mb-2 border-b border-line" />
                </>
              }
            />

            {/* THE SPLITTER.
                Inside the card and overhanging its right edge rather than a
                third grid column: a real column would need its own gap
                arithmetic on both sides, and the strip would then be part of
                the layout it is measuring. This is 9px of hit area centred on
                the card's border, which is what makes it findable with a mouse
                without being a visible bar in a design that has none.

                Hidden below `lg`, where the grid stacks and there is no
                horizontal split to move.

                role="separator" with the aria-value* triple, and arrow keys,
                because this IS a control -- a pane sized only by dragging is a
                pane a keyboard user cannot size. Home resets to the default,
                which is also what double-clicking does. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the folder pane"
              aria-valuenow={treeWidth}
              aria-valuemin={TREE_WIDTH_MIN}
              aria-valuemax={TREE_WIDTH_MAX}
              tabIndex={0}
              onPointerDown={(e) => { e.preventDefault(); setResizing(true); }}
              onDoubleClick={() => commitTreeWidth(TREE_WIDTH_DEFAULT)}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 64 : 16;
                // From the RENDERED width, not the stored preference: arrowing
                // left from a pane the window is currently squeezing should
                // move from what is on screen, not jump to a wider number the
                // user cannot see.
                if (e.key === "ArrowLeft") { e.preventDefault(); commitTreeWidth(treeWidth - step); }
                else if (e.key === "ArrowRight") { e.preventDefault(); commitTreeWidth(treeWidth + step); }
                else if (e.key === "Home") { e.preventDefault(); commitTreeWidth(TREE_WIDTH_DEFAULT); }
              }}
              title="Drag to resize · double-click to reset"
              className={
                "absolute -right-[5px] inset-y-0 z-10 hidden w-[9px] cursor-col-resize lg:block " +
                "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:rounded-full " +
                "after:transition-colors hover:after:bg-brand-400/70 focus-visible:outline-none focus-visible:after:bg-brand-500 " +
                (resizing ? "after:bg-brand-500" : "after:bg-transparent")
              }
            />

            {/* Collapse. Bottom-left of the pane, away from the row actions
                that appear on hover at the top-right of every folder -- a
                control that hides the whole pane should not sit under the
                cursor while someone is aiming at a folder's Rename. */}
            <button
              type="button"
              onClick={toggleTreeCollapsed}
              aria-expanded
              aria-label="Hide the folder pane"
              title="Hide the folder pane"
              className="absolute bottom-2 left-2 hidden rounded-lg p-1.5 text-base-500 transition-colors hover:bg-base-850 hover:text-base-200 lg:block"
            >
              <PanelLeftClose size={14} aria-hidden="true" />
            </button>
          </div>
          )}

          {/* Sticky on wide screens so the files stay in view no matter how
              far down the tree the selection is. On narrow screens the
              columns stack, so the panel is scrolled into view instead --
              see the effect on selectedId. */}
          {/* A flex COLUMN with a definite height, not a scrolling box: the
              windowed list inside owns the scrolling, and it can only size
              itself against a parent that has a height to give it. */}
          <div
            ref={detailPanelRef}
            className="glass-card flex flex-col p-4 lg:sticky lg:top-2"
            style={{ height: PANE_HEIGHT }}
          >
            {lifecycleMode ? renderBinPanel() : renderFilePanel()}
          </div>
        </div>
        </>
      )}

      <SubjectFormModal
        target={formTarget}
        subjects={subjects || []}
        onClose={() => setFormTarget(null)}
        onSaved={(savedId) => {
          setFormTarget(null);
          reloadSubjects();
          push(formTarget?.mode === "edit" ? "Subject updated." : "Subject created.", "success");
          if (formTarget?.mode === "create" && savedId) openSubject(savedId);
        }}
      />


      {/* The assistant itself now lives in the app shell (Layout) so it is
          available on every page. This page just publishes what is on
          screen -- see usePublishAssistantContext above. */}

      <ConfirmDialog
        open={Boolean(deleteSubjectTarget)}
        onClose={() => setDeleteSubjectTarget(null)}
        onConfirm={confirmDeleteSubject}
        loading={deletingSubject}
        danger
        title="Delete folder"
        confirmLabel="Delete"
        body={
          removalPreview?.filesAffected > 0 ? (
            <div className="mt-3 space-y-1.5">
              <p className="label">What happens to the {removalPreview.filesAffected.toLocaleString()} document
                {removalPreview.filesAffected === 1 ? "" : "s"} inside?</p>
              {[
                { key: "unfile", label: "Leave them in the repository, with no folder",
                  hint: "They appear in Unfiled and stay searchable." },
                { key: "trash", label: "Move them to the Trash with the folder",
                  hint: `Recoverable for ${binSummary?.retentionDays ?? 30} days, then removed for good.` },
              ].map((opt) => (
                <label key={opt.key} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-base-900">
                  <input
                    type="radio"
                    className="mt-0.5"
                    checked={deleteContents === opt.key}
                    onChange={() => setDeleteContents(opt.key)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-base-200">{opt.label}</span>
                    <span className="block text-xs text-base-500">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : null
        }
        description={
          !deleteSubjectTarget
            ? ""
            : !removalPreview
              ? `Delete "${deleteSubjectTarget.name}"?`
              : [
                  `Delete "${deleteSubjectTarget.name}"`,
                  removalPreview.subfolders
                    ? ` and the ${removalPreview.subfolders} folder${removalPreview.subfolders === 1 ? "" : "s"} inside it`
                    : "",
                  "? ",
                  removalPreview.filesAffected
                    ? `${removalPreview.filesAffected.toLocaleString()} document${removalPreview.filesAffected === 1 ? "" : "s"} filed there ` +
                      `will become unfiled — nothing is deleted from your disk and no document is removed, they just lose this folder.`
                    : "Nothing is filed there.",
                ].join("")
        }
      />

      {/* PERMANENT DELETION -- the only thing here that cannot be undone.
          Typing the phrase is the second step; the API refuses the request
          without it, so this dialog and the server agree on what counts as
          confirmation rather than the UI being the only guard. */}
      <Modal
        open={Boolean(purgeTarget)}
        onClose={() => { setPurgeTarget(null); setPurgePhrase(""); }}
        title="Delete forever"
      >
        <div className="space-y-3">
          <p className="text-sm text-base-300">
            This removes {purgeTarget?.length === 1 ? "this file" : `these ${purgeTarget?.length} files`} from Atlas
            for good. <strong className="text-base-100">It cannot be undone.</strong>
          </p>
          <p className="text-xs text-base-500">
            Your original file on disk is not touched — Atlas never deletes the documents it indexes. If the file is
            still on the drive, a future scan will find it again.
          </p>
          <div>
            <label className="label mb-1.5 block">
              Type <span className="font-mono text-base-200">permanently delete</span> to confirm
            </label>
            <input
              className="input"
              value={purgePhrase}
              onChange={(e) => setPurgePhrase(e.target.value)}
              placeholder="permanently delete"
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-ghost btn-sm" onClick={() => { setPurgeTarget(null); setPurgePhrase(""); }}>
              Cancel
            </button>
            <button
              className="btn-danger btn-sm"
              disabled={purgePhrase.trim().toLowerCase() !== "permanently delete" || purging}
              onClick={async () => {
                setPurging(true);
                try {
                  const res = await api.post("/files/lifecycle/purge", {
                    fileIds: purgeTarget,
                    confirm: "permanently delete",
                  });
                  push(`${res.purged} file${res.purged === 1 ? "" : "s"} deleted for good.`, "success");
                  setPurgeTarget(null);
                  setPurgePhrase("");
                  clearSelection();
                  reloadEverything();
                } catch (err) {
                  push(err.message, "error");
                } finally {
                  setPurging(false);
                }
              }}
            >
              {purging ? "Deleting…" : "Delete forever"}
            </button>
          </div>
        </div>
      </Modal>

      <FileDetailModal
        fileId={selectedFileId}
        onClose={() => setSelectedFileId(null)}
        onEdit={(f) => { setSelectedFileId(null); setEditFileTarget(f); }}
        onMove={(f) => { setSelectedFileId(null); setMoveFileTarget(f); }}
        onDelete={(f) => { setSelectedFileId(null); setRemoveFileTarget(f); }}
      />

      <PreviewModal
        fileId={previewFileId}
        filename={previewFile?.display_name || previewFile?.filename_current}
        onDownload={(id) => downloadFile(id, previewFile?.display_name || previewFile?.filename_current)}
        onClose={() => setPreviewFileId(null)}
      />

      <EditFileModal
        file={editFileTarget}
        onClose={() => setEditFileTarget(null)}
        onSaved={() => { setEditFileTarget(null); reloadFiles(); push("File updated.", "success"); }}
      />

      <MoveFileModal
        file={moveFileTarget}
        onClose={() => setMoveFileTarget(null)}
        onMoved={() => { setMoveFileTarget(null); reloadFiles(); push("File moved.", "success"); }}
      />

      <ConfirmDialog
        open={Boolean(removeFileTarget)}
        onClose={() => setRemoveFileTarget(null)}
        onConfirm={confirmRemoveFile}
        loading={removingFile}
        danger
        title="Remove file"
        confirmLabel="Remove"
        description={
          removeFileTarget
            ? `Remove "${removeFileTarget.display_name || removeFileTarget.filename_current}"? It's marked deleted (not erased) and any pending rename proposal for it is cancelled.`
            : ""
        }
      />

      {/* Filing the selection. The SAME component Photos and Failed use,
          pointed at /files/move -- which reaches the same
          fileOrganizeService.moveManyToSubject they do. It already knows how
          to ask about duplicates once for a whole batch instead of once per
          file, which is the hard part of bulk filing and was already solved. */}
      {bulkFileOpen && (
        <MoveManyModal
          fileIds={[...selectedFileIds]}
          endpoint="/files/move"
          title={`File ${selectedCount.toLocaleString()} document${selectedCount === 1 ? "" : "s"}`}
          onClose={() => setBulkFileOpen(false)}
          onMoved={() => {
            setBulkFileOpen(false);
            clearSelection();
            // All three: the file list, the tree counts, and the unfiled
            // total in the strip above all just changed.
            reloadEverything();
          }}
        />
      )}

      <Modal
        open={showShortcuts}
        onClose={() => setShowShortcuts(false)}
        title="Keyboard"
        width="max-w-sm"
      >
        <dl className="space-y-2 text-sm">
          {[
            ["j / k", "Move down / up the list"],
            ["x", "Select the row you're on"],
            ["shift-x", "Select from the last one to here"],
            ["a", "Select everything on this page"],
            ["f", "File what's selected"],
            ["Enter", "Open the document"],
            ["/", "Jump to the search box"],
            ["Esc", "Clear the selection"],
          ].map(([key, what]) => (
            <div key={key} className="flex items-center gap-3">
              <dt className="w-24 shrink-0">
                <kbd className="rounded border border-line-strong bg-base-800 px-1.5 py-0.5 font-mono text-xs text-base-200">
                  {key}
                </kbd>
              </dt>
              <dd className="text-base-300">{what}</dd>
            </div>
          ))}
        </dl>
      </Modal>
    </div>
  );
}

/**
 * The count beside a subject in the tree.
 *
 * Shows the total INCLUDING descendants, because a parent like "Finance"
 * typically holds nothing directly while its children hold everything --
 * showing only the direct count would label most branches "0" and make a
 * populated taxonomy look empty. When the two differ, the tooltip breaks it
 * down so the number is never ambiguous.
 */
function SubjectFormModal({ target, subjects, onClose, onSaved }) {
  const { push } = useToast();
  const open = Boolean(target);
  const mode = target?.mode;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (mode === "edit") {
      setName(target.subject?.name || "");
      setDescription(target.subject?.description || "");
      setParentId(target.subject?.parent_id || "");
    } else {
      setName("");
      setDescription("");
      setParentId(target.parentId || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, target?.subject?.id, target?.parentId]);

  const parentOptions = useMemo(
    () => subjects.filter((s) => s.level !== "subcategory" && s.id !== target?.subject?.id),
    [subjects, target?.subject?.id]
  );

  /**
   * FOLDERS WITH THE SAME NAME ARE ALLOWED, AND WORTH MENTIONING.
   *
   * "Photos" under Personal and "Photos" under Work are both reasonable, and
   * the system files by id, so nothing breaks. What breaks is the PERSON: two
   * identical labels in a tree of thousands, in a search result, or in the
   * assistant's reply, and no way to tell which one you are looking at.
   *
   * So this warns, it does not refuse -- a duplicate name is a smell, not an
   * error, and the user is the only one who knows whether theirs is deliberate.
   * A sibling clash is called out more strongly than a distant one, because two
   * folders with the same name inside the SAME parent are almost never intended.
   *
   * Case- and accent-insensitive: "Photos", "photos" and "Photos " are the same
   * name to everyone except a string comparison.
   */
  const normaliseName = (v) =>
    String(v || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const nameClash = useMemo(() => {
    const needle = normaliseName(name);
    if (!needle) return null;
    const parent = parentId || null;
    const matches = subjects.filter(
      (sub) => sub.id !== target?.subject?.id && normaliseName(sub.name) === needle
    );
    if (matches.length === 0) return null;
    const sibling = matches.find((m) => (m.parent_id || null) === parent);
    return { matches, sibling: sibling || null };
  }, [name, parentId, subjects, target?.subject?.id]);

  /** "Photos" -> "Photos 2", or the next free number if that is taken too. */
  const suggestedName = useMemo(() => {
    if (!nameClash) return null;
    const base = name.trim().replace(/\s+\d+$/, "");
    const taken = new Set(subjects.map((sub) => normaliseName(sub.name)));
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${base} ${n}`;
      if (!taken.has(normaliseName(candidate))) return candidate;
    }
    return null;
  }, [nameClash, name, subjects]);

  // Context-specific title so it's unambiguous which level is being
  // created -- "Add subject" (top level) reads very differently from
  // "Add subcategory under Finance -> Budgets", and users flagged the
  // generic modal as making it unclear whether nesting was even possible.
  const parentForCreate = mode === "create" && target?.parentId
    ? subjects.find((s) => s.id === target.parentId)
    : null;
  const createLevelLabel = parentForCreate ? (parentForCreate.level === "subject" ? "category" : "subcategory") : "subject";
  const modalTitle = mode === "edit"
    ? "Rename subject"
    : parentForCreate
      ? `Add ${createLevelLabel} under ${parentForCreate.materialized_path || parentForCreate.name}`
      : "Add subject";

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) { push("Name is required.", "error"); return; }

    setSaving(true);
    try {
      if (mode === "edit") {
        await api.patch(`/subjects/${target.subject.id}`, { name: trimmed, description: description.trim() || null });
        onSaved();
      } else {
        const created = await api.post("/subjects", {
          parentId: parentId || null,
          name: trimmed,
          description: description.trim() || null,
        });
        onSaved(created?.id);
      }
    } catch (err) {
      push(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={modalTitle}
      width="max-w-sm"
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : mode === "edit" ? "Save changes" : "Create"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label mb-1.5 block">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {nameClash && (
            <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
              <p>
                {nameClash.sibling ? (
                  <>There is already a folder called <strong>{nameClash.sibling.name}</strong> in this same place.</>
                ) : (
                  <>
                    You already have {nameClash.matches.length === 1 ? "a folder" : `${nameClash.matches.length} folders`}{" "}
                    called <strong>{nameClash.matches[0].name}</strong>
                    {nameClash.matches[0].materialized_path ? ` (${nameClash.matches[0].materialized_path})` : ""}.
                  </>
                )}{" "}
                That is allowed — but two folders with the same name are hard to tell apart later.
              </p>
              {suggestedName && (
                <button
                  type="button"
                  onClick={() => setName(suggestedName)}
                  className="mt-1.5 rounded-md border border-amber-400/40 px-2 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-500/20"
                >
                  Use “{suggestedName}” instead
                </button>
              )}
            </div>
          )}
        </div>

        {mode === "edit" ? (
          <p className="text-xs text-base-500">
            Nested under: <span className="font-mono">{target?.subject?.materialized_path || "top level"}</span>
          </p>
        ) : (
          <div>
            <label className="label mb-1.5 block">Parent</label>
            <select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">— Top level —</option>
              {parentOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.materialized_path || s.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-base-500">Up to three levels deep: Subject → Category → Subcategory.</p>
          </div>
        )}

        <div>
          <label className="label mb-1.5 block">Description</label>
          <textarea
            className="input"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>
      </div>
    </Modal>
  );
}
