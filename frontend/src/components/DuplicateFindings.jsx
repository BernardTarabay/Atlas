import { AlertTriangle, Copy, GitBranch, Eye, Scale } from "lucide-react";

/**
 * What the duplicate guard found, and what the user can do about it.
 *
 * SHOWN BEFORE THE MOVE, NOT AFTER
 *
 * The invariant is that no duplicate enters the Subjects tree silently. The
 * backend enforces it by refusing the move and answering 409 with these
 * findings; this component is the other half -- it has to make the finding
 * legible enough that "keep both" is an informed choice rather than the
 * fastest way past a dialog.
 *
 * So each finding says WHICH document, WHERE it already is, and WHY the system
 * thinks they are related. The last part is the one usually missing from
 * duplicate warnings, and it is the part that lets someone disagree: "87% of
 * five-word phrases match" is checkable, "possible duplicate" is not.
 *
 * THE THREE KINDS ARE NOT COSMETIC
 *
 *   exact    identical bytes. Provable. Keeping both is usually pointless.
 *   version  the same document, revised. Keeping both is usually CORRECT --
 *            that is what a revision is.
 *   similar  alike, and quite possibly two legitimate documents from one
 *            template. Two months of the same bank statement score high here.
 *
 * Collapsing them into one "duplicate?" prompt is what trains people to click
 * through, after which the exact-match warning gets clicked through too.
 */

const KIND = {
  exact: {
    label: "Identical file",
    Icon: Copy,
    tone: "text-rose-700",
    ring: "border-rose-500/25 bg-rose-500/[0.04]",
  },
  version: {
    label: "Another version",
    Icon: GitBranch,
    tone: "text-sky-700",
    ring: "border-sky-500/25 bg-sky-500/[0.04]",
  },
  similar: {
    label: "Very similar",
    Icon: Scale,
    tone: "text-amber-700",
    ring: "border-amber-500/25 bg-amber-500/[0.04]",
  },
};

/**
 * @param {object} props
 * @param {Array} props.findings
 * @param {(fileId: string) => void} [props.onInspect]
 * @param {(fileId: string) => void} [props.onCompare]
 */
export function DuplicateFindings({ findings, onInspect, onCompare }) {
  if (!findings?.length) return null;

  return (
    <div className="space-y-2">
      {findings.map((finding, i) => {
        const kind = KIND[finding.kind] || KIND.similar;
        return (
          <div key={`${finding.existing.id}-${i}`} className={`rounded-xl border p-3 ${kind.ring}`}>
            <div className="flex items-start gap-2.5">
              <kind.Icon size={15} className={`mt-0.5 shrink-0 ${kind.tone}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className={`text-xs font-semibold ${kind.tone}`}>{kind.label}</span>
                  {finding.kind !== "exact" && (
                    <span className="text-[11px] text-base-500">
                      {Math.round(finding.score * 100)}% alike
                    </span>
                  )}
                  {finding.sameDestination && (
                    <span className="rounded bg-base-800 px-1.5 py-0.5 text-[10px] text-base-300">
                      already in this folder
                    </span>
                  )}
                </div>

                <p className="mt-1 truncate text-sm text-base-100" title={finding.existing.filename}>
                  {finding.existing.filename}
                </p>
                <p className="text-[11px] text-base-500">
                  {finding.existing.subjectPath || "not filed anywhere yet"}
                </p>

                {/* The reasoning. This is what makes disagreeing possible. */}
                <p className="mt-1.5 text-[11px] leading-relaxed text-base-400">{finding.why}</p>

                {(onInspect || onCompare) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {onInspect && (
                      <button
                        type="button"
                        className="btn-ghost btn-sm text-[11px]"
                        onClick={() => onInspect(finding.existing.id)}
                      >
                        <Eye size={12} /> View it
                      </button>
                    )}
                    {onCompare && (
                      <button
                        type="button"
                        className="btn-ghost btn-sm text-[11px]"
                        onClick={() => onCompare(finding.existing.id)}
                      >
                        <Scale size={12} /> Compare
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The heading above a set of findings, phrased for the strongest one. */
export function DuplicateSummaryLine({ findings }) {
  if (!findings?.length) return null;
  const exact = findings.filter((f) => f.kind === "exact").length;
  const versions = findings.filter((f) => f.kind === "version").length;

  return (
    <p className="flex items-start gap-2 text-sm text-base-200">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-700" aria-hidden="true" />
      <span>
        {exact > 0
          ? `This file is byte-for-byte identical to ${exact === 1 ? "a document" : `${exact} documents`} you already have.`
          : versions > 0
            ? "This looks like another version of a document you already have."
            : `${findings.length} similar document${findings.length === 1 ? "" : "s"} already exist.`}{" "}
        <span className="text-base-400">
          Filing it anyway is fine — Atlas just will not do it without telling you.
        </span>
      </span>
    </p>
  );
}
