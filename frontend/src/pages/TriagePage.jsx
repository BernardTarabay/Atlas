import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  LifeBuoy, RefreshCw, Trash2, Pencil, FolderInput, Eye, Activity, CheckSquare, Square,
  AlertTriangle, ScanLine, FileWarning, HelpCircle, CircleSlash, Hourglass,
} from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { Pagination } from "../components/Pagination";
import { PreviewModal } from "../components/PreviewModal";
import { EditFileModal } from "../components/EditFileModal";
import { MoveFileModal } from "../components/MoveFileModal";
import { MoveManyModal } from "../components/MoveManyModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { formatBytes } from "../utils/format";
import { DocumentDate, DocumentDateInline } from "../components/DocumentDate";

const LIMIT = 25;

/**
 * TRIAGE (task #42)
 *
 * One list of everything the pipeline could not confidently handle, with the
 * reason on the row and the fix next to it. Before this, each failure mode
 * was visible only as a number somewhere else -- "1,204 need OCR" on the
 * dashboard, "37 stalled" on a storage-location card, a failed job buried in
 * the job log -- and none of them was a list you could work through. So an
 * error did not stop the pipeline, it just quietly removed a file from it.
 *
 * The three actions are the three things that actually unstick a file:
 * rename it yourself, file it under a subject, or re-run the stage that
 * failed. All three are the same endpoints the Files page uses; nothing here
 * is a second way to change a file.
 *
 * Icon and colour are chosen per reason but never carry the meaning alone --
 * the label is always written out next to them.
 */
const REASON_UI = {
  missing:           { icon: CircleSlash,   badge: "badge-rose" },
  job_failed:        { icon: AlertTriangle, badge: "badge-rose" },
  extraction_failed: { icon: FileWarning,   badge: "badge-rose" },
  stalled:           { icon: Hourglass,     badge: "badge-amber" },
  needs_ocr:         { icon: ScanLine,      badge: "badge-amber" },
  unreadable:        { icon: HelpCircle,    badge: "badge-neutral" },
};

function ReasonBadge({ row }) {
  const ui = REASON_UI[row.reason] || REASON_UI.unreadable;
  const Icon = ui.icon;
  return (
    <span className={ui.badge} title={row.reasonExplanation}>
      <Icon size={10} /> {row.reasonLabel}
    </span>
  );
}

/**
 * The specific thing that went wrong on THIS file, under the general reason.
 * A queue that only says "job failed" six hundred times is a list, not an
 * explanation -- the error message is the part that tells you whether it is
 * one broken file or one broken extractor.
 */
function DetailCell({ row }) {
  const bits = [];
  if (row.last_job_status === "failed" && row.last_job_error) {
    bits.push(`${row.last_job_type}: ${row.last_job_error}`);
  }
  if (row.extraction_error) bits.push(row.extraction_error);
  if (row.text_quality && row.text_quality !== "ok") bits.push(`text quality: ${row.text_quality}`);
  if (!row.sha256_hash) bits.push("never hashed");

  if (bits.length === 0) return <span className="text-base-500">—</span>;
  return (
    <div className="space-y-0.5">
      {bits.map((b, i) => (
        <p key={i} className="line-clamp-2 break-words text-xs text-base-400" title={b}>{b}</p>
      ))}
    </div>
  );
}

