import { FolderTree, FolderOpen, Loader2, Files } from "lucide-react";

/**
 * The state of the archive, in one line, above the Library.
 *
 * WHY THIS IS NOT A SECOND DASHBOARD
 *
 * The Dashboard answers "what is the pipeline doing" with a funnel, trend
 * charts and per-stage counters. That is a real question, asked occasionally
 * and on purpose. This answers a different one, asked every single time
 * someone opens the app: *how much of my stuff is sorted, and how much still
 * needs me?* Four numbers, one of which you can act on.
 *
 * The unfiled count is the important one and is a BUTTON, not a statistic.
 * Someone who has just pointed Atlas at a drive with twenty years of
 * accumulated files opens this page to a large number and needs the next
 * click to be obvious. A number you cannot click is a reproach.
 */
export function LibraryOverview({ summary, unfiledActive, onShowUnfiled, loading }) {
  const totals = summary?.totals || {};
  const attention = summary?.attention || {};

  const total = totals.files || 0;
  const unfiled = attention.unfiled || 0;
  const inFlight = attention.jobsInFlight || 0;
  // "Filed" is the funnel stage of the same name -- taken from the funnel
  // rather than computed as total-minus-unfiled so this cannot drift from
  // what the Dashboard says about the identical thing.
  const filed = (summary?.funnel || []).find((s) => s.stage === "Filed")?.count ?? Math.max(total - unfiled, 0);
  const pct = total > 0 ? Math.round((filed / total) * 100) : 0;

  return (
    <div className="mb-4 flex flex-wrap items-stretch gap-2">
      <Stat icon={Files} label="Documents" value={total} loading={loading} />
      <Stat
        icon={FolderTree}
        label="Filed"
        value={filed}
        hint={total > 0 ? `${pct}%` : null}
        loading={loading}
      />

      {/* The one actionable tile. Styled as a live control when there is
          anything in it, and deliberately calm when the pile is empty --
          "0 unfiled" is a win, not an alert. */}
      <button
        onClick={onShowUnfiled}
        disabled={loading}
        className={
          "flex min-w-[9rem] flex-1 items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors " +
          (unfiledActive
            ? "border-amber-400/50 bg-amber-500/15"
            : unfiled > 0
              ? "border-amber-500/25 bg-amber-500/[0.07] hover:border-amber-400/40 hover:bg-amber-500/[0.12]"
              : "border-line bg-base-900 hover:border-line-strong")
        }
        title={
          unfiled > 0
            ? "Show everything that hasn't been filed under a subject yet"
            : "Nothing is waiting to be filed"
        }
      >
        <FolderOpen size={18} className={unfiled > 0 ? "shrink-0 text-amber-700" : "shrink-0 text-base-500"} />
        <span className="min-w-0">
          <span className="block text-lg font-semibold tabular-nums leading-tight text-base-50">
            {loading ? "—" : unfiled.toLocaleString()}
          </span>
          <span className="block truncate text-xs text-base-400">
            {unfiled > 0 ? "waiting to be filed" : "nothing unfiled"}
          </span>
        </span>
      </button>

      {/* Only when there is something in flight. A permanent "0 processing"
          tile is chrome; a number that appears when the worker picks up is
          information. */}
      {inFlight > 0 && (
        <div className="flex min-w-[9rem] flex-1 items-center gap-3 rounded-2xl border border-brand-500/25 bg-brand-500/[0.07] px-4 py-3">
          <Loader2 size={18} className="shrink-0 animate-spin text-brand-700" />
          <span className="min-w-0">
            <span className="block text-lg font-semibold tabular-nums leading-tight text-base-50">
              {inFlight.toLocaleString()}
            </span>
            <span className="block truncate text-xs text-base-400">being processed</span>
          </span>
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, hint, loading }) {
  return (
    <div className="flex min-w-[9rem] flex-1 items-center gap-3 rounded-2xl border border-line bg-base-900 px-4 py-3">
      <Icon size={18} className="shrink-0 text-base-500" />
      <span className="min-w-0">
        <span className="block text-lg font-semibold tabular-nums leading-tight text-base-50">
          {loading ? "—" : value.toLocaleString()}
          {hint && !loading && <span className="ml-1.5 text-xs font-normal text-base-500">{hint}</span>}
        </span>
        <span className="block truncate text-xs text-base-400">{label}</span>
      </span>
    </div>
  );
}
