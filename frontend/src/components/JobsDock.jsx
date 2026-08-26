import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, ExternalLink, CheckCircle2, XCircle } from "lucide-react";
import { api } from "../services/apiClient";
import { usePolling } from "../hooks/useApiData";
import { FloatingPanel } from "./FloatingPanel";

/**
 * Background work, visible from anywhere.
 *
 * Scans, renames, mirror syncs and email syncs all run as queued jobs, so
 * the interesting moment is always "something is happening right now" --
 * and a dedicated page is the wrong place for that. You have to leave what
 * you were doing to check, and the thing you wanted to watch has usually
 * finished by the time you arrive.
 *
 * This polls only while it matters: an active job, or a recently finished
 * one still worth acknowledging. When nothing is happening it collapses to
 * a small launcher rather than occupying the screen.
 */

const ACTIVE_POLL_MS = 2500;
const IDLE_POLL_MS = 15000;

// How long a finished job stays listed, so a fast job doesn't flash past
// with no chance to see whether it worked.
const RECENT_WINDOW_MS = 60_000;

const JOB_LABELS = {
  scan: "Scanning folder",
  hash: "Hashing",
  extract_metadata: "Reading metadata",
  extract_text: "Extracting text",
  classify: "Classifying",
  detect_duplicates: "Checking duplicates",
  detect_versions: "Checking versions",
  generate_names: "Proposing names",
  bulk_rename: "Applying names",
  bulk_delete: "Removing files",
  bulk_move: "Moving files",
  auto_resolve_duplicates: "Resolving duplicates",
  email_sync: "Syncing mail",
  sync_mirror: "Updating organized folder",
  reindex: "Reprocessing",
};

const label = (t) => JOB_LABELS[t] || t;
const isActive = (j) => j.status === "running" || j.status === "queued" || j.status === "retrying";

export function JobsDock() {
  const [dismissed, setDismissed] = useState(false);
  const [pollMs, setPollMs] = useState(IDLE_POLL_MS);

  const { data: jobs } = usePolling(
    () => api.get("/processing-jobs", { limit: 40 }),
    pollMs,
    true,
    []
  );

  const { active, recent } = useMemo(() => {
    const list = jobs || [];
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return {
      active: list.filter(isActive),
      recent: list.filter(
        (j) => !isActive(j) && j.finished_at && new Date(j.finished_at).getTime() > cutoff
      ),
    };
  }, [jobs]);

  // Poll hard only while there is something to watch. Idling at 2.5s from
  // every open tab is a lot of pointless traffic for a page that is usually
  // showing nothing.
  useEffect(() => {
    setPollMs(active.length > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }, [active.length]);

  // Work starting is exactly when this should reappear, even if it was
  // dismissed earlier -- otherwise dismissing once hides it forever.
  useEffect(() => {
    if (active.length > 0) setDismissed(false);
  }, [active.length]);

  const visible = active.length + recent.length;

  if (dismissed || visible === 0) {
    return (
      <button
        className="glass-card fixed bottom-6 left-6 z-30 flex items-center gap-2 px-3 py-2 text-xs text-base-300 shadow-lg hover:text-base-100"
        onClick={() => setDismissed(false)}
        title="Background activity"
      >
        <Activity size={13} className={active.length ? "text-emerald-600" : "text-base-500"} />
        {active.length > 0 ? `${active.length} running` : "No activity"}
      </button>
    );
  }

  return (
    <FloatingPanel
      id="jobs"
      title="Background activity"
      icon={Activity}
      onClose={() => setDismissed(true)}
      defaultWidth={400}
      defaultHeight={320}
      badge={
        active.length > 0 ? (
          <span className="badge-emerald shrink-0">{active.length} running</span>
        ) : null
      }
    >
      <div className="space-y-1.5 p-3">
        {active.map((j) => (
          <JobRow key={j.id} job={j} />
        ))}
        {recent.map((j) => (
          <JobRow key={j.id} job={j} finished />
        ))}

        <Link
          to="/jobs"
          className="mt-2 flex items-center justify-center gap-1.5 rounded-lg border border-line py-2 text-[11px] text-base-400 hover:text-base-200"
        >
          <ExternalLink size={11} /> Full history
        </Link>
      </div>
    </FloatingPanel>
  );
}

function JobRow({ job, finished = false }) {
  const total = job.progress_total || 0;
  const current = job.progress_current || 0;
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : null;
  const failed = job.status === "failed";

  return (
    <div className="rounded-lg border border-line bg-base-900 px-3 py-2">
      <div className="flex items-center gap-2">
        {finished &&
          (failed ? (
            <XCircle size={12} className="shrink-0 text-rose-600" />
          ) : (
            <CheckCircle2 size={12} className="shrink-0 text-emerald-600" />
          ))}
        <p className="truncate text-xs text-base-100">{label(job.job_type)}</p>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-base-500">
          {pct !== null ? `${current}/${total}` : job.status}
        </span>
      </div>

      {/* Only render a bar when the job actually reported a denominator --
          a bar that cannot move is worse than no bar. */}
      {pct !== null && !finished && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-base-850">
          <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}

      {failed && job.error_message && (
        <p className="mt-1 line-clamp-2 text-[11px] text-rose-700/80">{job.error_message}</p>
      )}
    </div>
  );
}
