import { CheckSquare, Square, ArrowUp, ArrowDown } from "lucide-react";
import { PageSpinner } from "./Spinner";
import { Pagination } from "./Pagination";
import { DocumentDateInline } from "./DocumentDate";
import { SearchSnippet } from "./SearchSnippet";
import { formatBytes } from "../utils/format";
import { setFileDragData } from "../lib/fileDrag";

/**
 * The Library's dense table view.
 *
 * WHY A THIRD VIEW RATHER THAN A DENSER LIST
 *
 * The list and the map are both built around the taxonomy: pick a branch, then
 * look at what is in it. That is the right shape right up until the archive is
 * too big to hold in your head, at which point the question changes from "what
 * is in Finance" to "what are the twenty biggest files I have" or "what came in
 * last week" — questions a tree cannot answer at all, because they cut across
 * it. So this view drops the tree entirely and spends the whole width on rows;
 * scope becomes one dropdown instead of two fifths of the screen.
 *
 * SORTING IS SERVER-SIDE, AND THAT IS THE WHOLE POINT
 *
 * Sorting the hundred rows currently loaded would be a lie at any size where
 * this view earns its place: "largest file" has to mean largest in the archive,
 * not largest on this page. Every header sends the sort to the API — against a
 * whitelist, see repositories/fileFilters.parseSort — and re-fetches from the
 * first page.
 */
// The responsive classes are part of the column definition rather than sprinkled
// on the cells, because the header is rendered from THIS list -- so a column can
// only ever be dropped from both halves at once, and cannot drift out of
// alignment with its own <td>. See .col-secondary / .col-tertiary in index.css.
const COLUMNS = [
  { key: "name", label: "Document", className: "" },
  { key: "date", label: "Date", className: "col-secondary w-36" },
  { key: "size", label: "Size", className: "col-tertiary w-24 text-right" },
  { key: "extension", label: "Type", className: "col-tertiary w-20" },
  { key: "imported", label: "Added", className: "col-tertiary w-32" },
];

