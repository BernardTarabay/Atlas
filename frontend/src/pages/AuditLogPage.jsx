import { useState } from "react";
import { ScrollText, Download, Trash2 } from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { StatusBadge } from "../components/StatusBadge";
import { Pagination } from "../components/Pagination";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { formatDate } from "../utils/format";

const LIMIT = 30;

export function AuditLogPage() {
  const [offset, setOffset] = useState(0);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState(null);
  const { data: logs, loading, error, reload } = useApiData(() => api.get("/audit-logs", { limit: LIMIT, offset }), [offset]);
  const { push } = useToast();
  const { hasPermission } = useAuth();

  async function exportCsv() {
    setExporting(true);
    try {
      await api.download("/audit-logs/export", "audit-log.csv");
    } catch (err) {
      push(err.message, "error");
    } finally {
      setExporting(false);
    }
  }

  async function confirmClear() {
    setClearing(true);
    try {
      const result = await api.del("/audit-logs");
      push(`Cleared ${result.cleared} audit entr${result.cleared === 1 ? "y" : "ies"}.`, "success");
      setClearOpen(false);
      setOffset(0);
      reload();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setClearing(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Every state-changing action, who performed it, and what changed."
        actions={
          <>
            <button className="btn-secondary btn-sm" onClick={exportCsv} disabled={exporting}>
              <Download size={13} /> {exporting ? "Exporting…" : "Export CSV"}
            </button>
            {hasPermission("audit.manage") && (
              <button className="btn-danger btn-sm" onClick={() => setClearOpen(true)}>
                <Trash2 size={13} /> Clear log
              </button>
            )}
          </>
        }
      />

      {loading ? (
        <PageSpinner />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} title="Couldn't load the audit log" />
      ) : !logs?.length ? (
        <EmptyState icon={ScrollText} title="No audit entries yet" />
      ) : (
        <div className="table-shell glass-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wider text-base-400">
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="col-secondary px-4 py-3 font-medium">Entity</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((entry) => (
                <tr
                  key={entry.id}
                  className="table-row-hover cursor-pointer border-b border-line last:border-0"
                  onClick={() => setSelected(entry)}
                >
                  <td className="px-4 py-3 font-medium text-base-100">
                    {entry.action.replace(/_/g, " ")}
                    <div className="cell-subline font-normal">{entry.entity_type}</div>
                  </td>
                  <td className="col-secondary px-4 py-3 text-base-400">
                    {entry.entity_type}
                    {entry.entity_id && <span className="ml-1 font-mono text-xs text-base-500">#{entry.entity_id.slice(0, 8)}</span>}
                  </td>
                  <td className="px-4 py-3"><StatusBadge value={entry.status} /></td>
                  <td className="px-4 py-3 text-base-400">{formatDate(entry.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination offset={offset} limit={LIMIT} pageCount={logs?.length} onChange={setOffset} />
        </div>
      )}

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={confirmClear}
        loading={clearing}
        danger
        title="Clear audit log"
        confirmLabel="Clear log"
        description="This permanently deletes every audit log entry. Consider exporting a CSV first — this can't be undone. A single new entry noting who cleared it will be recorded afterward."
      />

      <AuditEntryModal entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

/**
 * The list view only ever showed action/entity/status/timestamp -- the
 * actual diagnostic content (why something failed, what changed) lives in
 * reason/previous_state/new_state, which were captured on every record()
 * call from day one but had no UI to surface them. Without this, "why is
 * X failing" always dead-ended at a bare "failed" badge.
 */
function AuditEntryModal({ entry, onClose }) {
  return (
    <Modal open={Boolean(entry)} onClose={onClose} title="Audit entry" width="max-w-lg">
      {entry && (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-4">
            <div><p className="label">Action</p><p className="text-base-100">{entry.action}</p></div>
            <div><p className="label">Status</p><StatusBadge value={entry.status} /></div>
            <div><p className="label">Entity</p><p className="text-base-100">{entry.entity_type}{entry.entity_id ? ` #${entry.entity_id.slice(0, 8)}` : ""}</p></div>
            <div><p className="label">When</p><p className="text-base-100">{formatDate(entry.created_at)}</p></div>
          </div>

          {entry.reason && (
            <div>
              <p className="label mb-1.5">Reason</p>
              <p className={entry.status === "failed" ? "rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-rose-700" : "text-base-200"}>
                {entry.reason}
              </p>
            </div>
          )}

          {entry.previous_state && (
            <div>
              <p className="label mb-1.5">Previous state</p>
              <pre className="max-h-40 overflow-auto rounded-xl border border-line bg-inset p-3 font-mono text-xs text-base-300">
                {JSON.stringify(entry.previous_state, null, 2)}
              </pre>
            </div>
          )}

          {entry.new_state && (
            <div>
              <p className="label mb-1.5">New state</p>
              <pre className="max-h-40 overflow-auto rounded-xl border border-line bg-inset p-3 font-mono text-xs text-base-300">
                {JSON.stringify(entry.new_state, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
