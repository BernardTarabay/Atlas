import { useCallback, useEffect, useState } from "react";
import {
  Images, ScanText, AlertTriangle, CheckCircle2, Clock, Loader2, X,
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize2, FolderInput,
  Pencil, Archive, RefreshCw, Download, Info, CheckSquare, Square, FolderInput as FolderMove,
} from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { useAuthedImage } from "../hooks/useAuthedImage";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { Pagination } from "../components/Pagination";
import { MoveFileModal } from "../components/MoveFileModal";
import { MoveManyModal } from "../components/MoveManyModal";
import { formatBytes, formatDate } from "../utils/format";

/**
 * The Photos / OCR workspace.
 *
 * WHY THIS PAGE EXISTS SEPARATELY FROM FILES
 *
 * A photograph is identified by looking at it. Everything the Files page is
 * good at -- filename, extracted text, subject, dates -- is close to useless
 * for a picture of a receipt, which arrives called IMG_4821.jpg with no text
 * layer and no date beyond when it was copied off the phone. Listing those in
 * a table of filenames is asking someone to identify their documents from
 * information the documents do not carry.
 *
 * So this is a grid of actual images, and clicking one opens the picture at
 * size with its OCR reading beside it and the actions that resolve it
 * underneath. Nothing here opens Windows Explorer.
 *
 * WHERE THE IMAGE COMES FROM
 *
 * `GET /api/files/:id/preview` -- an authenticated endpoint that returns a
 * rasterised image, never the file's own bytes and never a filesystem path.
 * That is deliberate (requirement 23): the browser is handed pixels the API
 * has decided this account may see, so a photo is viewable from any device
 * without exposing where it lives on disk.
 */

const TABS = [
  { key: null, label: "All" },
  { key: "pending", label: "Waiting for OCR", icon: Clock },
  { key: "completed", label: "Read", icon: CheckCircle2 },
  { key: "failed", label: "Failed", icon: AlertTriangle },
  { key: "unavailable", label: "No engine", icon: AlertTriangle },
];

const PAGE_SIZES = [24, 48, 96];