export function LibraryTable({
  rows, loading, scopeLabel, scopeTotal, searching, sort, onSort,
  selectedFileIds, cursor, onToggle, onToggleAll, allOnPageSelected, canSelect,
  onRowClick, onOpenFile, onContextMenu,
  offset, limit, onOffsetChange, selectionBar, scopePicker,
}) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {scopePicker}
        <span className="text-xs text-base-400">
          {scopeTotal !== null
            ? `${scopeTotal.toLocaleString()} document${scopeTotal === 1 ? "" : "s"} in ${scopeLabel}`
            : searching
              // Counting a ranked search means running the expensive half twice
              // and throwing the rows away, which the API refuses outright. Say
              // which page you are on rather than inventing a total.
              ? `showing ${rows.length} result${rows.length === 1 ? "" : "s"} for ${scopeLabel}`
              : scopeLabel}
        </span>
      </div>

      {selectionBar}

      {loading ? (
        <PageSpinner />
      ) : !rows.length ? (
        <div className="glass-card p-10 text-center text-sm text-base-400">Nothing to show here.</div>
      ) : (
        <>
          <div className="table-shell glass-card overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wider text-base-400">
                  {canSelect && (
                    <th className="w-10 px-3 py-2.5">
                      <button onClick={onToggleAll} title="Select everything on this page (a)">
                        {allOnPageSelected
                          ? <CheckSquare size={14} className="text-brand-600" />
                          : <Square size={14} />}
                      </button>
                    </th>
                  )}
                  {COLUMNS.map((col) => {
                    const active = sort.sortBy === col.key;
                    return (
                      <th key={col.key} className={`px-3 py-2.5 font-medium ${col.className}`}>
                        {/* A relevance-ranked search has no meaningful column
                            order, so the headers stop offering one rather than
                            silently discarding the ranking. */}
                        {searching ? (
                          col.label
                        ) : (
                          <button
                            className={"inline-flex items-center gap-1 hover:text-base-200 " + (active ? "text-brand-700" : "")}
                            onClick={() => onSort(col.key)}
                          >
                            {col.label}
                            {active && (sort.sortDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                          </button>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((f, index) => {
                  const isSelected = selectedFileIds.has(f.id);
                  const isCursor = index === cursor;
                  return (
                    <tr
                      key={f.id}
                      // SINGLE CLICK SELECTS. DOUBLE CLICK OPENS.
                      //
                      // The same rule the card list uses, and it is here for
                      // the same reason it is there: single click used to open
                      // the detail modal, which is exactly why double-click
                      // never worked in this view. The modal mounted over the
                      // row after the first click, so the second click landed
                      // on the modal and the dblclick event never reached the
                      // row at all -- the row could not be double-clicked
                      // because the first click had already covered it up.
                      //
                      // That was fixed in LibraryFileRow and not here, so
                      // "double click opens the file" was true in the card
                      // view and silently false in the table. Details are
                      // still one right-click away, which is where every other
                      // per-row action in this app already lives.
                      onClick={(e) => onRowClick?.(index, f, e)}
                      onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenFile?.(f); }}
                      onContextMenu={(e) => onContextMenu?.(e, f, index)}
                      /* Draggable for the same reason the card rows are: this
                         is the same inventory in a denser shape, and a gesture
                         that works in one view and not the other is a gesture
                         nobody trusts in either. Carries the selection when
                         the dragged row is part of it. See lib/fileDrag. */
                      draggable
                      onDragStart={(e) => {
                        const carry = isSelected ? rows.filter((r) => selectedFileIds.has(r.id)) : [f];
                        setFileDragData(e, carry.length ? carry : [f]);
                      }}
                      className={
                        "cursor-pointer border-b border-row-divider last:border-0 " +
                        (isSelected
                          ? "bg-brand-500/10"
                          : isCursor
                            ? "bg-base-850 ring-1 ring-inset ring-line-strong"
                            : "table-row-hover")
                      }
                    >
                      {canSelect && (
                        <td className="px-3 py-2">
                          <button
                            onClick={(e) => { e.stopPropagation(); onToggle(index, { shiftKey: e.shiftKey }); }}
                            title={isSelected ? "Deselect" : "Select (shift-click for a range)"}
                            aria-pressed={isSelected}
                            className="text-base-500 hover:text-brand-700"
                          >
                            {isSelected
                              ? <CheckSquare size={15} className="text-brand-600" />
                              : <Square size={15} />}
                          </button>
                        </td>
                      )}
                      <td className="max-w-0 px-3 py-2">
                        {/* dir="auto" because this archive is French and Arabic;
                            a right-to-left title rendered left-to-right is
                            unreadable, not merely untidy. */}
                        <p dir="auto" className="truncate font-medium text-base-100">
                          {f.ai_short_title || f.display_name || f.filename_current}
                        </p>
                        <p dir="auto" className="truncate text-xs text-base-500">
                          {f.subject_name
                            ? <span className="text-base-400">{f.subject_name} · </span>
                            : <span className="text-amber-700/80">unfiled · </span>}
                          {f.current_path || f.filename_current}
                        </p>
                        <SearchSnippet snippet={f.snippet} />
                        {/* Date and size, which lose their columns on a phone.
                            Type and Added do not reappear here: the extension
                            is already visible at the end of the path above it,
                            and import date is a desktop sorting aid rather than
                            something read off a row. */}
                        <div className="cell-subline">
                          <DocumentDateInline date={f.document_date} source={f.document_date_source} />
                          <span className="tabular-nums">{formatBytes(f.size_bytes)}</span>
                        </div>
                      </td>
                      <td className="col-secondary px-3 py-2 text-xs">
                        <DocumentDateInline date={f.document_date} source={f.document_date_source} />
                      </td>
                      <td className="col-tertiary px-3 py-2 text-right text-xs tabular-nums text-base-400">
                        {formatBytes(f.size_bytes)}
                      </td>
                      <td className="col-tertiary px-3 py-2 text-xs text-base-400">
                        {f.extension ? `.${String(f.extension).toLowerCase()}` : "—"}
                      </td>
                      <td className="col-tertiary px-3 py-2 text-xs text-base-500">
                        {f.imported_at ? new Date(f.imported_at).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-2">
            <Pagination offset={offset} limit={limit} pageCount={rows.length} onChange={onOffsetChange} />
          </div>
        </>
      )}
    </div>
  );
}
