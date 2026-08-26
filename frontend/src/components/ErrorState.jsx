import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * "We could not load this", as distinct from "there is nothing here".
 *
 * WHY THIS EXISTS
 *
 * useApiData has always returned `error`, and almost every page threw it
 * away, destructuring only `{ data, loading }`. When a fetch failed, `data`
 * stayed null and the page fell through to its empty state -- so a backend
 * that was down, a query that 400'd, or an expired session all rendered as
 * "No files found. Register a storage location and run a scan to start
 * ingesting files."
 *
 * That is the worst possible thing to show, because it is a confident,
 * actionable lie: it tells someone whose 9,000-file repository is fine that
 * it is empty, and invites them to go re-scan it. Someone acting on that
 * advice is now debugging the wrong problem entirely.
 *
 * An error state has to be visibly different from an empty one and has to
 * offer the only useful action -- try again.
 */
export function ErrorState({ error, onRetry, title = "Couldn't load this", compact = false }) {
  // ApiError carries .status; a bare network failure (server not running)
  // does not, and its message is the unhelpfully generic "Failed to fetch".
  const status = error?.status;
  const detail =
    status === undefined
      ? "The server didn't respond. It may not be running."
      : error?.message || `Request failed (${status})`;

  return (
    <div
      role="alert"
      className={
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-rose-500/30 bg-rose-500/[0.03] px-6 text-center " +
        (compact ? "py-8" : "py-16")
      }
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-rose-500/20 bg-rose-500/10">
        <AlertTriangle size={22} className="text-rose-600" />
      </div>
      <div>
        <p className="text-sm font-medium text-base-100">{title}</p>
        <p className="mt-1 max-w-md text-sm text-base-400">{detail}</p>
      </div>
      {onRetry && (
        <button type="button" className="btn-ghost btn-sm" onClick={onRetry}>
          <RefreshCw size={14} /> Try again
        </button>
      )}
    </div>
  );
}
