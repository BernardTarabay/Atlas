/**
 * Text with every occurrence of what you typed marked, find-in-page style.
 *
 * WHY THIS EXISTS SEPARATELY FROM SearchSnippet
 *
 * SearchSnippet renders a snippet Postgres already marked up with <mark> tags
 * (ts_headline decided what matched, inside the document's body). This one is
 * the opposite situation: the text is a plain string we already have -- a
 * filename, an email subject -- and the matching has to happen here, in the
 * browser, against exactly what the person typed.
 *
 * Both exist because the two answer different questions. "Where does this
 * phrase appear inside the file?" is the server's to answer. "Which part of
 * this name is the bit I typed?" is not worth a round trip and has to survive
 * the user typing another character 40ms later.
 *
 * WHY THE QUERY IS ESCAPED
 *
 * It goes into a RegExp, and it is user input. A search for "report (2024)"
 * or "c++" would otherwise throw an unbalanced-parenthesis SyntaxError and
 * take the whole list down with it -- the search box is the one input in this
 * app guaranteed to receive punctuation.
 */

/** Escape every character RegExp treats as syntax. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does this text contain the query? The same test the highlighter uses, so a
 * row can never be counted as a match and then render without a mark.
 */
export function hasMatch(text, query) {
  if (!query || query.length < 1 || !text) return false;
  return String(text).toLowerCase().includes(String(query).toLowerCase());
}

/**
 * @param {string} text     what to render
 * @param {string} query    what to mark inside it, case-insensitively
 * @param {boolean} active  this is the match the user has navigated TO --
 *                          rendered hotter, exactly like a browser's find bar
 *                          distinguishes the current hit from the rest.
 */
export function HighlightedText({ text, query, active = false, className = "" }) {
  const value = text == null ? "" : String(text);
  const needle = (query || "").trim();

  if (!needle || !value) return <span className={className}>{value}</span>;

  // `split` with a capturing group keeps the delimiters, so the odd indices
  // are the matches and the even ones are the text between them -- no manual
  // index arithmetic, and no chance of dropping a character.
  const parts = value.split(new RegExp(`(${escapeRegExp(needle)})`, "gi"));
  if (parts.length === 1) return <span className={className}>{value}</span>;

  return (
    <span className={className}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className={active ? "search-hit-active" : "search-hit"}>
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </span>
  );
}