export function TriagePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const reason = searchParams.get("reason") || "";
  const [offset, setOffset] = useState(0);
  const [busyId, setBusyId] = useState(null);
  const [previewFileId, setPreviewFileId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [moveTarget, setMoveTarget] = useState(null);
  const { push } = useToast();
  const { hasPermission } = useAuth();

  const { data: rows, loading, error: rowsError, reload, setData } = useApiData(
    () => api.get("/triage", { reason: reason || undefined, limit: LIMIT, offset }),
    [reason, offset]
  );

  // Counted server-side over the whole queue, not from the page of 25 above:
  // the entire point of this page is that the number may be in the thousands.
  const { data: summary, reload: reloadSummary } = useApiData(() => api.get("/triage/summary"), []);

  function setReason(next) {
    setOffset(0);
    setSearchParams(next ? { reason: next } : {}, { replace: true });
  }

  /**
   * Drops the row out of the list rather than refetching. Whatever just
   * happened to it -- retried, renamed, filed -- means it is either no longer
   * stuck or is now waiting on a job, and neither belongs in this view. Same
   * reasoning (and the same flicker avoided) as the rename-proposals queue.
   */
  function removeLocally(id) {
    setData((prev) => (prev || []).filter((r) => r.id !== id));
    reloadSummary();
  }

  /**
   * RETRY IS GONE FROM THIS PAGE, DELIBERATELY.
   *
   * It re-ran a pipeline stage, and for everything that actually collects in
   * this queue -- a photo with no text layer, a video, a document whose text
   * extracted as noise -- the stage reaches the same conclusion again, because
   * the conclusion is right. The file came straight back, so the button read
   * as doing nothing.
   *
   * What clears triage is a decision: put the file somewhere, or get rid of
   * it. Those are what this page offers now. The retry endpoint still exists
   * for a stage that died on a transient fault, and the Jobs page is where
   * that belongs -- it is a property of the failed job, not of the document.
   */
  async function removeOne(row) {
    setBusyId(row.id);
    try {
      await api.del(`/triage/${row.id}`);
      push(`Removed "${row.filename_current}". The file on disk is untouched.`, "success");
      removeLocally(row.id);
    } catch (err) {
      push(err.message, "error");
    } finally {
      setBusyId(null);
      setDeleteTarget(null);
    }
  }

  async function removeSelected() {
    const ids = [...selected];
    try {
      const r = await api.post("/triage/delete", { fileIds: ids });
      push(`Removed ${r.removed} file${r.removed === 1 ? "" : "s"}. Nothing was erased from disk.`, "success");
      ids.forEach(removeLocally);
      setSelected(new Set());
    } catch (err) {
      push(err.message, "error");
    } finally {
      setBulkDeleteOpen(false);
    }
  }

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const reasons = summary?.reasons || [];
  const total = summary?.total || 0;

  return (
    <div>
      <PageHeader
        title="Triage"
        description="Everything the pipeline could not confidently handle, with the reason — so a failure is a queue you can work through, not a file that quietly disappeared."
        actions={
          <button
            className="btn-ghost btn-sm"
            onClick={() => { reload(); reloadSummary(); }}
            disabled={loading}
            title="Reload"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        }
      />

      {/* Filters double as the summary: the count lives on the tab, so
          "how much of this is OCR?" is answered without clicking anything. */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setReason("")}
          className={reason === "" ? "btn-secondary btn-sm" : "btn-ghost btn-sm"}
        >
          All <span className="ml-1 tabular-nums text-base-400">{total.toLocaleString()}</span>
        </button>
        {reasons.map((r) => {
          const ui = REASON_UI[r.key] || REASON_UI.unreadable;
          const Icon = ui.icon;
          return (
            <button
              key={r.key}
              onClick={() => setReason(r.key)}
              title={r.explanation}
              // Empty reasons stay visible but muted -- "0 missing from disk"
              // is information, and hiding it would make the reasons that do
              // have files look like the only ones that exist.
              className={
                (r.key === reason ? "btn-secondary btn-sm" : "btn-ghost btn-sm") +
                (r.count === 0 ? " opacity-45" : "")
              }
            >
              <Icon size={13} /> {r.label}
              <span className="ml-1 tabular-nums text-base-400">{r.count.toLocaleString()}</span>
            </button>
          );
        })}
      </div>

      {summary?.inFlight > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-line-strong bg-base-900 px-3 py-2">
          <Activity size={13} className="shrink-0 animate-pulse text-brand-600" />
          <p className="text-xs text-base-300">
            <span className="font-medium text-base-100">{summary.inFlight.toLocaleString()}</span> file
            {summary.inFlight === 1 ? " is" : "s are"} still being processed and deliberately aren't listed here —
            they aren't stuck, they're queued. This list will grow if any of them fail.
          </p>
        </div>
      )}

      {loading ? (
        <PageSpinner />
      ) : rowsError ? (
        <ErrorState error={rowsError} onRetry={reload} title="Couldn't load the triage queue" />
      ) : !rows?.length ? (
        <EmptyState
          icon={LifeBuoy}
          title={reason ? "Nothing under this reason" : "Nothing needs triage"}
          description={
            reason
              ? "No files are currently stuck for this reason. Try another filter, or clear it to see the whole queue."
              : "Every file the pipeline has seen either finished or is still queued. Anything it gives up on shows up here with the reason attached."
          }
        />
      ) : (
        <>
        {selected.size > 0 && (
          <div className="glass-card mb-3 flex flex-wrap items-center gap-2 border-brand-500/25 bg-brand-500/[0.05] p-3">
            <span className="text-sm text-base-100">{selected.size} selected</span>
            <button className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
            <div className="flex-1" />
            {hasPermission("document.move") && (
              <button className="btn-primary btn-sm" onClick={() => setBulkMoveOpen(true)}>
                <FolderInput size={14} /> Move to folder
              </button>
            )}
            {hasPermission("document.delete") && (
              <button className="btn-ghost btn-sm text-rose-700" onClick={() => setBulkDeleteOpen(true)}>
                <Trash2 size={14} /> Remove
              </button>
            )}
          </div>
        )}
        <div className="table-shell glass-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wider text-base-400">
                <th className="w-8 px-2 py-3">
                  <button
                    type="button"
                    onClick={() =>
                      setSelected(
                        rows?.length && selected.size === rows.length
                          ? new Set()
                          : new Set((rows || []).map((r) => r.id))
                      )
                    }
                    aria-label="Select all on this page"
                    className="text-base-500 hover:text-base-200"
                  >
                    {rows?.length && selected.size === rows.length
                      ? <CheckSquare size={14} className="text-brand-700" />
                      : <Square size={14} />}
                  </button>
                </th>
                <th className="px-4 py-3 font-medium">File</th>
                <th className="px-4 py-3 font-medium">Reason</th>
                <th className="col-tertiary px-4 py-3 font-medium">What happened</th>
                <th className="col-tertiary px-4 py-3 font-medium">Location</th>
                <th className="col-secondary px-4 py-3 font-medium" title="When the document is from — read out of the file where possible.">
                  Date
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={
                    "table-row-hover border-b border-line align-top last:border-0 " +
                    (selected.has(row.id) ? "bg-brand-500/[0.06]" : "")
                  }
                >
                  <td className="px-2 py-3">
                    <button
                      type="button"
                      onClick={() => toggle(row.id)}
                      aria-label={selected.has(row.id) ? "Deselect" : "Select"}
                      aria-pressed={selected.has(row.id)}
                      className="text-base-500 hover:text-base-200"
                    >
                      {selected.has(row.id)
                        ? <CheckSquare size={14} className="text-brand-700" />
                        : <Square size={14} />}
                    </button>
                  </td>
                  <td className="w-full max-w-0 px-4 py-3">
                    <p className="truncate font-medium text-base-100" title={row.filename_current}>
                      {row.canonical_filename || row.filename_current}
                    </p>
                    <p className="truncate text-xs text-base-500" title={row.current_path}>{row.current_path}</p>
                    <p className="mt-0.5 text-[11px] text-base-500">
                      {formatBytes(row.size_bytes)}
                      {row.subject_name ? ` · ${row.subject_name}` : " · unfiled"}
                    </p>
                    {/* The date, which loses its own column below sm. "What
                        happened" and Location are deliberately NOT repeated
                        here -- both are paragraphs, and stacking them under
                        every filename turns a scannable queue into a wall. */}
                    <div className="cell-subline">
                      <DocumentDateInline date={row.document_date} source={row.document_date_source} />
                    </div>
                  </td>
                  <td className="px-4 py-3"><ReasonBadge row={row} /></td>
                  <td className="col-tertiary max-w-sm px-4 py-3"><DetailCell row={row} /></td>
                  <td className="col-tertiary px-4 py-3 text-xs text-base-400">
                    {row.location_name}
                    {row.location_is_read_only && (
                      <span className="ml-1.5 text-[10px] text-base-500" title="Originals in this location are never renamed or moved — a name you set is recorded in the database and used by the shortcut mirror.">
                        read-only
                      </span>
                    )}
                  </td>
                  <td className="col-secondary px-4 py-3 text-xs">
                    <DocumentDate date={row.document_date} source={row.document_date_source} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      {hasPermission("document.download") && row.status === "active" && (
                        <button className="btn-ghost btn-sm" onClick={() => setPreviewFileId(row.id)} title="Preview">
                          <Eye size={13} />
                        </button>
                      )}
                      {/* Name it yourself. For most of this queue this is the
                          real fix, not retry: a scan with no text layer will
                          extract to nothing again however many times it is
                          re-run. */}
                      {hasPermission("document.rename") && row.status === "active" && (
                        <button className="btn-ghost btn-sm" onClick={() => setEditTarget(row)} title="Rename this file yourself">
                          <Pencil size={13} />
                        </button>
                      )}
                      {hasPermission("classification.modify") && row.status === "active" && (
                        <button className="btn-ghost btn-sm" onClick={() => setMoveTarget(row)} title="File under a subject">
                          <FolderInput size={13} />
                        </button>
                      )}
                      {hasPermission("document.delete") && (
                        <button
                          className="btn-ghost btn-sm text-rose-700"
                          disabled={busyId === row.id}
                          onClick={() => setDeleteTarget(row)}
                          title="Remove this file from Atlas. Nothing is erased from your disk."
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* summary.total was already on this page and simply never passed. */}
          <Pagination offset={offset} limit={LIMIT} total={summary?.total} pageCount={rows?.length} onChange={setOffset} />
        </div>
        </>
      )}

      {bulkMoveOpen && (
        <MoveManyModal
          fileIds={[...selected]}
          endpoint="/triage/move"
          title={`File ${selected.size} document${selected.size === 1 ? "" : "s"}`}
          onClose={() => setBulkMoveOpen(false)}
          onMoved={() => {
            [...selected].forEach(removeLocally);
            setSelected(new Set());
            setBulkMoveOpen(false);
          }}
        />
      )}

      <ConfirmDialog
        open={bulkDeleteOpen}
        title={`Remove ${selected.size} file${selected.size === 1 ? "" : "s"}?`}
        description="They are marked removed in Atlas and disappear from these lists. Nothing is erased from your disk — the actual files stay exactly where they are."
        confirmLabel="Remove"
        danger
        onConfirm={removeSelected}
        onClose={() => setBulkDeleteOpen(false)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget ? `Remove "${deleteTarget.filename_current}"?` : ""}
        description="It is marked removed in Atlas and disappears from these lists. Nothing is erased from your disk — the file stays exactly where it is."
        confirmLabel="Remove"
        danger
        onConfirm={() => removeOne(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
      />

      <PreviewModal fileId={previewFileId} onClose={() => setPreviewFileId(null)} />

      <EditFileModal
        file={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          push("File updated.", "success");
          // Refetched rather than dropped optimistically. Naming a file DOES
          // clear the two text-quality reasons, but only where the rename
          // records a canonical name -- so whether this row disappears is the
          // server's call, not a guess made here. See triageRepository's note
          // on read-only vs writable locations.
          reload();
          reloadSummary();
        }}
      />

      <MoveFileModal
        file={moveTarget}
        onClose={() => setMoveTarget(null)}
        onMoved={() => {
          setMoveTarget(null);
          push("File moved.", "success");
          reload();
        }}
      />
    </div>
  );
}
