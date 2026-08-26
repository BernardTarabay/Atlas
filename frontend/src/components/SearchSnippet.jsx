import { Quote } from "lucide-react";

/**
 * The matching excerpt from inside a document, with the search term marked.
 *
 * The snippet arrives from Postgres `ts_headline` wrapped in <mark> tags --
 * but ts_headline does NOT escape the document's own text, so rendering it
 * with dangerouslySetInnerHTML would execute whatever HTML happened to be
 * inside somebody's file. Splitting on the tags and letting React build the
 * nodes keeps the highlight and escapes the content, which is exactly what
 * React's default behaviour is for.
 *
 * Shared by the Files page and the Subjects page so a search result looks
 * the same wherever it is shown.
 */
export function SearchSnippet({ snippet, className = "" }) {
  if (!snippet) return null;

  const parts = String(snippet).split(/<\/?mark>/);
  return (
    <p className={`mt-1 line-clamp-2 text-xs leading-relaxed text-base-400 ${className}`}>
      <Quote size={10} className="mr-1 inline shrink-0 text-base-600" />
      {parts.map((part, i) =>
        // Odd indices are what sat between the tags -- the matched term.
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-brand-500/25 px-0.5 text-brand-700">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </p>
  );
}

/**
 * Why a result matched. Worth showing: "this matched inside the document" and
 * "this matched its filename" are very different levels of confidence for the
 * person reading.
 *
 * "by meaning" is the one that most needs saying. A file can now come back
 * without sharing a single word with what was typed -- "kid blowing out
 * candles" reaching a description that reads "a child at a party with a cake"
 * -- and a result with no visible connection to the query reads as a bug
 * unless the search admits what it did.
 */
export function MatchReason({ file }) {
  // The hybrid search reports which signals fired, per row. The older
  // boolean columns are still populated by the content search underneath it,
  // so both shapes are handled rather than one replacing the other.
  const semantic = file.matched_by?.includes("semantic");
  const reasons = [
    semantic && "by meaning",
    file.matched_by?.includes("description") && "in its description",
    file.matched_content && "in content",
    file.matched_filename && "in name",
    file.matched_ai && "in AI title",
  ].filter(Boolean);

  if (reasons.length === 0) return null;
  return (
    <span className="text-[11px] text-base-500">
      matched {reasons.join(" · ")}
      {semantic && typeof file.similarity === "number" && (
        <span className="ml-1 text-base-600" title="How closely the description matches what you described, 0 to 1.">
          ({file.similarity.toFixed(2)})
        </span>
      )}
    </span>
  );
}
