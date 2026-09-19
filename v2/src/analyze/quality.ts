// Is extracted text real text? Ported from V1's textQuality.js (unit-tested there).
// A scan does not extract to nothing -- it extracts to a little garbage, and
// garbage must never become a filename or a classification.

export type Verdict = "ok" | "empty" | "too_short" | "no_text_layer" | "gibberish";

const MIN_TOKENS = 5;
const MIN_LETTER_RATIO = 0.35;
const MAX_SINGLE_CHAR_TOKEN_RATIO = 0.55;
const MIN_LATIN_VOWEL_RATIO = 0.12;
const MAX_REPLACEMENT_RATIO = 0.03;
const NO_TEXT_LAYER_BYTES_PER_CHAR = 20000;

function latinDominant(text: string): boolean {
  let latin = 0, other = 0;
  const n = Math.min(text.length, 20000);
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) latin++;
    else if (c >= 0x0370 && c !== 0xfffd) other++;
  }
  return latin > other;
}

export function assessText(text: string, sizeBytes = 0): Verdict {
  const t = (text || "").trim();
  if (!t) return "empty";
  if (sizeBytes > 0 && sizeBytes / t.length > NO_TEXT_LAYER_BYTES_PER_CHAR) return "no_text_layer";
  const sample = t.length > 200000 ? t.slice(0, 200000) : t;
  const letters = (sample.match(/\p{L}/gu) || []).length;
  if ((sample.match(/�/g) || []).length / sample.length > MAX_REPLACEMENT_RATIO) return "gibberish";
  if (letters / sample.length < MIN_LETTER_RATIO) return "gibberish";
  const words = sample.split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean);
  if (words.length < MIN_TOKENS) return "too_short";
  if (words.filter((w) => w.length === 1).length / words.length > MAX_SINGLE_CHAR_TOKEN_RATIO) return "gibberish";
  if (latinDominant(sample)) {
    const vowels = (sample.match(/[aeiouyàâäéèêëïîôöùûüœæ]/gi) || []).length;
    if (letters && vowels / letters < MIN_LATIN_VOWEL_RATIO) return "gibberish";
  }
  return "ok";
}
