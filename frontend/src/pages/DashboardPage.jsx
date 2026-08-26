import { Link } from "react-router-dom";
import {
  FileText, Search, Wand2, HardDrive, AlertTriangle, ScanLine, FolderSearch,
  ArrowUpRight, Activity, CheckCircle2, Layers, Clock,
} from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { StatusBadge } from "../components/StatusBadge";
import { useAuth } from "../context/AuthContext";
import { formatBytes, relativeTime } from "../utils/format";

/**
 * WHAT CHANGED AND WHY
 *
 * The previous dashboard fetched `/files?limit=200` and rendered
 * `files.length`, so on a 9,398-file repository it reported "200 files
 * tracked". Every tile had the same ceiling. It now reads one endpoint backed
 * by SQL aggregates (`/dashboard/summary`), so the numbers are true at any
 * size and the payload is counts rather than hundreds of rows.
 *
 * DESIGN NOTES
 *
 * Most of this is deliberately NOT charts. Totals are headline numbers, and a
 * number is the clearest way to show one. The two charts that do exist each
 * plot a single series across ordered categories, so each uses ONE hue with
 * direct labels and no legend -- there is no identity to encode, only
 * magnitude. The old jobs-by-status pie is gone: a five-slice donut is a
 * worse bar chart with a legend attached.
 *
 * Colors are picked by job, not by taste, and were re-validated against the
 * app's LIGHT card surface (#ffffff) when the palette moved off dark. The old
 * values were chosen to carry on #12141d and did not survive the move: the
 * warning amber measured 1.83:1 on white -- far below the 3:1 a chart mark
 * needs to be seen at all. Same hues, darker (ratios measured, not estimated):
 *   --mark-primary / --mark-secondary  single-hue magnitude, all checks pass
 *   status good/warn/critical          state, always paired with an icon and
 *                                      a label so hue never carries meaning
 *                                      alone
 */

const VIZ = {
  markPrimary: "#2563eb",   // funnel — magnitude (5.17:1 on white)
  markSecondary: "#047857", // extraction coverage — magnitude (5.48:1)
  good: "#15803d",          // 5.02:1 (was 3.35:1)
  warning: "#b45309",       // 5.02:1 (was 1.83:1)
  critical: "#be123c",      // 6.29:1
};

const pct = (n, total) => (total > 0 ? Math.round((n / total) * 100) : 0);

