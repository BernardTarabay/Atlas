import { useEffect, useState } from "react";
import { Folder, ChevronUp, Check, AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";
import { PageSpinner } from "./Spinner";
import { api } from "../services/apiClient";

/**
 * Server-side folder picker (spec item: browse instead of hand-typing a
 * path). Note on "drag and drop": a browser can't hand back an absolute
 * filesystem path for a dropped folder (that's a deliberate browser
 * security restriction, not something fixable client-side) -- this browser
 * is the practical equivalent for a web app pointing the backend at its own
 * filesystem. Double-click a folder to descend into it, or use "Use this
 * folder" to select whatever's currently open.
 */
export function FolderBrowserModal({ open, onClose, onSelect, initialPath }) {
  const [current, setCurrent] = useState(null);
  const [parent, setParent] = useState(null);
  const [dirs, setDirs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function load(targetPath) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get("/storage-locations/browse", targetPath ? { path: targetPath } : undefined);
      setCurrent(res.path);
      setParent(res.parent);
      setDirs(res.directories);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) load(initialPath || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose a folder"
      width="max-w-lg"
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary btn-sm"
            disabled={!current}
            onClick={() => { onSelect(current); onClose(); }}
          >
            <Check size={13} /> Use this folder
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="truncate rounded-lg border border-line-strong bg-inset px-3 py-2 font-mono text-xs text-base-300">
          {current || "…"}
        </p>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          {loading ? (
            <div className="py-6"><PageSpinner /></div>
          ) : (
            <>
              {parent && (
                <button className="nav-link w-full justify-start" onClick={() => load(parent)}>
                  <ChevronUp size={15} /> ..
                </button>
              )}
              {dirs.length === 0 && !parent && !error && (
                <p className="py-6 text-center text-xs text-base-400">No subfolders here.</p>
              )}
              {dirs.map((d) => (
                <button
                  key={d.path}
                  className="nav-link w-full justify-start"
                  onClick={() => load(d.path)}
                  onDoubleClick={() => { onSelect(d.path); onClose(); }}
                  title="Click to open, double-click to select"
                >
                  <Folder size={15} /> {d.name}
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
