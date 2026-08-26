import { useState, useEffect, useMemo } from "react";
import { GitCompare, Search, ArrowRight, X } from "lucide-react";
import { api } from "../services/apiClient";
import { Modal } from "./Modal";
import { useToast } from "../context/ToastContext";
import { formatBytes } from "../utils/format";

/**
 * Compare any two files on demand.
 *
 * The automatic detector only ever compares a bounded candidate pool (same
 * extension, most recent 300), so a user who suspects two specific files
 * are near-copies previously had no way to ask. This does, for any pair,
 * with no such filtering -- and it is read-only, so asking the question
 * never creates a duplicate group.
 *
 * OPENED FROM A DUPLICATE GROUP
 *
 * Both slots can be pre-filled (`initialFile` / `initialFileB`), in which
 * case the comparison runs on open: arriving here from "compare these two"
 * having already chosen the pair, only to be shown two filled boxes and asked
 * to press Compare, is a step that carries no decision.
 *
 * `candidates` offers a shortlist as one-click picks. It exists because the
 * search box is at its worst exactly where this modal is most useful --
 * duplicate copies tend to be called "Invoice.pdf" and "Invoice (2).pdf", so
 * searching by filename returns both and tells you nothing about which is
 * which.
 */
export function CompareFilesModal({
  open,
  onClose,
  initialFile = null,
  initialFileB = null,
  candidates = null,
}) {
  const [slotA, setSlotA] = useState(null);
  const [slotB, setSlotB] = useState(null);
  const [result, setResult] = useState(null);
  const [comparing, setComparing] = useState(false);
  const { push } = useToast();

  useEffect(() => {
    if (!open) return;
    setSlotA(initialFile || null);
    setSlotB(initialFileB || null);
    setResult(null);
    // Both sides already chosen -- answer the question instead of asking it
    // back. compareFiles is read-only, so running it unprompted changes
    // nothing and cannot surprise anyone.
    if (initialFile && initialFileB) runCompare(initialFile.id, initialFileB.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile?.id, initialFileB?.id]);

  async function runCompare(idA, idB) {
    setComparing(true);
    setResult(null);
    try {
      setResult(await api.post("/files/compare", { fileIdA: idA, fileIdB: idB }));
    } catch (err) {
      push(err.message, "error");
    } finally {
      setComparing(false);
    }
  }

  function compare() {
    if (!slotA || !slotB) return;
    runCompare(slotA.id, slotB.id);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Compare two files"
      width="max-w-3xl"
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
          <button
            className="btn-primary btn-sm"
            onClick={compare}
            disabled={!slotA || !slotB || comparing}
          >
            <GitCompare size={13} />
            {comparing ? "Comparing…" : "Compare"}
          </button>
        </>
      }
    >
      <p className="mb-4 text-xs text-base-400">
        Measures how much extracted text the two files share. Read-only — comparing never creates or
        changes a duplicate group.
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto_1fr] md:items-center">
        <FilePicker
          label="First file" selected={slotA} onSelect={setSlotA}
          excludeId={slotB?.id} candidates={candidates}
        />
        <div className="hidden justify-center text-base-500 md:flex">
          <ArrowRight size={16} />
        </div>
        <FilePicker
          label="Second file" selected={slotB} onSelect={setSlotB}
          excludeId={slotA?.id} candidates={candidates}
        />
      </div>

      {result && <ComparisonResult result={result} />}
    </Modal>
  );
}