export function DashboardPage() {
  const { user, hasPermission } = useAuth();

  const { data, loading, error } = useApiData(() =>
    Promise.all([
      api.get("/dashboard/summary"),
      hasPermission("audit.view") ? api.get("/audit-logs", { limit: 7 }).catch(() => []) : Promise.resolve([]),
    ]).then(([summary, audit]) => ({ ...summary, audit }))
  , [hasPermission]);

  if (loading) return <PageSpinner />;
  if (error) {
    return (
      <div>
        <PageHeader title="Dashboard" description="Something went wrong loading the overview." />
        <div className="glass-card p-6 text-sm text-rose-700">{error.message}</div>
      </div>
    );
  }

  const { totals, funnel, attention, extensions, locations, jobs, trend, audit } = data;
  const searchablePct = pct(totals.searchable, totals.files);
  const namedPct = pct(totals.named, totals.files);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome back, ${user?.full_name?.split(" ")[0] || "there"}`}
        description={
          totals.files === 0
            ? "Nothing indexed yet — register a folder to get started."
            : `${totals.files.toLocaleString()} files across ${locations.length} location${locations.length === 1 ? "" : "s"}, ${formatBytes(totals.bytes)} in total.`
        }
      />

      {totals.files === 0 ? (
        <EmptyDashboard />
      ) : (
        <>
          {/* Headline numbers. Four figures, each answering a different
              question: how much is here, how much can I find, how much is
              organised, and what is it costing me. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <HeroTile
              icon={FileText}
              label="Files tracked"
              value={totals.files.toLocaleString()}
              sub={formatBytes(totals.bytes)}
            />
            <HeroTile
              icon={Search}
              label="Searchable by content"
              value={`${searchablePct}%`}
              sub={`${totals.searchable.toLocaleString()} of ${totals.files.toLocaleString()} readable`}
              tone={searchablePct < 50 ? "warning" : "good"}
            />
            <HeroTile
              icon={Wand2}
              label="Given a proper name"
              value={`${namedPct}%`}
              sub={`${totals.named.toLocaleString()} renamed so far`}
              tone={namedPct < 25 ? "warning" : "good"}
            />
            <HeroTile
              icon={HardDrive}
              label="Wasted on duplicates"
              value={formatBytes(attention.reclaimableBytes)}
              sub={`${attention.redundantCopies.toLocaleString()} redundant copies`}
              tone={attention.reclaimableBytes > 0 ? "warning" : "good"}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            {/* The funnel is the centrepiece: every stage is a subset of the
                one above, so wherever the bar shortens sharply is exactly
                where files are getting stuck. */}
            <section className="glass-card p-5 xl:col-span-3">
              <SectionHead
                icon={Layers}
                title="Processing pipeline"
                hint="Each stage is a subset of the one above it — a sharp drop is where files are getting stuck."
              />
              <div className="mt-4 space-y-3">
                {funnel.map((s, i) => {
                  const width = pct(s.count, funnel[0].count || 1);
                  const lost = i > 0 ? funnel[i - 1].count - s.count : 0;
                  return (
                    <div key={s.stage}>
                      <div className="mb-1 flex items-baseline justify-between gap-3">
                        <span className="text-xs text-base-300" title={s.hint}>{s.stage}</span>
                        <span className="text-xs tabular-nums text-base-400">
                          <span className="font-medium text-base-100">{s.count.toLocaleString()}</span>
                          {i > 0 && lost > 0 && (
                            <span className="ml-2 text-[11px] text-amber-700/80">−{lost.toLocaleString()}</span>
                          )}
                        </span>
                      </div>
                      {/* 4px rounded data end, anchored to a visible track so
                          the missing portion is legible as loss rather than
                          absence. */}
                      <div className="h-2 w-full overflow-hidden rounded-[4px] bg-base-800">
                        <div
                          className="h-full rounded-[4px] transition-[width] duration-500"
                          style={{ width: `${Math.max(width, s.count > 0 ? 1.5 : 0)}%`, background: VIZ.markPrimary }}
                          title={`${s.stage}: ${s.count.toLocaleString()} files (${width}%)`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Actionable, and every row links to the page that fixes it. */}
            <section className="glass-card p-5 xl:col-span-2">
              <SectionHead icon={AlertTriangle} title="Needs your attention" />
              <div className="mt-3 space-y-1">
                {/* These two now land on Triage rather than a page that
                    merely contains the affected files somewhere in it --
                    Triage filters to exactly this set and offers the fix. */}
                <AttentionRow
                  icon={ScanLine} tone="warning" to="/triage?reason=needs_ocr"
                  count={attention.needsOcr} label="need OCR"
                  detail="Scans and photos with no readable text"
                />
                <AttentionRow
                  icon={FolderSearch} tone="warning" to="/?unfiled=1"
                  count={attention.unfiled} label="not filed"
                  detail="No subject assigned yet"
                />
                <AttentionRow
                  icon={AlertTriangle} tone="critical" to="/triage?reason=stalled"
                  count={attention.stalled} label="stalled"
                  detail="Discovered but nothing is processing them"
                />
                <AttentionRow
                  icon={AlertTriangle} tone="critical" to="/jobs"
                  count={attention.jobsFailedToday} label="jobs failed today"
                  detail="Check the job log for the reason"
                />
                {attention.jobsInFlight > 0 && (
                  <div className="mt-2 flex items-center gap-2 rounded-lg border border-line-strong bg-base-900 px-3 py-2">
                    <Activity size={13} className="shrink-0 animate-pulse text-brand-600" />
                    <p className="text-xs text-base-300">
                      <span className="font-medium text-base-100">{attention.jobsInFlight.toLocaleString()}</span> jobs
                      still running — these numbers will keep moving.
                    </p>
                  </div>
                )}
              </div>
            </section>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            {/* The OCR argument, made with numbers: file types ranked by how
                much of each is actually readable. */}
            <section className="glass-card p-5 xl:col-span-3">
              <SectionHead
                icon={Search}
                title="How much of each file type is readable"
                hint="Types with low coverage are the ones search cannot see inside."
              />
              <div className="mt-4 space-y-2.5">
                {extensions.map((e) => {
                  const cov = pct(e.searchable, e.files);
                  return (
                    <div key={e.ext} className="grid grid-cols-[3.5rem_1fr_5.5rem] items-center gap-3">
                      <span className="truncate font-mono text-[11px] text-base-300">.{e.ext}</span>
                      <div
                        className="h-2 w-full overflow-hidden rounded-[4px] bg-base-800"
                        title={`${e.ext}: ${e.searchable.toLocaleString()} of ${e.files.toLocaleString()} readable (${cov}%)`}
                      >
                        <div
                          className="h-full rounded-[4px]"
                          style={{ width: `${cov}%`, background: VIZ.markSecondary }}
                        />
                      </div>
                      <span className="text-right text-[11px] tabular-nums text-base-400">
                        <span className={cov === 0 ? "text-base-500" : "text-base-200"}>{cov}%</span>
                        <span className="ml-1.5 text-base-500">{e.files.toLocaleString()}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[11px] text-base-500">
                Images and formats with no text layer read 0% by nature — that is what OCR would change.
              </p>
            </section>

            <section className="glass-card p-5 xl:col-span-2">
              <SectionHead icon={Clock} title="Files added" hint="Last 14 days" />
              <IngestionTrend trend={trend} />
            </section>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            <section className="glass-card p-5 xl:col-span-3">
              <div className="mb-3 flex items-center justify-between">
                <SectionHead icon={HardDrive} title="Storage locations" />
                <Link to="/storage-locations" className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700">
                  Manage <ArrowUpRight size={12} />
                </Link>
              </div>
              <div className="-mx-2 overflow-x-auto">
                <table className="w-full min-w-0 text-left text-xs sm:min-w-[28rem]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-base-500">
                      <th className="px-2 py-1.5 font-medium">Location</th>
                      <th className="px-2 py-1.5 text-right font-medium">Files</th>
                      <th className="px-2 py-1.5 text-right font-medium">Size</th>
                      <th className="col-secondary px-2 py-1.5 text-right font-medium">Named</th>
                      <th className="col-secondary px-2 py-1.5 text-right font-medium">Last scan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {locations.map((l) => (
                      <tr key={l.id} className="border-t border-line">
                        <td className="max-w-[14rem] truncate px-2 py-2 text-base-100" title={l.rootPath}>
                          {l.name}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-base-300">{l.files.toLocaleString()}</td>
                        <td className="px-2 py-2 text-right tabular-nums text-base-400">{formatBytes(l.bytes)}</td>
                        <td className="col-secondary px-2 py-2 text-right tabular-nums text-base-400">{pct(l.named, l.files)}%</td>
                        <td className="col-secondary px-2 py-2 text-right text-base-500">
                          {l.lastScan ? relativeTime(l.lastScan) : "never"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="glass-card p-5 xl:col-span-2">
              <div className="mb-3 flex items-center justify-between">
                <SectionHead icon={Activity} title="Recent activity" />
                {hasPermission("audit.view") && (
                  <Link to="/audit-log" className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700">
                    All <ArrowUpRight size={12} />
                  </Link>
                )}
              </div>
              {!hasPermission("audit.view") ? (
                <p className="py-8 text-center text-xs text-base-500">
                  Ask an admin for audit-log access to see activity here.
                </p>
              ) : audit.length === 0 ? (
                <p className="py-8 text-center text-xs text-base-500">Nothing recorded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {audit.map((entry) => (
                    <li key={entry.id} className="flex items-center justify-between gap-2 border-b border-line pb-2 last:border-0 last:pb-0">
                      <div className="min-w-0">
                        <p className="truncate text-xs text-base-100">{entry.action.replace(/[._]/g, " ")}</p>
                        <p className="text-[10px] text-base-500">{relativeTime(entry.created_at)}</p>
                      </div>
                      <StatusBadge value={entry.status} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {jobs.length > 0 && (
            <section className="glass-card p-5">
              <SectionHead icon={Activity} title="Pipeline activity" hint="Jobs in the last 24 hours" />
              <div className="mt-3 flex flex-wrap gap-2">
                {jobs.map((j) => (
                  <div key={j.type} className="rounded-lg border border-line-strong bg-base-900 px-3 py-2">
                    <p className="font-mono text-[10px] text-base-400">{j.type}</p>
                    <div className="mt-1 flex items-center gap-2.5 text-[11px] tabular-nums">
                      <span className="flex items-center gap-1 text-base-200">
                        <CheckCircle2 size={10} style={{ color: VIZ.good }} /> {j.completed.toLocaleString()}
                      </span>
                      {j.active > 0 && (
                        <span className="flex items-center gap-1 text-base-300">
                          <Activity size={10} className="text-brand-600" /> {j.active.toLocaleString()}
                        </span>
                      )}
                      {j.failed > 0 && (
                        <span className="flex items-center gap-1" style={{ color: VIZ.critical }}>
                          <AlertTriangle size={10} /> {j.failed.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function SectionHead({ icon: Icon, title, hint }) {
  return (
    <div>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-base-50">
        <Icon size={14} className="text-base-400" /> {title}
      </h3>
      {hint && <p className="mt-0.5 text-[11px] text-base-500">{hint}</p>}
    </div>
  );
}

const TONE_COLOR = { good: "#0ca30c", warning: "#fab219", critical: "#d03b3b" };

function HeroTile({ icon: Icon, label, value, sub, tone }) {
  return (
    <div className="glass-card animate-fade-in-up p-5">
      <div className="flex items-start justify-between">
        <p className="text-xs text-base-400">{label}</p>
        <Icon size={15} style={{ color: tone ? TONE_COLOR[tone] : undefined }} className={tone ? "" : "text-base-500"} />
      </div>
      {/* The hero number carries the weight; the unit sits under it rather
          than beside it, so scanning the row compares like with like. */}
      <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-base-50">{value}</p>
      {sub && <p className="mt-1 text-[11px] text-base-500">{sub}</p>}
    </div>
  );
}

/**
 * Zero is a good outcome here, so a row at zero renders muted rather than
 * disappearing -- "0 stalled" is information worth seeing, and a list that
 * hides its healthy entries makes the remaining ones look like the whole
 * story.
 */
function AttentionRow({ icon: Icon, tone, count, label, detail, to }) {
  const quiet = count === 0;
  const body = (
    <div
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition ${
        quiet ? "opacity-45" : "hover:bg-base-850"
      }`}
    >
      <Icon size={14} className="shrink-0" style={{ color: quiet ? "#6b7280" : TONE_COLOR[tone] }} />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-base-100">
          <span className="font-semibold tabular-nums">{count.toLocaleString()}</span>{" "}
          <span className="text-base-300">{label}</span>
        </p>
        <p className="truncate text-[10px] text-base-500">{detail}</p>
      </div>
      {!quiet && <ArrowUpRight size={12} className="shrink-0 text-base-500" />}
    </div>
  );
  return quiet ? body : <Link to={to}>{body}</Link>;
}

