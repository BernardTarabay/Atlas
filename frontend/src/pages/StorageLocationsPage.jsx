import { useState, useEffect } from "react";
import { HardDrive, PlayCircle, X, FolderSearch, RefreshCw, Lock, Unlock, AlertTriangle, RotateCcw } from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { StatusBadge } from "../components/StatusBadge";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { FolderBrowserModal } from "../components/FolderBrowserModal";
// FolderUploadZone is deliberately gone: dragging a folder onto the app
// COPIED every byte into backend/storage/uploads, which duplicated the
// user's files inside the project and is the opposite of what this app is
// for. Registering a folder (FolderBrowserModal) indexes it in place.
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { formatDate } from "../utils/format";

export function StorageLocationsPage() {
  const { push } = useToast();
  const { hasPermission } = useAuth();
  const { data: locations, loading, error, reload } = useApiData(() => api.get("/storage-locations"), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [createPrefill, setCreatePrefill] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scanningId, setScanningId] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removing, setRemoving] = useState(false);

  // "Press the container to open a file explorer" flow: browse for the
  // folder first, then open the Register form pre-filled with it (name
  // defaulted from the folder's own name) instead of making people type a
  // path into a blank form first.
  function browseForFolder() {
    setPickerOpen(true);
  }

  function folderPicked(selectedPath) {
    const segments = selectedPath.split(/[/\\]/).filter(Boolean);
    const suggestedName = segments[segments.length - 1] || selectedPath;
    setCreatePrefill({ rootPath: selectedPath, name: suggestedName });
    setPickerOpen(false);
    setCreateOpen(true);
  }

  async function triggerScan(id) {
    setScanningId(id);
    try {
      await api.post(`/storage-locations/${id}/scan`);
      push("Scan started — check Processing Jobs for progress.", "success");
      // Pull the card's scan status and backlog badges forward. Without this
      // the location you just scanned kept showing its previous "last
      // scanned" time until something else happened to refresh the page,
      // which reads as the button having done nothing.
      reload();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setScanningId(null);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.del(`/storage-locations/${removeTarget.id}`);
      push(`"${removeTarget.name}" removed.`, "success");
      setRemoveTarget(null);
      reload();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Storage locations"
        description="Folders this app indexes, wherever they live — local disk, external drive, cloud-synced folder. Files are read where they are and never copied here."
        actions={
          <>
            {/* Reloading a list you can already see is not privileged. This
                used to sit behind the same gate as adding a folder, which
                left a read-only account with no way to refresh at all. */}
            <button className="btn-ghost btn-sm" onClick={reload} disabled={loading} title="Reload">
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
            {/* `storage.manage`, NOT `user.manage`.
                This gate was the reason a normal account could not register a
                folder even after the backend permissions were fixed: the
                button was simply never rendered. `user.manage` governs
                administering OTHER PEOPLE'S ACCOUNTS; pointing this app at
                your own folder is an ordinary user action, and every query
                behind it is scoped to the caller. */}
            {hasPermission("storage.manage") && (
              /* Straight to the folder browser rather than a blank form --
                 typing an absolute path by hand was the friction that made
                 drag-and-drop look attractive in the first place. */
              <button className="btn-primary btn-sm" onClick={browseForFolder}>
                <FolderSearch size={14} /> Add folder
              </button>
            )}
          </>
        }
      />

      {loading ? (
        <PageSpinner />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} title="Couldn't load storage locations" />
      ) : !locations?.length ? (
        <EmptyState
          icon={HardDrive}
          title="No folders registered yet"
          description="Point the app at a folder and it indexes the files where they are — nothing is copied, and by default nothing is renamed or moved on disk."
          action={
            hasPermission("storage.manage") ? (
              <button className="btn-primary btn-sm" onClick={browseForFolder}>
                <FolderSearch size={14} /> Browse for a folder
              </button>
            ) : null
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {locations.map((loc) => (
            <div key={loc.id} className="glass-card animate-fade-in-up relative p-5">
              {hasPermission("storage.manage") && (
                <button
                  className="absolute right-3 top-3 rounded-lg p-1 text-base-500 hover:bg-base-900 hover:text-rose-700"
                  onClick={() => setRemoveTarget(loc)}
                  title="Remove storage location"
                >
                  <X size={14} />
                </button>
              )}
              <div className="mb-3 flex items-start justify-between pr-6">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-line-strong bg-base-900">
                  <HardDrive size={16} className="text-brand-700" />
                </div>
                {/* "pending" used to mean "agent mode isn't built yet".
                    Both modes are real now, so this just states which one. */}
                <StatusBadge
                  value={loc.access_mode}
                  label={loc.access_mode === "direct" ? "direct" : "via agent"}
                />
              </div>
              <p className="text-sm font-medium text-base-100">{loc.name}</p>
              <p className="mt-1 truncate font-mono text-xs text-base-500" title={loc.root_path}>{loc.root_path}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-base-400">{loc.type}</span>
                {/* The single most important thing to know about a location:
                    whether this app is allowed to touch the files in it. */}
                {loc.is_read_only ? (
                  <span className="badge-emerald" title="Files here are indexed and named, but never renamed or moved on disk.">
                    <Lock size={10} /> read-only
                  </span>
                ) : (
                  <span className="badge-amber" title="Approved renames WILL rename and move the actual files in this folder.">
                    <Unlock size={10} /> writable
                  </span>
                )}
              </div>
              {loc.last_scan ? (
                <p className="mt-1 text-xs text-base-500">
                  Last scanned {formatDate(loc.last_scan.finishedAt || loc.last_scan.startedAt)}
                  {loc.last_scan.status === "running" && " (in progress)"}
                  {loc.last_scan.status === "failed" && " (failed)"}
                  {typeof loc.last_scan.filesDiscovered === "number" && loc.last_scan.status === "completed" &&
                    ` — ${loc.last_scan.filesDiscovered} file(s)`}
                </p>
              ) : (
                <p className="mt-1 text-xs text-base-500">Never scanned</p>
              )}

              {/* Processing backlog. Without this, a file that was discovered
                  but never finished is indistinguishable from a file that
                  finished -- it appears in the list either way, just silently
                  unsearchable. "Waiting" is normal during an import;
                  "stalled" means work was lost (a crash, a Redis restart) and
                  is the number worth reacting to. */}
              <ProcessingBacklog processing={loc.processing} recovered={loc.last_scan?.filesRecovered} />

              {/* Agent-mode locations are scannable now that
                  AgentStorageService exists -- this used to be disabled for
                  anything but "direct", which was correct only while agent
                  mode was unimplemented. The scan still fails cleanly with a
                  503 if no agent is connected, which is the honest place for
                  that to surface. */}
              {/* Matches the route's own bar (`scan.run`). This was ungated,
                  so an account without it saw a button that 403s -- an action
                  offered and then refused is worse than one not offered. */}
              {hasPermission("scan.run") && (
                <button
                  className="btn-secondary btn-sm mt-4 w-full"
                  disabled={scanningId === loc.id}
                  onClick={() => triggerScan(loc.id)}
                >
                  <PlayCircle size={13} /> {scanningId === loc.id ? "Starting…" : "Run scan"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <FolderBrowserModal open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={folderPicked} />

      <CreateLocationModal
        open={createOpen}
        initialValues={createPrefill}
        onClose={() => { setCreateOpen(false); setCreatePrefill(null); }}
        onCreated={() => { setCreateOpen(false); setCreatePrefill(null); reload(); }}
      />

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={confirmRemove}
        loading={removing}
        danger
        title="Remove storage location"
        confirmLabel="Remove"
        description={
          removeTarget
            ? `Remove "${removeTarget.name}"? Files already ingested from it stay browsable — this just stops future scans and hides it from this list.`
            : ""
        }
      />
    </div>
  );
}

/**
 * The gap between "this file is listed" and "this file is actually
 * searchable".
 *
 * A file whose processing never finished still appears in the file list, so
 * nothing on screen distinguishes it from a finished one -- it is just
 * quietly missing from every search. This makes that visible:
 *
 *   waiting  a job is queued or running. Normal during an import.
 *   stalled  nothing is going to pick it up. Work was lost (a crash, a Redis
 *            restart). The next scan re-queues these automatically, so the
 *            wording says so rather than alarming someone over a state that
 *            heals itself.
 */
function ProcessingBacklog({ processing, recovered }) {
  const inFlight = processing?.inFlight || 0;
  const stalled = processing?.stalled || 0;
  if (!inFlight && !stalled && !recovered) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {inFlight > 0 && (
        <span className="badge-blue" title="Discovered and queued for processing. These become searchable as the queue drains.">
          <RefreshCw size={10} className="animate-spin" /> {inFlight.toLocaleString()} waiting
        </span>
      )}
      {stalled > 0 && (
        <span
          className="badge-amber"
          title="Discovered but nothing is processing them — usually queued work lost to a restart or crash. The next scan re-queues them automatically."
        >
          <AlertTriangle size={10} /> {stalled.toLocaleString()} stalled
        </span>
      )}
      {recovered > 0 && (
        <span className="badge-emerald" title="The last scan found these already-discovered files unprocessed and re-queued them.">
          <RotateCcw size={10} /> {recovered.toLocaleString()} recovered
        </span>
      )}
    </div>
  );
}

const DEFAULT_FORM = { name: "", type: "local", rootPath: "", accessMode: "direct" };

function CreateLocationModal({ open, onClose, onCreated, initialValues }) {
  const [form, setForm] = useState({ ...DEFAULT_FORM, ...initialValues });
  const [saving, setSaving] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const { push } = useToast();

  // Re-seed the form whenever the modal opens -- covers both the plain
  // "+ Register location" button (initialValues is null -> blank form) and
  // the "browse first" flow (initialValues carries the picked rootPath/name).
  useEffect(() => {
    if (open) setForm({ ...DEFAULT_FORM, ...initialValues });
  }, [open, initialValues]);

  function update(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function submit() {
    setSaving(true);
    try {
      // Windows "Copy as path" wraps the result in literal quotes -- strip
      // those (and stray whitespace) before it ever leaves the browser.
      const rootPath = form.rootPath.trim().replace(/^["'](.*)["']$/, "$1").trim();
      await api.post("/storage-locations", { ...form, rootPath });
      push("Storage location registered.", "success");
      onCreated();
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
      title="Register storage location"
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={submit} disabled={saving || !form.name || !form.rootPath}>
            {saving ? "Registering…" : "Register"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label">Name</label>
          <input className="input" value={form.name} onChange={update("name")} placeholder="Office NAS" />
        </div>
        <div>
          <label className="label">Type</label>
          <select className="input" value={form.type} onChange={update("type")}>
            <option value="local">Local</option>
            <option value="nas">NAS</option>
            <option value="server">Server</option>
            <option value="managed">Managed</option>
            <option value="cloud">Cloud</option>
          </select>
        </div>
        <div>
          <label className="label">Root path</label>
          <div className="flex gap-2">
            <input className="input font-mono" value={form.rootPath} onChange={update("rootPath")} placeholder="/mnt/nas/documents" />
            <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setBrowserOpen(true)}>
              <FolderSearch size={14} /> Browse
            </button>
          </div>
        </div>
        <div>
          <label className="label">Access mode</label>
          <select className="input" value={form.accessMode} onChange={update("accessMode")}>
            <option value="direct">Direct (backend can reach this path)</option>
            <option value="agent" disabled>Via Filesystem Agent (Phase 12 — not available yet)</option>
          </select>
        </div>
      </div>

      <FolderBrowserModal
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        initialPath={form.rootPath || undefined}
        onSelect={(selectedPath) => setForm((f) => ({ ...f, rootPath: selectedPath }))}
      />
    </Modal>
  );
}