export function PhotosPage() {
  const [status, setStatus] = useState(null);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(24);
  const [viewerIndex, setViewerIndex] = useState(null);
  // Selection lives here rather than per-tile so "select all" and the action
  // bar have one source of truth. A Set because the hot operation is
  // membership, once per tile per render.
  const [selected, setSelected] = useState(() => new Set());
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const { push } = useToast();
  const { hasPermission } = useAuth();

  const { data, loading, error, reload } = useApiData(
    () => api.get("/photos", { status: status || undefined, limit, offset }),
    [status, limit, offset]
  );
  const { data: summary, reload: reloadSummary } = useApiData(() => api.get("/photos/summary"), []);

  const photos = data?.photos || [];

  // Changing the tab or the page size changes WHICH rows match, so page 1 is
  // the only honest place to land -- staying on page 4 of a filter that now
  // matches 6 items shows an empty grid that reads as "no photos".
  useEffect(() => { setOffset((o) => (o === 0 ? o : 0)); }, [status, limit]);

  // Selection is cleared whenever the visible set changes. Carrying it across
  // a page or tab change means a later "move selected" acts on photos that are
  // no longer on screen -- the user cannot see what they are about to move,
  // which is exactly the situation a bulk action must never be in.
  useEffect(() => { setSelected(new Set()); }, [status, limit, offset]);

  const toggle = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const engine = summary?.engine;
  const counts = summary?.counts || {};

  const refreshAll = useCallback(() => { reload(); reloadSummary(); }, [reload, reloadSummary]);

  const selectedIds = [...selected];
  const allSelected = photos.length > 0 && selectedIds.length === photos.length;

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(photos.map((p) => p.id)));
  };

  const archiveSelected = async () => {
    try {
      const r = await api.post("/photos/archive", { fileIds: selectedIds });
      push(`Archived ${r.archived} photo${r.archived === 1 ? "" : "s"}. Files on disk are untouched.`, "success");
      setSelected(new Set());
      refreshAll();
    } catch (err) {
      push(err.message, "error");
    }
  };

  const runPending = async () => {
    try {
      const result = await api.post("/photos/ocr/run-pending", {});
      push(
        result.queued > 0
          ? `Queued OCR for ${result.queued} image${result.queued === 1 ? "" : "s"}.`
          : "Nothing is waiting for OCR.",
        result.queued > 0 ? "success" : "info"
      );
      refreshAll();
    } catch (err) {
      push(err.message, "error");
    }
  };

  return (
    <div>
      <PageHeader
        title="Photos & OCR"
        description="Scans and photographs, shown as pictures so you can tell what they are. Text is read out of them where an OCR engine is available."
        actions={
          hasPermission("scan.run") && engine?.available ? (
            <button className="btn-secondary btn-sm" onClick={runPending}>
              <ScanText size={14} /> Read everything waiting
            </button>
          ) : null
        }
      />

      {/* The engine's real state, said plainly.
          Without this, a deployment with no Tesseract shows an empty "Read"
          tab and the user concludes OCR ran and found nothing -- which is the
          exact species of fake functionality this rebuild is meant to remove. */}
      {engine && !engine.available && (
        <div className="glass-card mb-5 border-amber-500/25 bg-amber-500/[0.04] p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-700" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-amber-700">No OCR engine is installed</p>
              <p className="mt-1 text-xs leading-relaxed text-base-400">
                Your photos are still listed, viewable and filable — they just have no text read out
                of them yet. Atlas uses Tesseract, which is a one-time install:
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-inset p-3 text-[11px] leading-relaxed text-base-300">
{engine.reason}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Informational, not a failure.
          This used to say Atlas "will not fall back" and left it there, which
          read as "OCR is broken" — and was wrong: OCR now runs with whichever
          requested languages ARE installed and reports the rest. The banner
          says what is actually happening and what the gap costs, rather than
          implying nothing works. */}
      {engine?.available && engine.missingLanguages?.length > 0 && (
        <div className="glass-card mb-5 border-line-strong bg-base-900 p-4 text-xs leading-relaxed text-base-400">
          <Info size={14} className="mr-1.5 inline text-base-400" aria-hidden="true" />
          OCR is running in <strong className="text-base-200">{engine.usingLanguages || "eng"}</strong>.
          Tesseract {engine.version} has no language data for{" "}
          <strong className="text-base-200">{engine.missingLanguages.join(", ")}</strong>, so documents
          in {engine.missingLanguages.includes("ara") ? "Arabic" : "those languages"} may read poorly
          or not at all — Atlas will not guess at them in English, because that produces convincing
          nonsense rather than an obvious failure.
          <span className="mt-1.5 block text-base-500">
            To add them, re-run the Tesseract installer and tick the extra language packs, or drop the
            matching <code className="text-base-400">.traineddata</code> files into{" "}
            <code className="text-base-400">C:\Program Files\Tesseract-OCR\tessdata</code>. Everything
            else keeps working meanwhile.
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-5 flex flex-wrap gap-1.5">
        {TABS.map((tab) => {
          const count = tab.key === null ? counts.total : counts[tab.key];
          const active = status === tab.key;
          return (
            <button
              key={tab.label}
              type="button"
              onClick={() => setStatus(tab.key)}
              className={
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors " +
                (active
                  ? "bg-brand-500/20 text-brand-700 ring-1 ring-brand-500/40"
                  : "text-base-400 hover:bg-base-850 hover:text-base-200")
              }
            >
              {tab.icon && <tab.icon size={13} aria-hidden="true" />}
              {tab.label}
              {count !== undefined && (
                <span className={active ? "text-brand-700/80" : "text-base-500"}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Bulk action bar. Only present when something is selected -- a
          permanently visible bar of disabled buttons is noise. */}
      {selectedIds.length > 0 && (
        <div className="glass-card mb-4 flex flex-wrap items-center gap-2 border-brand-500/25 bg-brand-500/[0.05] p-3">
          <span className="text-sm text-base-100">
            {selectedIds.length} selected
          </span>
          <button className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
          <div className="flex-1" />
          {hasPermission("document.move") && (
            <button className="btn-primary btn-sm" onClick={() => setBulkMoveOpen(true)}>
              <FolderMove size={14} /> Move to folder
            </button>
          )}
          {hasPermission("document.delete") && (
            <button className="btn-ghost btn-sm text-rose-700" onClick={archiveSelected}>
              <Archive size={14} /> Archive
            </button>
          )}
        </div>
      )}

      {photos.length > 0 && (
        <button
          type="button"
          onClick={toggleAll}
          className="mb-2 flex items-center gap-1.5 text-xs text-base-400 hover:text-base-200"
        >
          {allSelected ? <CheckSquare size={13} /> : <Square size={13} />}
          {allSelected ? "Clear selection" : `Select all ${photos.length} on this page`}
        </button>
      )}

      {loading && !data ? (
        <PageSpinner />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} title="Couldn't load your photos" />
      ) : photos.length === 0 ? (
        <EmptyState
          icon={Images}
          title={status ? "Nothing in this state" : "No photos yet"}
          description={
            status
              ? "Try another tab — the counts above show where your images are."
              : "Images found in your storage locations show up here. Scan a location that contains photos or scanned documents."
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {photos.map((photo, index) => (
              <PhotoTile
                key={photo.id}
                photo={photo}
                selected={selected.has(photo.id)}
                onToggle={() => toggle(photo.id)}
                onRename={() => setRenameTarget(photo)}
                canRename={hasPermission("document.rename")}
                onOpen={() => setViewerIndex(index)}
              />
            ))}
          </div>

          <div className="glass-card mt-4 overflow-hidden">
            <Pagination
              offset={offset}
              limit={limit}
              total={data?.total}
              pageCount={photos.length}
              onChange={setOffset}
              pageSizes={PAGE_SIZES}
              onLimitChange={setLimit}
            />
          </div>
        </>
      )}

      {bulkMoveOpen && (
        <MoveManyModal
          fileIds={selectedIds}
          endpoint="/photos/move"
          title={`Move ${selectedIds.length} photo${selectedIds.length === 1 ? "" : "s"}`}
          onClose={() => setBulkMoveOpen(false)}
          onMoved={() => { setBulkMoveOpen(false); setSelected(new Set()); refreshAll(); }}
        />
      )}

      {renameTarget && (
        <RenamePhotoModal
          photo={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={() => { setRenameTarget(null); refreshAll(); }}
        />
      )}

      {viewerIndex !== null && photos[viewerIndex] && (
        <PhotoViewer
          photos={photos}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          onChanged={refreshAll}
          engineAvailable={Boolean(engine?.available)}
        />
      )}
    </div>
  );
}

/** One tile in the grid: the picture, and just enough state to triage by eye. */
function PhotoTile({ photo, onOpen, selected, onToggle, onRename, canRename }) {
  // Fetched with the access token attached. A bare <img src="/api/..."> would
  // 401 -- see useAuthedImage for why that fails as a broken-image icon rather
  // than as an auth error.
  const { url, loading, error } = useAuthedImage(photo.previewUrl);

  const ocrBadge = {
    completed: { label: "Read", cls: "bg-emerald-500/15 text-emerald-700" },
    pending: { label: "Waiting", cls: "bg-base-700/60 text-base-300" },
    queued: { label: "Queued", cls: "bg-sky-500/15 text-sky-700" },
    running: { label: "Reading…", cls: "bg-sky-500/15 text-sky-700" },
    failed: { label: "Failed", cls: "bg-rose-500/15 text-rose-700" },
    unavailable: { label: "No engine", cls: "bg-amber-500/15 text-amber-700" },
    not_needed: null,
  }[photo.ocr.status];

  return (
    // A div, not a button: it now contains a checkbox and a rename button, and
    // nesting interactive elements inside a button is invalid HTML that
    // browsers resolve unpredictably (the inner click frequently never fires).
    // The image area keeps its own button for opening the viewer.
    <div
      className={
        "glass-card group relative flex flex-col overflow-hidden p-0 text-left transition-transform hover:-translate-y-0.5 " +
        (selected ? "ring-2 ring-brand-500/70" : "")
      }
    >
      {/* Selection. Always visible once anything is selected, otherwise on
          hover -- a permanent grid of checkboxes makes a photo wall look like
          a form. */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={selected ? `Deselect ${photo.filename}` : `Select ${photo.filename}`}
        aria-pressed={selected}
        className={
          "absolute left-2 top-2 z-10 rounded-md bg-scrim/70 p-1 text-white backdrop-blur transition-opacity hover:text-white " +
          (selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100")
        }
      >
        {selected ? <CheckSquare size={15} className="text-brand-700" /> : <Square size={15} />}
      </button>

      {canRename && (
        <button
          type="button"
          onClick={onRename}
          aria-label={`Rename ${photo.filename}`}
          className="absolute right-2 top-2 z-10 rounded-md bg-scrim/70 p-1 text-white/80 opacity-0 backdrop-blur transition-opacity hover:text-white group-hover:opacity-100 focus:opacity-100"
        >
          <Pencil size={14} />
        </button>
      )}

    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col text-left"
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-base-850">
        {loading ? (
          <div className="flex h-full w-full items-center justify-center">
            <Loader2 size={18} className="animate-spin text-base-600" aria-hidden="true" />
          </div>
        ) : error || !url ? (
          // An honest placeholder. A broken <img> icon would read as "this
          // file is corrupt" when the usual cause is a format the server has
          // no renderer for -- LibreOffice absent, or a RAW camera file.
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-base-500">
            <Images size={22} aria-hidden="true" />
            <span className="px-2 text-center text-[10px]">No preview available</span>
          </div>
        ) : (
          <img
            src={url}
            alt={photo.filename}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
          />
        )}
        {!photo.reviewed && (
          <span
            className="absolute right-2 top-2 h-2 w-2 rounded-full bg-brand-400 ring-2 ring-surface/80"
            title="Not reviewed yet"
          />
        )}
      </div>
      <div className="min-w-0 p-2.5">
        <p className="truncate text-xs font-medium text-base-100" title={photo.filename}>
          {photo.aiShortTitle || photo.filename}
        </p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="truncate text-[10px] text-base-500">
            {photo.subjectName || "Not filed"}
          </span>
          {ocrBadge && (
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${ocrBadge.cls}`}>
              {ocrBadge.label}
            </span>
          )}
        </div>
      </div>
    </button>
    </div>
  );
}

/**
 * Rename one photo.
 *
 * Its own small modal rather than reusing EditFileModal: on a photo the
 * subject/document-type fields that modal also carries are noise, and the one
 * thing you want is to replace "WhatsApp Image 2026-07-20 at 23.43.54.jpeg"
 * with something you will recognise.
 *
 * The extension is preserved by default and shown separately, because
 * dropping it is the easiest mistake to make here and the one with the most
 * annoying consequences.
 */
function RenamePhotoModal({ photo, onClose, onRenamed }) {
  const dot = photo.filename.lastIndexOf(".");
  const [stem, setStem] = useState(dot > 0 ? photo.filename.slice(0, dot) : photo.filename);
  const ext = dot > 0 ? photo.filename.slice(dot) : "";
  const [saving, setSaving] = useState(false);
  const { push } = useToast();

  const save = async () => {
    const next = `${stem.trim()}${ext}`;
    if (!stem.trim() || next === photo.filename) { onClose(); return; }
    setSaving(true);
    try {
      await api.patch(`/photos/${photo.id}/rename`, { filename: next });
      push("Renamed.", "success");
      onRenamed();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Rename photo"
      width="max-w-md"
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={save} disabled={saving || !stem.trim()}>
            {saving ? "Saving…" : "Rename"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-end gap-1.5">
          <div className="min-w-0 flex-1">
            <label className="label mb-1.5 block" htmlFor="photo-name">New name</label>
            <input
              id="photo-name"
              className="input"
              value={stem}
              autoFocus
              onChange={(e) => setStem(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            />
          </div>
          {ext && <span className="pb-2 font-mono text-sm text-base-500">{ext}</span>}
        </div>
        <p className="text-[11px] leading-relaxed text-base-500">
          On a read-only storage location the file on disk keeps its original name — this is the name
          Atlas shows and uses in the organized folder. Nothing is renamed on your drive.
        </p>
      </div>
    </Modal>
  );
}

/**
 * The full-size viewer.
 *
 * Zoom is applied as a CSS transform on the image rather than by requesting a
 * larger render: the preview endpoint returns one raster, and re-fetching per
 * zoom step would be a round trip per click for pixels the browser already
 * has. It means zooming past the raster's native resolution goes soft, which
 * is the correct trade for a review surface -- you are deciding what a
 * document is, not inspecting it forensically.
 */
function PhotoViewer({ photos, index, onIndexChange, onClose, onChanged, engineAvailable }) {
  const photo = photos[index];
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const { push } = useToast();
  const { hasPermission } = useAuth();
  const { url: imageUrl, loading: imageLoading, error: imageError } = useAuthedImage(photo.previewUrl);

  const { data: detail, loading, reload } = useApiData(
    () => api.get(`/photos/${photo.id}`),
    [photo.id]
  );

  // Reset the zoom when moving between images -- carrying a 4x zoom onto the
  // next photo shows a corner of it and looks broken.
  useEffect(() => { setZoom(1); }, [photo.id]);

  const go = useCallback(
    (delta) => {
      const next = index + delta;
      if (next >= 0 && next < photos.length) onIndexChange(next);
    },
    [index, photos.length, onIndexChange]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(z * 1.4, 8));
      if (e.key === "-") setZoom((z) => Math.max(z / 1.4, 1));
      if (e.key === "0") setZoom(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, go]);

  const runOcr = async (force = false) => {
    setBusy(true);
    try {
      await api.post(`/photos/${photo.id}/ocr`, { force });
      push("OCR queued. The text appears here when it finishes.", "success");
      // The job is asynchronous; a single delayed refresh is honest about
      // that without pretending to stream progress we do not have.
      setTimeout(() => { reload(); onChanged(); }, 2500);
    } catch (err) {
      push(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const keepName = async () => {
    setBusy(true);
    try {
      await api.post(`/triage/${photo.id}/keep-name`, {});
      push("Kept the original name. This photo is settled.", "success");
      onChanged();
      reload();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    try {
      await api.post(`/triage/${photo.id}/archive`, {});
      push("Archived. The file on disk is untouched.", "success");
      onChanged();
      onClose();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const ocr = detail?.ocr;
  const confidencePct = ocr?.confidence !== null && ocr?.confidence !== undefined
    ? Math.round(ocr.confidence * 100)
    : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-base-50">{photo.filename}</p>
          <p className="text-[11px] text-base-500">
            {index + 1} of {photos.length}
            {photo.locationName && ` · ${photo.locationName}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button className="btn-ghost btn-sm" onClick={() => setZoom((z) => Math.max(z / 1.4, 1))} aria-label="Zoom out">
            <ZoomOut size={15} />
          </button>
          <span className="w-12 text-center text-xs text-base-400">{Math.round(zoom * 100)}%</span>
          <button className="btn-ghost btn-sm" onClick={() => setZoom((z) => Math.min(z * 1.4, 8))} aria-label="Zoom in">
            <ZoomIn size={15} />
          </button>
          <button className="btn-ghost btn-sm" onClick={() => setZoom(1)} aria-label="Reset zoom">
            <Maximize2 size={15} />
          </button>
          <button
            className="btn-ghost btn-sm"
            onClick={() => api.download(`/files/${photo.id}/download`, photo.filename).catch((e) => push(e.message, "error"))}
            aria-label="Download original"
          >
            <Download size={15} />
          </button>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Close viewer">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* The picture */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-viewer p-4">
          <button
            type="button"
            className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-surface/90 p-2 text-base-300 shadow-sm hover:text-base-50 disabled:opacity-30"
            onClick={() => go(-1)}
            disabled={index === 0}
            aria-label="Previous photo"
          >
            <ChevronLeft size={20} />
          </button>

          {imageLoading ? (
            <Loader2 size={28} className="animate-spin text-white/60" aria-hidden="true" />
          ) : imageError || !imageUrl ? (
            <div className="flex flex-col items-center gap-2 text-white/60">
              <Images size={32} aria-hidden="true" />
              <p className="max-w-sm text-center text-xs">
                No preview could be rendered for this file. It can still be filed, renamed and
                downloaded — only the on-screen picture is unavailable.
              </p>
            </div>
          ) : (
            <img
              src={imageUrl}
              alt={photo.filename}
              style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
              className="max-h-full max-w-full object-contain transition-transform duration-150"
            />
          )}

          <button
            type="button"
            className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-surface/90 p-2 text-base-300 shadow-sm hover:text-base-50 disabled:opacity-30"
            onClick={() => go(1)}
            disabled={index === photos.length - 1}
            aria-label="Next photo"
          >
            <ChevronRight size={20} />
          </button>
        </div>

        {/* The panel */}
        <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-line bg-surface p-4 lg:w-96 lg:border-l lg:border-t-0">
          {loading && !detail ? (
            <PageSpinner />
          ) : (
            <>
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-base-500">
                  OCR
                </h3>
                {ocr?.status === "completed" ? (
                  <>
                    <div className="mb-2 flex items-center gap-2 text-xs">
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-700">Read</span>
                      {confidencePct !== null && (
                        <span className={confidencePct >= 55 ? "text-base-400" : "text-amber-700"}>
                          {confidencePct}% confidence
                        </span>
                      )}
                      {ocr.pageCount > 1 && <span className="text-base-500">{ocr.pageCount} pages</span>}
                    </div>
                    {/* Below the naming floor, say so rather than letting a
                        low-confidence reading look authoritative. */}
                    {ocr.usableForNaming === false && (
                      <p className="mb-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-700/90">
                        <Info size={12} className="mt-0.5 shrink-0" />
                        Below the {Math.round((ocr.namingConfidenceFloor || 0.55) * 100)}% bar, so Atlas
                        will not name or classify from this text. Read it yourself and decide.
                      </p>
                    )}
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-inset p-3 text-[11px] leading-relaxed text-base-300">
{ocr.text || "(no text found in the image)"}
                    </pre>
                  </>
                ) : ocr?.status === "failed" ? (
                  <p className="text-xs leading-relaxed text-rose-700">{ocr.error}</p>
                ) : ocr?.status === "unavailable" ? (
                  <p className="text-xs leading-relaxed text-amber-700">
                    No OCR engine is installed, so nothing has been read from this image.
                  </p>
                ) : (
                  <p className="text-xs text-base-500">
                    {ocr?.status === "running" || ocr?.status === "queued"
                      ? "Reading this image…"
                      : "Not read yet."}
                  </p>
                )}

                {hasPermission("scan.run") && engineAvailable && (
                  <button
                    className="btn-secondary btn-sm mt-2 w-full"
                    disabled={busy}
                    onClick={() => runOcr(ocr?.status === "completed")}
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    {ocr?.status === "completed" ? "Read it again" : "Read this image"}
                  </button>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-base-500">
                  Where it goes
                </h3>
                <p className="mb-2 text-xs text-base-300">
                  {photo.subjectPath
                    ? <>Filed under <span className="text-base-100">{photo.subjectName}</span></>
                    : "Not filed anywhere yet."}
                </p>
                <div className="flex flex-col gap-1.5">
                  {hasPermission("document.move") && (
                    <button className="btn-primary btn-sm w-full" onClick={() => setMoveOpen(true)} disabled={busy}>
                      <FolderInput size={14} /> Move to folder
                    </button>
                  )}
                  {hasPermission("document.rename") && (
                    <button className="btn-secondary btn-sm w-full" onClick={keepName} disabled={busy}>
                      <Pencil size={14} /> Keep this name
                    </button>
                  )}
                  {hasPermission("document.delete") && (
                    <button className="btn-ghost btn-sm w-full text-rose-700" onClick={archive} disabled={busy}>
                      <Archive size={14} /> Archive
                    </button>
                  )}
                </div>
              </section>

              <section className="text-[11px] text-base-500">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-base-500">
                  Details
                </h3>
                <dl className="space-y-1">
                  <Row label="Size" value={formatBytes(photo.sizeBytes)} />
                  <Row label="Type" value={photo.extension?.toUpperCase()} />
                  <Row label="Imported" value={formatDate(photo.importedAt)} />
                  {photo.documentDate && <Row label="Document date" value={formatDate(photo.documentDate)} />}
                  <Row label="Original name" value={photo.originalFilename} />
                </dl>
              </section>
            </>
          )}
        </aside>
      </div>

      {moveOpen && (
        <MoveFileModal
          file={{ id: photo.id, filename_current: photo.filename }}
          onClose={() => setMoveOpen(false)}
          onMoved={() => { setMoveOpen(false); onChanged(); reload(); }}
        />
      )}
    </div>
  );
}

function Row({ label, value }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-base-500">{label}</dt>
      <dd className="truncate text-right text-base-400" title={String(value)}>{value}</dd>
    </div>
  );
}
