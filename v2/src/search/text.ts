// Normalization and light stemming for English, Arabic and French.
//
// The SAME functions run at index time and at query time, so the two can never
// drift. Display strings are never altered -- only the terms that go into, and
// are looked up in, the search index.
//
// Arabic:  NFKC (folds presentation forms and lam-alef ligatures that PDF
//          extraction produces), strip tashkeel/tatweel/Quranic marks, unify
//          alef variants, alef-maqsura->ya, ta-marbuta->ha, hamza carriers,
//          Persian kaf/ya, Arabic-Indic and Persian digits -> 0-9.
//          Stemming: Larkey's light10 (the standard for Arabic retrieval).
// French:  accents folded, elisions (l' d' qu' ... incl. U+2019) split off,
//          -aux -> -al, plural s/x.
// English: Harman's S-stemmer (plurals only). Everything else is left to prefix
//          matching at query time and to semantic search.

const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const LATIN_MARKS = /[̀-ͯ]/g;
const ELISION = /(^|[^\p{L}\p{N}])(?:l|d|j|m|n|s|t|c|qu|jusqu|lorsqu|puisqu)['’ʼ]/gu;
const NON_WORD = /[^\p{L}\p{N}]+/gu;
const ARABIC_LETTER = /[ء-ي]/;

const CHAR_MAP: Record<string, string> = {
  "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", // أ إ آ ٱ -> ا
  "ى": "ي", "ی": "ي", "ئ": "ي",                     // ى ی ئ -> ي
  "ة": "ه",                                                              // ة -> ه
  "ؤ": "و",                                                              // ؤ -> و
  "ک": "ك",                                                              // ک -> ك
  "œ": "oe", "æ": "ae", "ß": "ss",                                  // œ æ ß
};
const CHAR_RE = new RegExp(`[${Object.keys(CHAR_MAP).join("")}٠-٩۰-۹]`, "g");

/** Normalized text, words separated by single spaces. */
export function normalize(input: string): string {
  if (!input) return "";
  let s = input.normalize("NFKC").toLowerCase();
  s = s.replace(ARABIC_MARKS, "");
  s = s.replace(CHAR_RE, (c) => {
    const code = c.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
    if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
    return CHAR_MAP[c];
  });
  s = s.normalize("NFD").replace(LATIN_MARKS, "");
  s = s.replace(ELISION, "$1 ");
  return s.replace(NON_WORD, " ").trim();
}

export const tokens = (input: string): string[] => {
  const n = normalize(input);
  return n ? n.split(" ") : [];
};

const AR_ARTICLES = ["وال", "بال", "كال", "فال", "ال", "لل"]; // وال بال كال فال ال لل
// ها ان ات ون ين يه يه(ية after ة->ه) ه ي  -- light10 order, after our normalization
const AR_SUFFIXES = ["ها", "ان", "ات", "ون", "ين", "يه", "ه", "ي"];

export function stemArabic(w: string): string {
  if (w.length >= 4 && w[0] === "و") w = w.slice(1); // و "and" if 3+ remain
  for (const a of AR_ARTICLES) {
    if (w.startsWith(a) && w.length - a.length >= 2) { w = w.slice(a.length); break; }
  }
  for (const s of AR_SUFFIXES) {
    if (w.length - s.length >= 2 && w.endsWith(s)) w = w.slice(0, -s.length);
  }
  return w;
}

export function stemLatin(w: string): string {
  const n = w.length;
  if (n < 4) return w;
  if (w.endsWith("aux") && n > 4) return w.slice(0, -2) + "l"; // journaux -> journal
  if (w[n - 1] === "x") return w;
  if (w[n - 1] !== "s") return w;
  const p = w[n - 2];
  if (p === "u" || p === "s") return w;
  if (p === "e" && w[n - 3] === "i" && n > 4 && w[n - 4] !== "a" && w[n - 4] !== "e") return w.slice(0, -3) + "y"; // queries -> query
  if (p === "e" && (w[n - 3] === "i" || w[n - 3] === "a" || w[n - 3] === "o" || w[n - 3] === "e")) return w;
  return w.slice(0, -1);
}

export const stem = (w: string) => (ARABIC_LETTER.test(w) ? stemArabic(w) : stemLatin(w));

/** Terms as stored in the full-text index. */
export function indexText(input: string): string {
  const out: string[] = [];
  for (const t of tokens(input)) out.push(stem(t));
  return out.join(" ");
}

/**
 * An FTS5 MATCH expression for a user query: every term must match (AND),
 * terms of 3+ characters match as prefixes, quoted phrases stay phrases.
 * Returns null when nothing searchable remains.
 */
export function ftsQuery(input: string): string | null {
  const parts: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  let rest = input;
  for (const m of input.matchAll(phraseRe)) {
    const words = tokens(m[1]).map(stem);
    if (words.length) parts.push(`"${words.join(" ")}"`);
    rest = rest.replace(m[0], " ");
  }
  for (const t of tokens(rest)) {
    const s = stem(t);
    parts.push(s.length >= 3 ? `"${s}"*` : `"${s}"`);
  }
  return parts.length ? parts.join(" AND ") : null;
}

/** Terms for the trigram name index: normalized, unstemmed. */
export const nameText = (input: string) => normalize(input);

export function nameQuery(input: string): string | null {
  const terms = tokens(input).filter((t) => [...t].length >= 3);
  return terms.length ? terms.map((t) => `"${t}"`).join(" AND ") : null;
}

/** Share of letters that are Arabic, and a French/English guess for Latin text. */
export function detectLang(text: string): "ar" | "fr" | "en" | null {
  const sample = text.length > 20000 ? text.slice(0, 20000) : text;
  let arabic = 0, latin = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c >= 0x0621 && c <= 0x064a) arabic++;
    else if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0xc0 && c <= 0x17f)) latin++;
  }
  if (arabic + latin < 20) return null;
  if (arabic > latin * 0.5) return "ar";
  let fr = 0, en = 0;
  for (const w of tokens(sample.slice(0, 8000))) {
    if (FR_STOP.has(w)) fr++;
    else if (EN_STOP.has(w)) en++;
  }
  if (fr === 0 && en === 0) return null;
  return fr > en ? "fr" : "en";
}

const FR_STOP = new Set("le la les des du de et est une un pour dans sur au aux avec par qui que ne pas ce cette ces sont nous vous il elle ils leur".split(" "));
const EN_STOP = new Set("the and of to is in for with that this on are be by it as at from or an was will have has you your we our".split(" "));
