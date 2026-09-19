// Decoding the 8-bit strings inside an OLE property set.
//
// THE BUG THIS FIXES
//
// A VT_LPSTR in a property set is a CODE-PAGE string, not Latin-1. Which code
// page is declared inside the same property set, as PID_CODEPAGE
// ([MS-OLEPS] 2.18.2) -- and the previous implementation ignored it and
// decoded everything as latin1.
//
// For this repository's Arabic documents the declared page is 65001 (UTF-8),
// so every Arabic title came out as textbook mojibake: the four-character
// word "madkhal" is six UTF-8 bytes (d9 85 d8 af d8 ae d9 84), and read one
// byte at a time as Latin-1 those become the eight-character run that shows
// up on screen as "U+00D9 U+0085 U+00D8 U+00AF ...".
//
// Those strings then flowed into naming, so real documents were being
// proposed for renaming to garbage.
//
// Node is built with full ICU here, so TextDecoder handles the Windows code
// pages (1256 Arabic, 1255 Hebrew, 1252 Western, ...) directly; there is no
// need to ship mapping tables for decoding.
//
// NOTE ON THIS FILE'S STYLE: every non-ASCII value below is written as a code
// point, never as a literal character. Half of them are invisible control
// characters, and literals in this range do not survive editors, diffs and
// copy/paste reliably -- which is the same class of problem the file exists
// to fix.

// Code pages seen in Office property sets, mapped to WHATWG encoding labels.
// Anything not listed falls back to windows-1252, which is what an unlabelled
// Office file almost always is.
const CODE_PAGE_LABELS = {
  65001: "utf-8",
  1200: "utf-16le",
  1250: "windows-1250", // Central European
  1251: "windows-1251", // Cyrillic
  1252: "windows-1252", // Western European
  1253: "windows-1253", // Greek
  1254: "windows-1254", // Turkish
  1255: "windows-1255", // Hebrew
  1256: "windows-1256", // Arabic
  1257: "windows-1257", // Baltic
  1258: "windows-1258", // Vietnamese
  874: "windows-874", // Thai
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  10000: "macintosh",
  28591: "iso-8859-1",
  28592: "iso-8859-2",
  28596: "iso-8859-6", // Arabic
  28598: "iso-8859-8", // Hebrew
};

const DEFAULT_LABEL = "windows-1252";

/**
 * PID_CODEPAGE is stored as VT_I2 -- a SIGNED 16-bit int -- so 65001 does not
 * fit and is written as -535 (0xFDE9 read as signed). Reading it unsigned, or
 * forgetting to wrap, silently yields a nonsense page and sends every string
 * to the fallback decoder.
 */
function normalizeCodePage(raw) {
  if (!Number.isFinite(raw)) return null;
  return raw < 0 ? raw + 65536 : raw;
}

function labelForCodePage(codePage) {
  return CODE_PAGE_LABELS[codePage] || DEFAULT_LABEL;
}

// 0x80-0x9F is where CP1252 and Latin-1 disagree: Latin-1 has C1 control
// characters there, CP1252 has typographic punctuation (curly quotes, dashes,
// the euro sign). Which one a broken decoder used decides how the mojibake
// LOOKS, and therefore how it has to be reversed. Unicode code point -> the
// CP1252 byte it came from.
const CP1252_HIGH = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

// UTF-8 lead bytes for 2- and 3-byte sequences, as they appear once decoded
// one-byte-at-a-time.
const isUtf8Lead = (c) => (c >= 0xc2 && c <= 0xdf) || (c >= 0xe0 && c <= 0xef);
// A continuation byte is 0x80-0xBF. After a latin1 decode it stays in that
// range; after a CP1252 decode the 0x80-0x9F part became punctuation.
const isUtf8Continuation = (c) => (c >= 0x80 && c <= 0xbf) || c in CP1252_HIGH;

/**
 * Has this text been decoded with the wrong code page?
 *
 * The signature of UTF-8-read-as-a-single-byte-page is a UTF-8 lead byte
 * followed by a continuation byte, each rendered as its own character. Real
 * prose essentially never produces that pairing -- French "Theologie" with an
 * accent is a single high character between two ASCII ones, not a run.
 */
function looksLikeMojibake(text) {
  if (!text) return false;
  let pairs = 0;
  for (let i = 0; i < text.length - 1; i += 1) {
    if (isUtf8Lead(text.charCodeAt(i)) && isUtf8Continuation(text.charCodeAt(i + 1))) pairs += 1;
  }
  if (pairs === 0) return false;
  // Two or more pairs, or one in a very short string, is conclusive enough --
  // a single pair inside a long paragraph could plausibly be real text.
  return pairs >= 2 || text.length <= 24;
}

/** Characters back to the bytes they were mis-decoded from, or null if this
 *  text could not have come from a single-byte decode at all. */
function toOriginalBytes(text) {
  const bytes = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c <= 0xff) bytes[i] = c;
    else if (c in CP1252_HIGH) bytes[i] = CP1252_HIGH[c];
    else return null;
  }
  return bytes;
}

/**
 * Undo a wrong single-byte decode by mapping the characters back to bytes and
 * re-reading them as UTF-8.
 *
 * Handles BOTH flavours: a latin1 decode (which leaves raw C1 control
 * characters) and a CP1252 decode (which turns those same bytes into
 * typographic punctuation). The bug here came from latin1, but the same bytes
 * viewed through a CP1252 lens are what a browser shows, and text arriving
 * from other tools can be either.
 *
 * Only returns a result when the repair produces valid UTF-8 AND stops
 * looking like mojibake -- otherwise the original is returned untouched. A
 * repair that cannot be verified is not applied, because turning
 * odd-but-readable text into different unreadable text is strictly worse.
 */
function repairMojibake(text) {
  if (!looksLikeMojibake(text)) return text;
  try {
    const bytes = toOriginalBytes(text);
    if (!bytes) return text;
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (looksLikeMojibake(repaired)) return text;
    return repaired;
  } catch {
    return text; // not valid UTF-8 underneath -- leave it alone
  }
}

/**
 * @param {Buffer} bytes          raw string bytes from the property set
 * @param {number|null} codePage  value of PID_CODEPAGE, if the set declared one
 */
function decodeCodePageString(bytes, codePage) {
  const label = labelForCodePage(codePage);
  let text;
  try {
    text = new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    text = bytes.toString("latin1");
  }

  // Belt and braces. Plenty of real Office files declare 1252 while actually
  // holding UTF-8 -- the code page records what the authoring app believed,
  // not a guarantee -- so a verified repair still runs afterwards.
  return repairMojibake(text);
}

module.exports = {
  decodeCodePageString,
  repairMojibake,
  looksLikeMojibake,
  labelForCodePage,
  normalizeCodePage,
};
