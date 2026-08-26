import { useState, useEffect } from "react";
import { Search, BookCopy, Pencil } from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { StatusBadge } from "../components/StatusBadge";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { formatDate } from "../utils/format";

const LIMIT = 25;

export function DocumentsPage() {
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(null);
  const { push } = useToast();
  const { hasPermission } = useAuth();

  // Held one beat behind the input for the same reason as FilesPage: `q` fed
  // straight into the fetch dependency meant a request per keystroke.
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const { data: documents, loading, error, reload } = useApiData(
    () => api.get("/documents", { q: debouncedQ || undefined, limit: LIMIT, offset }),
    [debouncedQ, offset]
  );

  return (
    <div>
      <PageHeader title="Documents" description="Logical documents established from your files, independent of any single file's lifecycle." />

      <div className="mb-4 relative max-w-sm">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-400" />
        <input className="input pl-9" placeholder="Search documents…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
      </div>

      {loading ? (
        <PageSpinner />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} title="Couldn't load documents" />
      ) : !documents?.length ? (
        <EmptyState icon={BookCopy} title="No documents yet" description="Documents are created once files are classified with enough confidence." />
      ) : (
        <div className="table-shell glass-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wider text-base-400">
                <th className="px-4 py-3 font-medium">Display name</th>
                <th className="col-tertiary px-4 py-3 font-medium">Canonical name</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="col-secondary px-4 py-3 font-medium">Updated</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id} className="table-row-hover border-b border-line last:border-0">
                  <td className="px-4 py-3 font-medium text-base-100">
                    {d.display_name}
                    <div className="cell-subline font-normal">{formatDate(d.updated_at)}</div>
                  </td>
                  <td className="col-tertiary px-4 py-3 font-mono text-xs text-base-400">{d.canonical_name || "—"}</td>
                  <td className="px-4 py-3"><StatusBadge value={d.status} /></td>
                  <td className="col-secondary px-4 py-3 text-base-400">{formatDate(d.updated_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {hasPermission("classification.modify") && (
                      <button className="btn-ghost btn-sm" onClick={() => setEditing(d)}>
                        <Pencil size={13} /> Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination offset={offset} limit={LIMIT} pageCount={documents?.length} onChange={setOffset} />
        </div>
      )}

      <EditDocumentModal
        document={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); reload(); push("Document updated.", "success"); }}
      />
    </div>
  );
}

function EditDocumentModal({ document, onClose, onSaved }) {
  const { data: docTypes } = useApiData(() => api.get("/document-types"), []);
  const [displayName, setDisplayName] = useState("");
  const [documentTypeId, setDocumentTypeId] = useState("");
  const [saving, setSaving] = useState(false);
  const { push } = useToast();

  // Reset form state whenever a different document is opened for editing.
  useEffect(() => {
    setDisplayName(document?.display_name || "");
    setDocumentTypeId(document?.document_type_id || "");
  }, [document]);

  return (
    <Modal
      open={Boolean(document)}
      onClose={onClose}
      title="Edit document"
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary btn-sm"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await api.patch(`/documents/${document.id}`, {
                  displayName: displayName || undefined,
                  documentTypeId: documentTypeId || undefined,
                });
                onSaved();
              } catch (err) {
                push(err.message, "error");
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      {document && (
        <div className="space-y-4">
          <div>
            <label className="label">Display name</label>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <label className="label">Document type</label>
            <select className="input" value={documentTypeId} onChange={(e) => setDocumentTypeId(e.target.value)}>
              <option value="">Unassigned</option>
              {(docTypes || []).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </Modal>
  );
}
