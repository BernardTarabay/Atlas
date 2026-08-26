import { useState } from "react";
import {
  MonitorSmartphone, Server, Wifi, WifiOff, HardDrive, FileText,
  Pencil, Check, X, CloudOff, Info,
} from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData, usePolling } from "../hooks/useApiData";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { ErrorState } from "../components/ErrorState";
import { relativeTime } from "../utils/format";

/**
 * Devices, and an honest account of what does and does not cross between them.
 *
 * THE THING THIS PAGE REFUSES TO FAKE
 *
 * Organization already crosses devices and always has: names, folders,
 * classifications and duplicate groups live in the central database, so
 * signing in from a laptop shows the same organized archive as the desktop.
 * That half is real and this page says so.
 *
 * File CONTENT does not, because Atlas indexes files where they lie and
 * copies nothing. A document on a desktop is readable from a laptop only
 * while that desktop is awake and its agent connected. Rather than draw a
 * sync progress bar over that gap, this page names the machine, says whether
 * it is answering, and explains what would close the gap.
 */

// Devices go offline without telling anyone, so this is polled rather than
// fetched once -- a status that is only correct at page-load is worse than no
// status, because it is confidently wrong.
const POLL_MS = 20000;

export function DevicesPage() {
  const { data: devices, loading, error, reload } = usePolling(() => api.get("/devices"), POLL_MS);
  const { data: replication } = useApiData(() => api.get("/devices/replication"), []);
  const { hasPermission } = useAuth();

  if (loading && !devices) return <PageSpinner />;
  if (error) return <ErrorState error={error} onRetry={reload} title="Couldn't load your devices" />;

  return (
    <div>
      <PageHeader
        title="Devices"
        description="The machines holding your files, and whether their contents are reachable from here right now."
      />

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(devices || []).map((device) => (
          <DeviceCard
            key={device.id}
            device={device}
            canRename={hasPermission("device.manage")}
            onRenamed={reload}
          />
        ))}
      </div>

      {/* What is and is not true about cross-device access. Stated on the
          page rather than buried in docs, because the alternative is a user
          concluding sync is broken when it was never claimed. */}
      <div className="glass-card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-base-100">
          <Info size={15} className="text-brand-600" aria-hidden="true" />
          What travels between your devices
        </h2>

        <dl className="grid grid-cols-1 gap-4 text-xs leading-relaxed sm:grid-cols-2">
          <div>
            <dt className="mb-1 flex items-center gap-1.5 font-medium text-emerald-700">
              <Check size={13} aria-hidden="true" /> Already shared everywhere
            </dt>
            <dd className="text-base-400">
              Folder structure, file names, subjects, classifications, duplicate groups, rename
              history, OCR text and processing state. All of it lives in one central database, so
              signing in from any computer shows the same organized archive. Rename a document on
              one machine and every other machine sees the new name immediately.
            </dd>
          </div>
          <div>
            <dt className="mb-1 flex items-center gap-1.5 font-medium text-amber-700">
              <CloudOff size={13} aria-hidden="true" /> Needs the origin machine online
            </dt>
            <dd className="text-base-400">
              The file's actual contents — opening, previewing or downloading it. Atlas indexes
              files where they already are and never copies them, so the bytes only exist on the
              machine that holds them. When that machine is connected, Atlas streams them through
              its agent; when it is asleep, the file is listed and organized but not openable, and
              Atlas says which machine to wake.
            </dd>
          </div>
        </dl>

        {replication && !replication.implemented && (
          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-base-500">
            <strong className="text-base-400">Server-side replication is not built.</strong>{" "}
            {replication.reason}
          </p>
        )}
      </div>
    </div>
  );
}

function DeviceCard({ device, canRename, onRenamed }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [saving, setSaving] = useState(false);
  const { push } = useToast();

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === device.name) { setEditing(false); setName(device.name); return; }
    setSaving(true);
    try {
      await api.patch(`/devices/${device.id}`, { name: trimmed });
      push("Device renamed.", "success");
      setEditing(false);
      onRenamed();
    } catch (err) {
      push(err.message, "error");
      setName(device.name);
    } finally {
      setSaving(false);
    }
  };

  const status = {
    online: { label: "Connected", cls: "text-emerald-700", Icon: Wifi },
    offline: { label: "Not connected", cls: "text-base-500", Icon: WifiOff },
    never_connected: { label: "Never connected", cls: "text-base-500", Icon: WifiOff },
    revoked: { label: "Revoked", cls: "text-rose-700", Icon: WifiOff },
  }[device.status] || { label: device.status, cls: "text-base-500", Icon: WifiOff };

  const KindIcon = device.isThisServer ? Server : MonitorSmartphone;

  return (
    <div className="glass-card p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-base-850">
            <KindIcon size={17} className="text-base-300" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            {editing ? (
              <div className="flex items-center gap-1">
                <input
                  className="w-full rounded-md border border-line-strong bg-base-900/60 px-2 py-1 text-sm text-base-100"
                  value={name}
                  autoFocus
                  disabled={saving}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                    if (e.key === "Escape") { setEditing(false); setName(device.name); }
                  }}
                />
                <button className="btn-ghost btn-sm" onClick={save} disabled={saving} aria-label="Save name">
                  <Check size={14} />
                </button>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => { setEditing(false); setName(device.name); }}
                  aria-label="Cancel"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-medium text-base-50" title={device.name}>
                  {device.name}
                </p>
                {canRename && !device.isThisServer && (
                  <button
                    className="shrink-0 rounded p-1 text-base-500 hover:text-base-200"
                    onClick={() => setEditing(true)}
                    aria-label={`Rename ${device.name}`}
                  >
                    <Pencil size={12} />
                  </button>
                )}
              </div>
            )}
            <p className="truncate text-[11px] text-base-500">
              {device.hostname || (device.isThisServer ? "runs the Atlas backend" : "no hostname reported")}
              {device.platform ? ` · ${device.platform}` : ""}
            </p>
          </div>
        </div>

        <span className={`flex shrink-0 items-center gap-1 text-[11px] ${status.cls}`}>
          <status.Icon size={12} aria-hidden="true" /> {status.label}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded-lg bg-base-900 px-2.5 py-2">
          <dt className="flex items-center gap-1 text-base-500"><HardDrive size={11} /> Locations</dt>
          <dd className="mt-0.5 text-sm text-base-100">{device.locationCount}</dd>
        </div>
        <div className="rounded-lg bg-base-900 px-2.5 py-2">
          <dt className="flex items-center gap-1 text-base-500"><FileText size={11} /> Files held</dt>
          <dd className="mt-0.5 text-sm text-base-100">{device.fileCount.toLocaleString()}</dd>
        </div>
      </dl>

      {!device.isThisServer && (
        <p className="mt-2.5 text-[11px] text-base-500">
          {device.lastSeenAt
            ? `Last heard from ${relativeTime(device.lastSeenAt)}`
            : "This device has never connected. Run the Atlas agent on it to make its files readable from here."}
        </p>
      )}
    </div>
  );
}
