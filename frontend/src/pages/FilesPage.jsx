import { useState, useEffect, useRef } from "react";
import {
  Search, FileText, Sparkles, Trash2, MoreVertical,
  RefreshCw, FolderOpen, Check, Clock, Minus, Cloud,
} from "lucide-react";
import { SearchSnippet, MatchReason } from "../components/SearchSnippet";
import { usePublishAssistantContext, useAssistantChanges } from "../context/AssistantContext";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { StatusBadge } from "../components/StatusBadge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Pagination } from "../components/Pagination";
import { FileDetailModal } from "../components/FileDetailModal";
import { FileFilters, EMPTY_FILTERS, filtersToParams, countActiveFilters } from "../components/FileFilters";
import { DocumentDate, DocumentDateInline, LocationLabel } from "../components/DocumentDate";
import { PreviewModal } from "../components/PreviewModal";
import { FileContextMenu, useFileContextMenu } from "../components/FileContextMenu";
import { openFileSmart } from "../lib/openFile";
import { EditFileModal } from "../components/EditFileModal";
import { MoveFileModal } from "../components/MoveFileModal";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { formatBytes } from "../utils/format";

const LIMIT = 25;

/** Where this file sits in the taxonomy, or that it doesn't sit anywhere. */
function SubjectCell({ file }) {
  if (!file.subject_name) {
    return (
      <span className="badge-neutral" title="Not classified into any subject yet — it won't appear on the Subjects page.">
        <FolderOpen size={10} /> unfiled
      </span>
    );
  }
  return (
    <span className="text-base-200" title={file.subject_path || file.subject_name}>
      {file.subject_name}
    </span>
  );
}

/**
 * Whether this file has actually been given a proper name, or is still
 * waiting on something. This is the question "is the system done with this
 * file?" -- previously unanswerable from the list.
 *
 * REJECTING A SUGGESTION IS AN ANSWER, NOT A FAILURE
 *
 * This used to render 'rejected' as a problem needing follow-up ("rename it
 * yourself, or use Retry"), which had it backwards. Rejecting a proposed name
 * means the name the file already has is the right one -- and the file is
 * still filed under its subject and still appears in the shortcut mirror
 * under that original name (see fileRepository.listForMirror: filing and
 * naming are separate decisions, and declining one never costs the other).
 * So there is nothing left to do, and a badge implying otherwise sent people
 * back to a queue to re-decide something they had already decided.
 */
const NAMING = {
  named: {
    label: "named",
    className: "badge-emerald",
    icon: Check,
    title: "A canonical name has been applied. On a read-only location the original file keeps its own name — this is the name used in the mirror and here.",
  },
  pending: {
    label: "pending",
    className: "badge-amber",
    icon: Clock,
    title: "A rename proposal is waiting for review on the Rename proposals page.",
  },
  rejected: {
    label: "original name kept",
    className: "badge-emerald",
    icon: Check,
    title: "You turned the suggested name down, which settles it: the file's own name is the right one. It's still filed under its subject and still appears in the shortcut mirror under this name. Nothing further is needed.",
  },
  none: {
    label: "no proposal",
    className: "badge-neutral",
    icon: Minus,
    title: "Nothing proposed yet — either still processing, or there wasn't enough signal to suggest a name.",
  },
};

function NamingCell({ file }) {
  const state = NAMING[file.naming_state] || NAMING.none;
  const Icon = state.icon;
  return (
    <span className={state.className} title={state.title}>
      <Icon size={10} /> {state.label}
    </span>
  );
}

// Offered in the per-page selector. 25 stays the default -- it is what the
// page was built around and what fits a laptop screen without scrolling the
// header away.
const PAGE_SIZES = [25, 50, 100, 200];

