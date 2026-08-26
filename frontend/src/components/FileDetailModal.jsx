import { useState } from "react";
import { Download, Sparkles, Trash2, Pencil, FolderInput, FolderOpen, Loader2 } from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageSpinner } from "./Spinner";
import { Modal } from "./Modal";
import { StatusBadge } from "./StatusBadge";
import { Field } from "./Field";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { formatBytes } from "../utils/format";

/**
 * Full file detail + primary actions (download/edit/move/delete). Shared
 * between FilesPage and SubjectsPage so a file looks and behaves the same
 * no matter which tab it was opened from.
 */
export function FileDetailModal({ fileId, onClose, onEdit, onMove, onDelete }) {
  const { hasPermission } = useAuth();
  const { push } = useToast();
  const { data: file, loading } = useApiData(
    () => (fileId ? api.get(`/files/${fileId}`) : Promise.resolve(null)),
    [fileId]
  );
  const [revealing, setRevealing] = useState(false);

  async function revealOnComputer() {
    setRevealing(true);
    try {
      await api.post(`/files/${file.id}/reveal`);
      push("Opened in your file manager.", "success");
    } catch (err) {
      push(err.message, "error");
    } finally {
      setRevealing(false);
    }
  }

  return (
    <Modal open={Boolean(fileId)} onClose={onClose} title="File detail" width="max-w-2xl">
      {loading || !file ? (
        <PageSpinner />
      ) : (
        <div className="space-y-5">
          <div>
            <p className="text-base font-semibold text-base-50">{file.filename_current}</p>
            <p className="text-xs text-base-400">Original: {file.filename_original}</p>
          </div>

          {file.ai_summary && (
            <div className="rounded-xl border border-brand-500/20 bg-brand-500/[0.06] p-3.5">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-brand-700">
                <Sparkles size={12} /> {file.ai_short_title || "AI preview"}
              </p>
              <p className="text-sm text-base-200">{file.ai_summary}</p>
              {file.ai_entities && (file.ai_entities.party || file.ai_entities.dateOrPeriod || file.ai_entities.identifier) && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {file.ai_entities.party && <span className="badge-neutral">{file.ai_entities.party}</span>}
                  {file.ai_entities.dateOrPeriod && <span className="badge-neutral">{file.ai_entities.dateOrPeriod}</span>}
                  {file.ai_entities.identifier && <span className="badge-neutral">#{file.ai_entities.identifier}</span>}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Status"><StatusBadge value={file.status} /></Field>
            <Field label="Processing"><StatusBadge value={file.processing_status} /></Field>
            <Field label="Size">{formatBytes(file.size_bytes)}</Field>
            <Field label="Detected type">{file.mime_type_detected || "—"}</Field>
            <Field label="SHA-256">
              <span className="font-mono text-xs text-base-400">{file.sha256_hash ? `${file.sha256_hash.slice(0, 16)}…` : "not hashed yet"}</span>
            </Field>
            <Field label="Path"><span className="font-mono text-xs text-base-400">{file.current_path}</span></Field>
          </div>

          {file.metadata && (
            <div>
              <p className="label mb-2">Extracted metadata ({file.metadata.extractor})</p>
              <pre className="max-h-40 overflow-auto rounded-xl border border-line bg-inset p-3 font-mono text-xs text-base-300">
                {JSON.stringify(file.metadata.data, null, 2)}
              </pre>
            </div>
          )}

          {file.content && (
            <Field label="Extracted text">{file.content.textLength} characters extracted</Field>
          )}

          {file.latestClassification && (
            <div className="rounded-xl border border-line-strong bg-base-900 p-3">
              <p className="label mb-1.5">Latest classification</p>
              <div className="flex items-center gap-2">
                <StatusBadge value={file.latestClassification.confidence_level} />
                <span className="text-xs text-base-400">score {Number(file.latestClassification.confidence_score).toFixed(2)}</span>
              </div>
            </div>
          )}

          {file.duplicateGroups?.length > 0 && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-700">
              This file belongs to {file.duplicateGroups.length} duplicate group(s).
            </div>
          )}

          <div className="flex gap-2">
            {/* Every other download call site in the app catches and toasts;
                this one did not, so a failed download here produced an
                unhandled rejection and no feedback at all. */}
            <button
              className="btn-primary flex-1"
              onClick={() =>
                api
                  .download(`/files/${file.id}/download`, file.filename_current)
                  .catch((err) => push(err.message, "error"))
              }
            >
              <Download size={14} /> Download
            </button>
            {hasPermission("document.download") && file.status !== "deleted" && (
              <button
                className="btn-secondary"
                onClick={revealOnComputer}
                disabled={revealing}
                title="Open on this computer -- reveals the file in your OS file manager. Only works when the server itself is running on this machine."
              >
                {revealing ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
              </button>
            )}
            {/* Each action is gated on its handler as well as its permission.
                Only onMove used to be, so a caller that wired up some of the
                three -- the Duplicates page wants edit but has no business
                offering "remove file" from a group review -- rendered a
                button that called undefined. */}
            {onEdit && (hasPermission("document.rename") || hasPermission("classification.modify")) && file.status !== "deleted" && (
              <button className="btn-secondary" onClick={() => onEdit(file)} title="Edit">
                <Pencil size={14} />
              </button>
            )}
            {onMove && hasPermission("classification.modify") && file.status !== "deleted" && (
              <button className="btn-secondary" onClick={() => onMove(file)} title="Move to another subject">
                <FolderInput size={14} />
              </button>
            )}
            {onDelete && hasPermission("document.delete") && file.status !== "deleted" && (
              <button className="btn-danger" onClick={() => onDelete(file)} title="Remove file">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
