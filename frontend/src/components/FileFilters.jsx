import { useState, useMemo } from "react";
import { SlidersHorizontal, X, CalendarRange, HardDrive, FolderTree, FileType2, Stamp } from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";

/**
 * The filter bar shared by the Files page and the Subjects page (task #44).
 *
 * WHY ONE COMPONENT
 *
 * The same four filters apply in both places and have to mean the same thing
 * in both, because they hit the same predicates on the backend. Two
 * hand-rolled bars would drift -- one would normalise ".PDF", the other
 * wouldn't, and the two pages would disagree about how many PDFs exist.
 *
 * WHY THE OPTIONS ARE FETCHED, NOT HARDCODED
 *
 * The type list comes from what is actually in the repository, with counts.
 * A hardcoded list is a guess at what a French/Arabic church archive contains
 * -- it would offer .pptx and miss .swf, of which there are two thousand.
 *
 * "LOCATION" HERE MEANS STORAGE LOCATION AND FOLDER PATH, not EXIF GPS. See
 * the note on fileService.search for why.
 */
export const EMPTY_FILTERS = Object.freeze({
  ext: [],
  dateFrom: "",
  dateTo: "",
  subjectId: "",
  documentTypeId: "",
  storageLocationId: "",
  pathPrefix: "",
});

/** Filter state -> query params, dropping everything unset. */
export function filtersToParams(filters) {
  if (!filters) return {};
  return {
    ext: filters.ext?.length ? filters.ext.join(",") : undefined,
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
    subjectId: filters.subjectId || undefined,
    documentTypeId: filters.documentTypeId || undefined,
    storageLocationId: filters.storageLocationId || undefined,
    pathPrefix: filters.pathPrefix || undefined,
  };
}

export function countActiveFilters(filters) {
  if (!filters) return 0;
  return (
    (filters.ext?.length ? 1 : 0) +
    (filters.dateFrom || filters.dateTo ? 1 : 0) +
    (filters.subjectId ? 1 : 0) +
    (filters.documentTypeId ? 1 : 0) +
    (filters.storageLocationId ? 1 : 0) +
    (filters.pathPrefix ? 1 : 0)
  );
}

/** Files with no extension are a real bucket -- the backend's sentinel for them. */
const NO_EXTENSION = "none";

