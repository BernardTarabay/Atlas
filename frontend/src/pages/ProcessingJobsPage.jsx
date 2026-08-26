import { useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { api } from "../services/apiClient";
import { usePolling } from "../hooks/useApiData";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { StatusBadge } from "../components/StatusBadge";
import { Modal } from "../components/Modal";
import { formatDate, relativeTime } from "../utils/format";

export function ProcessingJobsPage() {
  const [selectedId, setSelectedId] = useState(null);
  // `error && !jobs` below, not bare `error`: this polls, so a single failed
  // tick should not replace a list that is still perfectly good on screen.
  const { data: jobs, loading, error, reload } = usePolling(() => api.get("/processing-jobs", { limit: 100 }), 4000, true, []);

  return (
    <div>
      <PageHeader
        title="Processing jobs"
        description="Every background operation the pipeline runs — auto-refreshes every few seconds."
        actions={
          <button className="btn-ghost btn-sm" onClick={reload}>
            <RefreshCw size={13} /> Refresh
          </button>
        }
      />

      {loading && !jobs ? (
        <PageSpinner />
      ) : error && !jobs ? (
        <ErrorState error={error} onRetry={reload} title="Couldn't load processing jobs" />
      ) : !jobs?.length ? (
        <EmptyState icon={Activity} title="No jobs yet" description="Trigger a repository scan to see the pipeline in action." />
      ) : (
        <div className="table-shell glass-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wider text-base-400">
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="col-secondary px-4 py-3 font-medium">Progress</th>
                <th className="px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="table-row-hover cursor-pointer border-b border-line last:border-0" onClick={() => setSelectedId(j.id)}>
                  <td className="px-4 py-3 font-medium text-base-100">
                    {j.job_type.replace(/_/g, " ")}
                    {j.progress_total > 0 && (
                      <div className="cell-subline font-normal">{j.progress_current}/{j.progress_total}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge value={j.status} />
                    {(j.status === "running" || j.status === "queued") && (
                      <span className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse-soft rounded-full bg-sky-400" />
                    )}
                  </td>
                  <td className="col-secondary px-4 py-3 text-base-400">
                    {j.progress_total > 0 ? `${j.progress_current}/${j.progress_total}` : "—"}
                  </td>
                  <td className="px-4 py-3 text-base-400" title={formatDate(j.created_at)}>{relativeTime(j.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <JobDetailModal jobId={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}

function JobDetailModal({ jobId, onClose }) {
  const { data: job, loading } = useApiData(() => (jobId ? api.get(`/processing-jobs/${jobId}`) : Promise.resolve(null)), [jobId]);

  return (
    <Modal open={Boolean(jobId)} onClose={onClose} title="Job detail">
      {loading || !job ? (
        <PageSpinner />
      ) : (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-4">
            <div><p className="label">Type</p><p className="text-base-100">{job.job_type}</p></div>
            <div><p className="label">Status</p><StatusBadge value={job.status} /></div>
            <div><p className="label">Started</p><p className="text-base-100">{formatDate(job.started_at)}</p></div>
            <div><p className="label">Finished</p><p className="text-base-100">{formatDate(job.finished_at)}</p></div>
          </div>

          {job.error_message && (
            <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-rose-700">{job.error_message}</div>
          )}

          {job.itemSummary?.length > 0 && (
            <div>
              <p className="label mb-2">Item breakdown</p>
              <div className="flex flex-wrap gap-2">
                {job.itemSummary.map((row) => (
                  <StatusBadge key={row.status} value={row.status} label={`${row.count} ${row.status}`} />
                ))}
              </div>
            </div>
          )}

          {job.result && (
            <div>
              <p className="label mb-2">Result</p>
              <pre className="max-h-40 overflow-auto rounded-xl border border-line bg-inset p-3 font-mono text-xs text-base-300">
                {JSON.stringify(job.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
