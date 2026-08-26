import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

/**
 * @param {object} props
 * @param {number} props.offset
 * @param {number} props.limit
 * @param {number} [props.total]   - total matching rows, when the caller knows it
 * @param {number} [props.pageCount] - rows actually returned for THIS page.
 *   Lets the control behave correctly even without a total: a short page is
 *   proof there is no next one.
 * @param {(offset: number) => void} props.onChange
 * @param {number[]} [props.pageSizes] - offer a page-size selector
 * @param {(limit: number) => void} [props.onLimitChange]
 */
export function Pagination({ offset, limit, total, pageCount, onChange, pageSizes, onLimitChange }) {
  const page = Math.floor(offset / limit) + 1;
  const canPrev = offset > 0;

  // "Next" used to be unconditionally enabled whenever `total` was undefined,
  // which is the case on five of the pages that use this. Clicking it past the
  // end produced an empty list that -- before ErrorState and this fix -- read
  // as "no files found", i.e. the app told you your repository was empty
  // because you pressed Next once too often.
  //
  // pageCount closes that without needing a count query: a page that came back
  // shorter than `limit` is the last page, by definition.
  const canNext =
    total !== undefined
      ? offset + limit < total
      : pageCount === undefined
        ? true
        : pageCount >= limit;

  // Only knowable with a total. Without one the control still works -- it just
  // cannot claim a last page it has no way to locate, and saying "Page 3 of ?"
  // is more honest than inventing a denominator.
  const totalPages = total !== undefined ? Math.max(1, Math.ceil(total / limit)) : null;
  const lastOffset = totalPages !== null ? (totalPages - 1) * limit : null;

  // The upper bound is the last row that actually exists, not offset+limit.
  // On the final page of 9,398 rows the old arithmetic read "Showing
  // 9376–9400 of 9398" -- a range running past the total it printed beside it.
  const lastOnPage =
    total !== undefined
      ? Math.min(offset + limit, total)
      : pageCount !== undefined
        ? offset + pageCount
        : offset + limit;

  // Nothing at all to show: say so rather than "Showing 1–0".
  const showingLabel =
    lastOnPage <= offset
      ? "No results"
      : `Showing ${(offset + 1).toLocaleString()}–${lastOnPage.toLocaleString()}${
          total !== undefined ? ` of ${total.toLocaleString()}` : ""
        }`;

  return (
    <nav
      className="flex flex-col gap-3 border-t border-line px-4 py-3 text-sm text-base-400 sm:flex-row sm:items-center sm:justify-between"
      aria-label="Pagination"
    >
      <div className="flex items-center gap-3">
        <span aria-live="polite">{showingLabel}</span>
        {pageSizes && onLimitChange && (
          <label className="hidden items-center gap-1.5 text-xs text-base-500 md:flex">
            <span>Per page</span>
            <select
              className="rounded-md border border-line-strong bg-base-900/60 px-1.5 py-1 text-xs text-base-200"
              value={limit}
              onChange={(e) => onLimitChange(Number(e.target.value))}
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {totalPages !== null && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            disabled={!canPrev}
            onClick={() => onChange(0)}
            title="First page"
            aria-label="First page"
          >
            <ChevronsLeft size={14} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={!canPrev}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          <ChevronLeft size={14} aria-hidden="true" /> Prev
        </button>

        <span className="px-2 text-base-300">
          Page {page.toLocaleString()}
          {totalPages !== null && ` of ${totalPages.toLocaleString()}`}
        </span>

        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={!canNext}
          onClick={() => onChange(offset + limit)}
        >
          Next <ChevronRight size={14} aria-hidden="true" />
        </button>
        {totalPages !== null && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            disabled={!canNext}
            onClick={() => onChange(lastOffset)}
            title="Last page"
            aria-label="Last page"
          >
            <ChevronsRight size={14} aria-hidden="true" />
          </button>
        )}

        {totalPages !== null && totalPages > 1 && (
          <GoToPage page={page} totalPages={totalPages} limit={limit} onChange={onChange} />
        )}
      </div>
    </nav>
  );
}

/**
 * Jump straight to a page number.
 *
 * Kept as its own component with its own state for one specific reason: the
 * input must NOT drive the list while it is being typed. A controlled field
 * wired directly to `onChange` turns "42" into a request for page 4 the moment
 * the 4 lands, then another for page 42 -- two fetches, a visible flash of the
 * wrong page, and on a slow connection the results can arrive out of order and
 * leave you on page 4. So the value is local, and it is only committed on
 * submit or blur.
 *
 * Validation is deliberately forgiving about SHAPE and strict about RANGE.
 * Anything non-numeric is ignored rather than being rejected with an error
 * message -- there is nothing to explain, the field simply is not a page
 * number yet. Out-of-range is clamped rather than refused, because someone
 * typing 999 into a 42-page list means "the end", and taking them there is
 * what they wanted; refusing to move would be pedantry.
 */
function GoToPage({ page, totalPages, limit, onChange }) {
  const [value, setValue] = useState(String(page));

  // Follow the list when it moves for any other reason -- Next, a filter
  // change, a page-size change. Without this the box keeps showing the number
  // you last typed while the list is somewhere else entirely.
  useEffect(() => { setValue(String(page)); }, [page]);

  const commit = () => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      setValue(String(page));   // not a number: quietly put it back
      return;
    }
    const target = Math.min(Math.max(parsed, 1), totalPages);
    setValue(String(target));
    // Already there -- issuing the request anyway would be a wasted round trip
    // and a pointless list flicker.
    if (target === page) return;
    onChange((target - 1) * limit);
  };

  return (
    <form
      className="ml-1 flex items-center gap-1.5"
      onSubmit={(e) => { e.preventDefault(); commit(); }}
    >
      <label htmlFor="goto-page" className="hidden text-xs text-base-500 sm:inline">Go to</label>
      <input
        id="goto-page"
        type="text"
        inputMode="numeric"
        // A page number, not free text: the widest realistic value is five
        // digits, and a box sized for that reads as a number field.
        className="w-14 rounded-md border border-line-strong bg-base-900/60 px-2 py-1 text-center text-xs text-base-100 focus:border-brand-500/60 focus:outline-none"
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={commit}
        aria-label={`Page number, 1 to ${totalPages}`}
      />
      <button type="submit" className="btn-ghost btn-sm">Go</button>
    </form>
  );
}