export function FileFilters({
  value,
  onChange,
  showSubject = true,
  subjects = null,
  // Off on the Document Types page for the same reason showSubject is off on
  // the Subjects page: that page's list IS the picker, and a dropdown beside
  // it would be a second, quieter way to disagree with what is selected.
  showDocumentType = true,
  documentTypes = null,
  resultCount = null,
  totalCount = null,
}) {
  const [open, setOpen] = useState(false);
  const { data: options } = useApiData(() => api.get("/files/filter-options"), []);

  const active = countActiveFilters(value);
  const extensions = options?.extensions || [];
  const locations = options?.locations || [];
  const undated = options?.dateRange?.undated || 0;
  const hasDateFilter = Boolean(value.dateFrom || value.dateTo);

  // One location is the normal deployment here; a picker with a single
  // option is a control that cannot change anything.
  const showLocationPicker = locations.length > 1;

  const set = (patch) => onChange({ ...value, ...patch });

  function toggleExt(ext) {
    const next = value.ext.includes(ext)
      ? value.ext.filter((e) => e !== ext)
      : [...value.ext, ext];
    set({ ext: next });
  }

  const subjectName = useMemo(() => {
    if (!value.subjectId || !subjects) return null;
    const s = subjects.find((x) => x.id === value.subjectId);
    return s ? s.materialized_path || s.name : null;
  }, [value.subjectId, subjects]);

  const documentTypeName = useMemo(() => {
    if (!value.documentTypeId || !documentTypes) return null;
    return documentTypes.find((d) => d.id === value.documentTypeId)?.name || null;
  }, [value.documentTypeId, documentTypes]);

  // Keyed on `options` rather than the derived `locations` array, which is a
  // fresh [] on every render while the fetch is in flight and would defeat
  // the memo entirely.
  const locationName = useMemo(
    () => (options?.locations || []).find((l) => l.id === value.storageLocationId)?.name || null,
    [options, value.storageLocationId]
  );

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={active > 0 ? "btn-secondary btn-sm" : "btn-ghost btn-sm"}
          onClick={() => setOpen((o) => !o)}
        >
          <SlidersHorizontal size={13} /> Filters
          {active > 0 && (
            <span className="ml-1 rounded-full bg-brand-500/90 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
              {active}
            </span>
          )}
        </button>

        {/* Active filters stay visible when the panel is closed. A filter you
            cannot see is a filter you forget is on, and then the empty result
            it produces looks like an empty repository. */}
        {value.ext.length > 0 && (
          <Chip icon={FileType2} onClear={() => set({ ext: [] })}>
            {value.ext.map((e) => (e === NO_EXTENSION ? "no extension" : `.${e}`)).join(", ")}
          </Chip>
        )}
        {hasDateFilter && (
          <Chip icon={CalendarRange} onClear={() => set({ dateFrom: "", dateTo: "" })}>
            {value.dateFrom || "…"} → {value.dateTo || "…"}
          </Chip>
        )}
        {subjectName && (
          <Chip icon={FolderTree} onClear={() => set({ subjectId: "" })}>{subjectName}</Chip>
        )}
        {documentTypeName && (
          <Chip icon={Stamp} onClear={() => set({ documentTypeId: "" })}>{documentTypeName}</Chip>
        )}
        {locationName && (
          <Chip icon={HardDrive} onClear={() => set({ storageLocationId: "" })}>{locationName}</Chip>
        )}
        {value.pathPrefix && (
          <Chip icon={FolderTree} onClear={() => set({ pathPrefix: "" })}>
            path: {value.pathPrefix}
          </Chip>
        )}

        {active > 0 && (
          <button className="btn-ghost btn-sm text-base-400" onClick={() => onChange({ ...EMPTY_FILTERS })}>
            Clear all
          </button>
        )}

        {/* The match count is what makes narrowing legible: a screen of 25
            looks the same whether the filter matched 25 or 25,000. */}
        {resultCount !== null && (
          <span className="ml-auto text-xs tabular-nums text-base-400">
            {resultCount.toLocaleString()}
            {totalCount !== null && totalCount !== resultCount && (
              <span className="text-base-500"> of {totalCount.toLocaleString()}</span>
            )}{" "}
            file{resultCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-4 rounded-2xl border border-line bg-base-900 p-4">
          <div>
            <p className="label mb-2">File type</p>
            {extensions.length === 0 ? (
              <p className="text-xs text-base-500">Nothing indexed yet.</p>
            ) : (
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                {extensions.map((e) => {
                  const on = value.ext.includes(e.ext);
                  return (
                    <button
                      key={e.ext}
                      onClick={() => toggleExt(e.ext)}
                      className={
                        "rounded-full border px-2.5 py-1 text-xs transition-colors " +
                        (on
                          ? "border-brand-500/40 bg-brand-500/15 text-brand-700"
                          : "border-line-strong bg-base-900 text-base-300 hover:border-line-strong")
                      }
                    >
                      {e.ext === NO_EXTENSION ? "no extension" : `.${e.ext}`}
                      <span className="ml-1.5 tabular-nums text-base-500">{e.count.toLocaleString()}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label mb-1.5 block">Document date from</label>
              <input
                type="date" className="input"
                value={value.dateFrom}
                onChange={(e) => set({ dateFrom: e.target.value })}
              />
            </div>
            <div>
              <label className="label mb-1.5 block">…to</label>
              <input
                type="date" className="input"
                value={value.dateTo}
                onChange={(e) => set({ dateTo: e.target.value })}
              />
            </div>
          </div>

          {/* The surprising part of any date filter, said before it surprises
              anyone: over half this repository has no known document date,
              and nothing undated can satisfy a range. */}
          <p className="text-[11px] text-base-500">
            This is the date the document is <em>from</em> — read out of the file where possible, not the
            day it was copied onto the disk.
            {undated > 0 && hasDateFilter && (
              <span className="text-amber-700">
                {" "}{undated.toLocaleString()} file{undated === 1 ? " has" : "s have"} no known date and
                {undated === 1 ? " is" : " are"} hidden while a date range is set.
              </span>
            )}
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {showSubject && (
              <div>
                <label className="label mb-1.5 block">Subject</label>
                <select
                  className="input"
                  value={value.subjectId}
                  onChange={(e) => set({ subjectId: e.target.value })}
                >
                  <option value="">— Any —</option>
                  {(subjects || []).map((s) => (
                    <option key={s.id} value={s.id}>{s.materialized_path || s.name}</option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-base-500">Includes everything filed underneath it.</p>
              </div>
            )}

            {showDocumentType && (
              <div>
                <label className="label mb-1.5 block">Document type</label>
                <select
                  className="input"
                  value={value.documentTypeId}
                  onChange={(e) => set({ documentTypeId: e.target.value })}
                >
                  <option value="">— Any —</option>
                  {(documentTypes || []).map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
                {/* Said here rather than discovered later: most files have no
                    type yet, so this filter narrows hard. It is not broken. */}
                <p className="mt-1 text-[11px] text-base-500">
                  What kind of document it is, independent of where it is filed.
                </p>
              </div>
            )}

            {showLocationPicker && (
              <div>
                <label className="label mb-1.5 block">Storage location</label>
                <select
                  className="input"
                  value={value.storageLocationId}
                  onChange={(e) => set({ storageLocationId: e.target.value })}
                >
                  <option value="">— Any —</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="label mb-1.5 block">Folder path starts with</label>
              <input
                className="input"
                placeholder="e.g. Archives/2019"
                value={value.pathPrefix}
                onChange={(e) => set({ pathPrefix: e.target.value })}
              />
              <p className="mt-1 text-[11px] text-base-500">
                Relative to the storage location's root folder.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ icon: Icon, children, onClear }) {
  return (
    <span className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-brand-500/30 bg-brand-500/10 px-2.5 py-1 text-xs text-brand-700">
      <Icon size={11} className="shrink-0" />
      <span className="truncate">{children}</span>
      <button className="shrink-0 text-brand-700/70 hover:text-brand-700" onClick={onClear} title="Clear this filter">
        <X size={11} />
      </button>
    </span>
  );
}