function FilePicker({ label, selected, onSelect, excludeId, candidates = null }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const quickPicks = useMemo(
    () => (candidates || []).filter((f) => f.id !== excludeId),
    [candidates, excludeId]
  );

  useEffect(() => {
    if (selected || q.trim().length < 2) {
      setResults([]);
      return;
    }
    // Debounced so typing doesn't fire a request per keystroke.
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        setResults(await api.get("/files", { q: q.trim(), limit: 8 }));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [q, selected]);

  const visible = useMemo(
    () => results.filter((f) => f.id !== excludeId),
    [results, excludeId]
  );

  if (selected) {
    return (
      <div>
        <label className="label mb-1.5 block">{label}</label>
        <div className="flex items-start gap-2 rounded-xl border border-brand-500/30 bg-brand-500/10 px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-base-100">
              {selected.ai_short_title || selected.filename_current}
            </p>
            <p className="truncate font-mono text-xs text-base-500">{selected.current_path}</p>
          </div>
          <button
            className="btn-ghost btn-sm shrink-0"
            onClick={() => onSelect(null)}
            title="Choose a different file"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="label mb-1.5 block">{label}</label>
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-400" />
        <input
          className="input pl-9"
          placeholder="Search by filename…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* The other copies in this group, one click away. Shown above the
          search results because when this list exists it is almost always
          the answer -- searching for a file you are already looking at is
          the step this removes. */}
      {quickPicks.length > 0 && q.trim().length < 2 && (
        <div className="mt-1.5 max-h-44 overflow-y-auto rounded-xl border border-line bg-base-900">
          <p className="border-b border-line px-3 py-1.5 text-[10px] uppercase tracking-wider text-base-500">
            In this group
          </p>
          {quickPicks.map((f) => (
            <button
              key={f.id}
              className="block w-full border-b border-line px-3 py-2 text-left last:border-0 hover:bg-base-850"
              onClick={() => onSelect(f)}
            >
              <p className="truncate text-xs text-base-100">{f.ai_short_title || f.filename_current}</p>
              <p className="truncate font-mono text-[11px] text-base-500">{f.current_path}</p>
            </button>
          ))}
        </div>
      )}

      {q.trim().length >= 2 && (
        <div className="mt-1.5 max-h-44 overflow-y-auto rounded-xl border border-line bg-base-900">
          {searching ? (
            <p className="px-3 py-2 text-xs text-base-500">Searching…</p>
          ) : visible.length === 0 ? (
            <p className="px-3 py-2 text-xs text-base-500">No matching files.</p>
          ) : (
            visible.map((f) => (
              <button
                key={f.id}
                className="block w-full border-b border-line px-3 py-2 text-left last:border-0 hover:bg-base-850"
                onClick={() => { onSelect(f); setQ(""); }}
              >
                <p className="truncate text-xs text-base-100">{f.ai_short_title || f.filename_current}</p>
                <p className="truncate font-mono text-[11px] text-base-500">{f.current_path}</p>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const VERDICT_STYLES = {
  exact: { label: "Identical", className: "border-rose-500/30 bg-rose-500/10 text-rose-700" },
  probable: { label: "Probable duplicate", className: "border-amber-500/30 bg-amber-500/10 text-amber-700" },
  distinct: { label: "Distinct documents", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700" },
  not_comparable: { label: "Cannot compare", className: "border-line-strong bg-base-900 text-base-300" },
};

function ComparisonResult({ result }) {
  const style = VERDICT_STYLES[result.verdict] || VERDICT_STYLES.not_comparable;
  const percent = result.similarity === null ? null : result.similarity * 100;

  return (
    <div className={`mt-5 rounded-xl border px-4 py-3.5 ${style.className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold">{style.label}</p>
        {percent !== null && (
          <p className="text-2xl font-semibold tabular-nums">{percent.toFixed(1)}%</p>
        )}
      </div>

      {percent !== null && (
        <div className="mt-2.5">
          {/* The threshold marker matters: a bare percentage says nothing
              about whether the pipeline would act on it. */}
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-base-800">
            <div className="h-full rounded-full bg-current opacity-70" style={{ width: `${percent}%` }} />
            <div
              className="absolute top-0 h-full w-px bg-base-400"
              style={{ left: `${result.threshold * 100}%` }}
              title={`Probable-duplicate threshold: ${(result.threshold * 100).toFixed(0)}%`}
            />
          </div>
          <p className="mt-1 text-[11px] opacity-70">
            Threshold for flagging as a probable duplicate: {(result.threshold * 100).toFixed(0)}%
          </p>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed opacity-90">{result.explanation}</p>

      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-current/20 pt-3 text-[11px] opacity-80">
        {result.files.map((f) => (
          <div key={f.id} className="min-w-0">
            <p className="truncate font-medium">{f.filename}</p>
            <p className="truncate">
              {f.sizeBytes !== null ? formatBytes(f.sizeBytes) : "—"} · {f.wordCount.toLocaleString()} words
              {!f.hasComparableText && " · too little text"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