export function FilesPage() {
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  // Remembered across visits: someone who works at 100 rows a page is not
  // choosing that once, they are stating a preference. Guarded because
  // localStorage throws in private-mode Safari and a crash here would take
  // the whole page down for a cosmetic setting.
  const [limit, setLimit] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem("atlas.files.pageSize"));
      return PAGE_SIZES.includes(saved) ? saved : LIMIT;
    } catch {
      return LIMIT;
    }
  });
  const [selectedId, setSelectedId] = useState(null);
  // Which row is picked. Separate from `selectedId`, which is "whose detail
  // modal is open" -- those became two different things when single click
  // stopped opening the modal.
  const [pickedId, setPickedId] = useState(null);
  const fileMenu = useFileContextMenu();
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [removeAllOpen, setRemoveAllOpen] = useState(false);
  const [removingAll, setRemovingAll] = useState(false);
  const [previewFileId, setPreviewFileId] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [moveTarget, setMoveTarget] = useState(null);
  const [autoRefreshing, setAutoRefreshing] = useState(false);
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const pollRef = useRef(null);
  const { push } = useToast();
  const { hasPermission } = useAuth();

  // The subject dropdown's options. Filters are applied to it too, so the
  // list stays in step with what the rest of the page is showing.
  const { data: subjects } = useApiData(() => api.get("/subjects"), []);

  // The other classification axis (docs/03-taxonomy.md §3.4). Plain list, not
  // /browse: this is a dropdown's options, and it does not need counts.
  const { data: documentTypes } = useApiData(() => api.get("/document-types"), []);

  // Serialized into the dependency list because it is an object -- a new
  // identity every render would refetch forever.
  const filterParams = filtersToParams(filters);
  const filterKey = JSON.stringify(filterParams);

  // The search term the QUERY uses, held one beat behind the input.
  //
  // `q` was a direct dependency of the fetch, so every keystroke ran a full
  // ranked search across the whole repository -- typing "invoice" issued
  // seven of them, each scanning ~9,000 files and their extracted text, plus
  // seven /files/count calls behind them. The results of the first six were
  // discarded before anyone could read them.
  //
  // 300ms is the same interval SubjectsPage and CompareFilesModal already
  // debounce at; matching them keeps the app feeling consistent rather than
  // having one search box behave differently from the others.
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const { data: files, loading, error: filesError, reload, reloadSilently } = useApiData(
    () => api.get("/files", { q: debouncedQ || undefined, limit, offset, ...filterParams }),
    [debouncedQ, offset, limit, filterKey]
  );

  /**
   * Anything that changes WHICH rows match has to send you back to page 1.
   *
   * Staying on page 7 after narrowing 9,000 files to 30 lands on an offset
   * past the end, and an empty page is indistinguishable from "your filter
   * matched nothing" -- the single most confusing state this page can be in.
   * Guarded on `offset !== 0` so it does not fire a redundant re-render (and
   * therefore a redundant fetch) when you are already on the first page,
   * which is the common case.
   */
  useEffect(() => {
    setOffset((current) => (current === 0 ? current : 0));
  }, [debouncedQ, filterKey, limit]);

  const changeLimit = (next) => {
    setLimit(next);
    try {
      window.localStorage.setItem("atlas.files.pageSize", String(next));
    } catch {
      // A preference that cannot be saved is not worth failing over.
    }
  };

  // How many the filters match across the whole repository, not this page.
  // Skipped while a search term is active: counting a full-text search means
  // running the ranking twice and throwing one away (see fileService.count),
  // and the honest thing to report there is the page you are on.
  const { data: countData } = useApiData(
    () => (debouncedQ ? Promise.resolve(null) : api.get("/files/count", filterParams)),
    [debouncedQ, filterKey]
  );
  const { data: totalData } = useApiData(() => api.get("/files/count"), []);

  /** The default action. Same rule as the Library -- see lib/openFile. */
  function openFile(f) {
    return openFileSmart(f, {
      onPreview: (x) => setPreviewFileId(x.id),
      onDownload: (x) => downloadFile(x.id, x.filename_current),
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

  async function confirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.del(`/files/${removeTarget.id}`);
      push(`"${removeTarget.filename_current}" removed.`, "success");
      setRemoveTarget(null);
      reload();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setRemoving(false);
    }
  }

  /**
   * "Remove all" enqueues a background bulk_delete job rather than deleting
   * inline (see fileService.removeAllFiles), so a single reload() right
   * after triggering it almost always still shows every file -- the job has
   * barely started. That looked like the button had done nothing.
   *
   * Poll instead, until the list drains or we give up, and stop as soon as
   * the component unmounts so this can't keep firing on another page.
   */
  async function confirmRemoveAll() {
    setRemovingAll(true);
    try {
      await api.del("/files/remove-all");
      push("Removing all files — this runs in the background.", "success");
      setRemoveAllOpen(false);
      reload();
      startDrainPolling();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setRemovingAll(false);
    }
  }

  function startDrainPolling() {
    clearDrainPolling();
    let ticks = 0;
    setAutoRefreshing(true);
    pollRef.current = setInterval(() => {
      ticks += 1;
      // Silent: reload() flips `loading`, which renders the whole table as a
      // PageSpinner. Doing that every 2 seconds for a minute after "Remove
      // all files" made the list strobe and left the user unable to watch the
      // thing they were waiting on. useApiData provides reloadSilently for
      // exactly this and documents why.
      reloadSilently();
      // ~60s ceiling: long enough for a large library, bounded so a stuck
      // or failed job doesn't leave the page polling forever.
      if (ticks >= 30) {
        clearDrainPolling();
        push("Still working — check the Processing Jobs page for progress.", "info");
      }
    }, 2000);
  }

  function clearDrainPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setAutoRefreshing(false);
  }

  // Once the visible page is empty there is nothing left to drain here.
  useEffect(() => {
    if (autoRefreshing && files && files.length === 0) clearDrainPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, autoRefreshing]);

  useEffect(() => () => clearDrainPolling(), []);

  // Publish what is on screen so the assistant can act on it -- "rename the
  // invoice" needs to know which files the user can currently see.
  usePublishAssistantContext({
    page: "Files",
    description: q
      ? `Showing search results for "${q}" across file names and document contents.`
      : "Browsing all ingested files, newest first.",
    files: files || [],
  });

  useAssistantChanges(reload);

  // useApiData's reload() only bumps a tick -- it returns nothing to await,
  // so the button's spinning state comes from the hook's own `loading`
  // flag rather than a second piece of state that could disagree with it.

  return (
    <div>
      <PageHeader
        title="Files"
        description="Every physical file discovered across your registered storage locations."
        actions={
          <>
            <button
              className="btn-ghost btn-sm"
              onClick={reload}
              disabled={loading || autoRefreshing}
              title="Reload the file list"
            >
              <RefreshCw size={13} className={loading || autoRefreshing ? "animate-spin" : ""} />
              {autoRefreshing ? "Updating…" : "Refresh"}
            </button>
            {hasPermission("document.delete") && files?.length > 0 ? (
              <button
                className="btn-ghost btn-sm text-rose-600 hover:text-rose-700"
                onClick={() => setRemoveAllOpen(true)}
              >
                <Trash2 size={13} /> Remove all files
              </button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-400" />
          <input
            className="input pl-9"
            placeholder="Search, or just describe the file…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setOffset(0); }}
          />
        </div>
        {q && (
          <p className="text-xs text-base-500">
            Names, contents and descriptions — describing a file in your own words works,
            in French, Arabic, Hebrew or English.
          </p>
        )}
      </div>

      <FileFilters
        value={filters}
        onChange={(next) => { setFilters(next); setOffset(0); }}
        subjects={subjects}
        documentTypes={documentTypes}
        resultCount={countData?.count ?? null}
        totalCount={totalData?.count ?? null}
      />

      {loading ? (
        <PageSpinner />
      ) : filesError ? (
        <ErrorState error={filesError} onRetry={reload} title="Couldn't load files" />
      ) : !files?.length ? (
        <EmptyState
          icon={FileText}
          title="No files found"
          // "No files found" under an active filter reads as "this repository
          // is empty", which is the wrong conclusion and the reason the
          // filter chips stay visible above.
          description={
            countActiveFilters(filters) > 0
              ? "Nothing matches the current filters. Clear one to widen the search — note that a date range hides every file whose date is unknown."
              : "Register a storage location and run a scan to start ingesting files."
          }
          action={
            countActiveFilters(filters) > 0 ? (
              <button className="btn-secondary btn-sm" onClick={() => { setFilters({ ...EMPTY_FILTERS }); setOffset(0); }}>
                Clear filters
              </button>
            ) : null
          }
        />
      ) : (
        <div className="table-shell glass-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wider text-base-400">
                <th className="px-4 py-3 font-medium">Filename</th>
                <th className="col-secondary px-4 py-3 font-medium">Subject</th>
                <th className="col-tertiary px-4 py-3 font-medium">Naming</th>
                {/* Document date, not import date. "Imported" answered a
                    question nobody was asking -- this archive was assembled
                    from backups, so every file was "imported" the same week
                    and the column sorted at random. */}
                <th className="col-secondary px-4 py-3 font-medium" title="When the document is from — read out of the file where possible.">
                  Date
                </th>
                <th className="col-tertiary px-4 py-3 font-medium">Location</th>
                <th className="col-tertiary px-4 py-3 font-medium">Size</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr
                  key={f.id}
                  data-select-id={f.id}
                  // Same interaction model as the Library, deliberately: a file
                  // behaves the same way wherever it is listed. Single click
                  // selects, double click opens, right click offers the actions.
                  // Clicking used to open the detail modal, which is what made
                  // double-click impossible -- the modal caught the second click.
                  className={
                    "table-row-hover cursor-pointer border-b border-line last:border-0 " +
                    (pickedId === f.id ? "row-selected" : "")
                  }
                  onClick={() => setPickedId(f.id)}
                  onDoubleClick={(e) => { e.preventDefault(); openFile(f); }}
                  onContextMenu={(e) => { setPickedId(f.id); fileMenu.openAt(e, f); }}
                >
                  <td className="w-full max-w-0 px-4 py-3">
                    {/* max-w-0 + w-full below sm, and ONLY below sm.
                        `truncate` sets white-space: nowrap, so this cell's
                        MIN-CONTENT width is the full untruncated filename --
                        an auto-layout table honours that and pushes itself
                        wider than its shell, which is why dropping columns
                        alone still left the table scrolling sideways at 375px.
                        max-w-0 removes that floor and w-full then hands the
                        cell the slack, so the text truncates instead of the
                        table growing.

                        Applied at EVERY width, not just below sm: restoring the
                        old max-w-sm cap from sm up brought the overflow straight
                        back between 640px and roughly 900px, where the column
                        set is still wide but the cap is active again. Keeping it
                        uniform also lets the filename use the slack on a wide
                        screen instead of truncating at 384px with empty space to
                        its right. .table-shell still scrolls if a table genuinely
                        cannot fit; it just no longer has to here. */}
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium text-base-100">{f.ai_short_title || f.filename_current}</p>
                      {/* Status only when it is NOT the normal case -- a
                          column of 40 "active" badges is noise, but a file
                          that went missing off disk needs to be obvious. */}
                      {f.status !== "active" && <StatusBadge value={f.status} />}
                      {f.is_cloud_placeholder && (
                        <span className="badge-blue" title="Stored in the cloud and not downloaded locally — not indexed, so it won't match a content search.">
                          <Cloud size={10} /> cloud only
                        </span>
                      )}
                    </div>
                    {f.ai_summary ? (
                      <p className="mt-0.5 flex items-start gap-1 truncate text-xs text-base-400">
                        <Sparkles size={11} className="mt-0.5 shrink-0 text-brand-600" />
                        <span className="truncate">{f.ai_summary}</span>
                      </p>
                    ) : (
                      <p className="mt-0.5 truncate text-xs text-base-500">{f.filename_current}</p>
                    )}
                    <SearchSnippet snippet={f.snippet} />
                    <MatchReason file={f} />
                    {/* The two dropped values worth keeping on a phone. Hidden
                        again from `sm` up, where their own columns reappear,
                        so this never duplicates what is already on screen. */}
                    <div className="cell-subline">
                      <DocumentDateInline date={f.document_date} source={f.document_date_source} />
                      <span>{formatBytes(f.size_bytes)}</span>
                    </div>
                  </td>
                  <td className="col-secondary px-4 py-3"><SubjectCell file={f} /></td>
                  <td className="col-tertiary px-4 py-3"><NamingCell file={f} /></td>
                  <td className="col-secondary px-4 py-3">
                    <DocumentDate date={f.document_date} source={f.document_date_source} />
                  </td>
                  <td className="col-tertiary max-w-[10rem] px-4 py-3 text-xs text-base-400">
                    <LocationLabel name={f.location_name} isReadOnly={f.location_is_read_only} />
                    {f.current_path && (
                      <p className="mt-0.5 truncate font-mono text-[10px] text-base-600" title={f.current_path}>
                        {f.current_path}
                      </p>
                    )}
                  </td>
                  <td className="col-tertiary px-4 py-3 text-base-400">{formatBytes(f.size_bytes)}</td>
                  <td className="px-4 py-3 text-right">
                    {/* One affordance instead of five icons, matching the
                        Library. Everything that used to be a button is in the
                        menu, which right-click opens too. */}
                    <button
                      className="rounded-lg p-1 text-base-500 transition-colors hover:bg-base-850 hover:text-base-100"
                      onClick={(e) => { e.stopPropagation(); setPickedId(f.id); fileMenu.openAt(e, f); }}
                      title="Actions"
                      aria-label={`Actions for ${f.filename_current}`}
                      aria-haspopup="menu"
                    >
                      <MoreVertical size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* total only when it is known -- with a search term there is no
              count, and Pagination correctly falls back to an open-ended
              "Next" rather than inventing a last page. */}
          {/* countData is deliberately absent while a search term is active (see
          fileService.count), so pageCount carries the "is there a next page?"
          answer in that case. */}
      <Pagination
        offset={offset}
        limit={limit}
        total={countData?.count ?? undefined}
        pageCount={files?.length}
        onChange={setOffset}
        pageSizes={PAGE_SIZES}
        onLimitChange={changeLimit}
      />
        </div>
      )}

      <FileDetailModal
        fileId={selectedId}
        onClose={() => setSelectedId(null)}
        onEdit={(f) => { setSelectedId(null); setEditTarget(f); }}
        onMove={(f) => { setSelectedId(null); setMoveTarget(f); }}
        onDelete={(f) => { setSelectedId(null); setRemoveTarget(f); }}
      />

      <PreviewModal
        fileId={previewFileId}
        filename={files?.find((f) => f.id === previewFileId)?.filename_current}
        onDownload={(id) => downloadFile(id, files?.find((f) => f.id === id)?.filename_current)}
        onClose={() => setPreviewFileId(null)}
      />

      {/* The same menu component the Library uses, with the same actions in
          the same order -- so the gesture and the result are identical
          wherever a file is listed. */}
      <FileContextMenu
        file={fileMenu.menu?.file}
        at={fileMenu.menu?.at}
        onClose={fileMenu.close}
        actions={{
          onOpen: (f) => openFile(f),
          onPreview: hasPermission("document.download") ? (f) => setPreviewFileId(f.id) : null,
          onDetails: (f) => setSelectedId(f.id),
          onDownload: (f) => downloadFile(f.id, f.filename_current),
          onRename: hasPermission("document.rename") ? (f) => setEditTarget(f) : null,
          onMove: hasPermission("document.move") ? (f) => setMoveTarget(f) : null,
          onDelete: hasPermission("document.delete") ? (f) => setRemoveTarget(f) : null,
        }}
      />

      <EditFileModal
        file={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => { setEditTarget(null); reload(); push("File updated.", "success"); }}
      />

      <MoveFileModal
        file={moveTarget}
        onClose={() => setMoveTarget(null)}
        onMoved={() => { setMoveTarget(null); reload(); push("File moved.", "success"); }}
      />

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={confirmRemove}
        loading={removing}
        danger
        title="Remove file"
        confirmLabel="Remove"
        description={
          removeTarget
            ? `Remove "${removeTarget.filename_current}"? It's marked deleted (not erased) and any pending rename proposal for it is cancelled. If the same file is re-scanned later, a previously-rejected rename won't be re-proposed.`
            : ""
        }
      />

      <ConfirmDialog
        open={removeAllOpen}
        onClose={() => setRemoveAllOpen(false)}
        onConfirm={confirmRemoveAll}
        loading={removingAll}
        danger
        title="Remove all files"
        confirmLabel="Remove all"
        description="Remove every file across all storage locations? Each one is marked deleted (not erased from disk) and any pending rename proposals are cancelled, same as removing a single file. This runs as a background job — watch its progress on the Processing Jobs page. This cannot be undone from the UI."
      />
    </div>
  );
}