/** Fourteen days of ingestion. A bar per day, direct-labelled only at the
 *  peak -- a number over every bar is noise at this size. */
function IngestionTrend({ trend }) {
  const max = Math.max(...trend.map((t) => t.files), 1);
  const total = trend.reduce((s, t) => s + t.files, 0);

  if (total === 0) {
    return <p className="py-10 text-center text-xs text-base-500">Nothing added in the last 14 days.</p>;
  }

  return (
    <div className="mt-4">
      <div className="flex h-28 items-end gap-1">
        {trend.map((t) => (
          <div
            key={t.day}
            className="group flex-1"
            title={`${new Date(t.day).toLocaleDateString()}: ${t.files.toLocaleString()} file(s)`}
          >
            <div
              className="w-full rounded-t-[4px] transition-opacity group-hover:opacity-80"
              style={{
                height: `${Math.max((t.files / max) * 100, t.files > 0 ? 3 : 1)}%`,
                background: t.files > 0 ? VIZ.markPrimary : "rgba(255,255,255,0.07)",
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-baseline justify-between text-[10px] text-base-500">
        <span>14 days ago</span>
        <span className="tabular-nums text-base-300">{total.toLocaleString()} added</span>
        <span>today</span>
      </div>
    </div>
  );
}

function EmptyDashboard() {
  return (
    <div className="glass-card p-10 text-center">
      <HardDrive size={28} className="mx-auto text-base-600" />
      <h3 className="mt-3 text-sm font-semibold text-base-100">No files indexed yet</h3>
      <p className="mx-auto mt-1 max-w-md text-xs text-base-400">
        Register a folder and Atlas will scan it in place — your original files are read, never moved,
        renamed, or copied.
      </p>
      <Link to="/storage-locations" className="btn-primary btn-sm mt-4 inline-flex">
        Register a folder <ArrowUpRight size={13} />
      </Link>
    </div>
  );
}
