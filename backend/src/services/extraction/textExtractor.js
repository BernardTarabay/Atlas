// Plain-text and text-markup extraction (spec §7/§8).
//
// WHY THIS EXISTS
//
// docs/07-supported-formats.md finalized the format list after investigating
// what could reliably be extracted from each, and plain text was never
// considered -- not listed as supported, not listed as a limitation. So a
// .txt fell through to the "anything else" row and was ingested as an
// unsupported binary: hashed, browsable, and holding zero characters of text.
//
// That is the worst possible answer for the one format that needs no parsing
// at all, because the bytes ARE the text. And it cascades: no text means no
// classification, no document date read from content, no rename proposal, a
// facts-only description, and nothing to search on. A 3 KB CV in this
// repository was invisible to every one of those.
//
// Detection reaches here by extension, not signature, and that is correct
// rather than a compromise: plain text has no magic bytes to detect. It also
// means the subtype list below has to be an ALLOWLIST. Claiming every
// signature-less file as text would decode unknown binaries into mojibake and
// feed it to the classifier, which is the failure mode fileSignature.js's
// "content wins over a lying extension" rule exists to prevent -- an
// extension is only trusted here for extensions that genuinely denote text.
const { stripXmlToText } = require("./ooxmlTextUtil");
const { decodeCp1252 } = require("./ole/cp1252");

// Text as the file stores it.
const PLAIN_SUBTYPES = new Set([
  "txt", "text", "log",
  "md", "markdown",
  "csv", "tsv",
  "json", "ndjson",
  "yaml", "yml",
  "ini", "cfg", "conf",
]);

// Text wrapped in tags. Stored as prose rather than markup: an <html> file
// indexed with its tags matches searches for "div" and dilutes every real
// term in it. stripXmlToText is the same helper docx/pptx use.
const MARKUP_SUBTYPES = new Set(["html", "htm", "xml", "xhtml"]);

/**
 * Upper bound on stored text.
 *
 * extractTextProcessor already refuses files over env.extraction.maxBytes
 * before opening them, so this is not the size guard -- it is the guard
 * against a file that is small enough to open and still absurd to store, e.g.
 * a 200 MB application log that is entirely within the byte limit and would
 * otherwise land in one Postgres row and one search vector. Truncation is
 * recorded in metadata so a short answer is never mistaken for a short file.
 */
const MAX_TEXT_CHARS = 2_000_000;

// Explicit escape rather than a literal control byte in the source -- the same
// convention, for the same reason, that ole/docText.js and ole/xlsText.js state.
const NUL = "\u0000";

/**
 * Decode bytes to a string, in the order that is right for THIS corpus.
 *
 * The archive is French and Arabic (docs/13 §13.1). Arabic text is
 * essentially always UTF-8; French text produced by older Windows tooling is
 * often CP1252. So: an explicit BOM wins, then UTF-8 is tried and VERIFIED,
 * and only a failed verification falls back to CP1252.
 *
 * The verification matters. Node's utf8 decoder never throws -- it
 * substitutes U+FFFD for invalid sequences and returns a string that looks
 * fine until you read it. Testing for that replacement character is what
 * separates "this really was UTF-8" from "this was CP1252 and is now
 * mojibake", and mojibake here would flow into the search vector, the
 * classifier and the AI description as though it were the document's words.
 *
 * @param {Buffer} buffer
 * @returns {{text: string, encoding: string}}
 */
function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString("utf8"), encoding: "utf-8-bom" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString("utf16le"), encoding: "utf-16le" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // Node has no utf16be decoder. Swapping the byte pairs on a COPY (swap16
    // mutates in place) turns it into the little-endian form it can read.
    const swapped = Buffer.from(buffer.subarray(2));
    if (swapped.length % 2 === 0) swapped.swap16();
    return { text: swapped.toString("utf16le"), encoding: "utf-16be" };
  }

  const asUtf8 = buffer.toString("utf8");
  if (!asUtf8.includes("�")) return { text: asUtf8, encoding: "utf-8" };

  return { text: decodeCp1252(buffer), encoding: "cp1252" };
}

/**
 * Does this decoded string look like prose rather than a mislabelled binary?
 *
 * Run on the DECODED text, never the raw bytes: UTF-16 is full of legitimate
 * NUL bytes, so a byte-level NUL check would reject every UTF-16 document.
 * After decoding, a NUL is a real signal that this was never text.
 *
 * Control characters other than tab/newline/carriage-return are counted
 * rather than rejected outright, because a stray form feed in an otherwise
 * fine document should not lose the document.
 */
function looksLikeText(text) {
  if (text.length === 0) return true; // a genuinely empty file is still a text file
  if (text.includes(NUL)) return false;

  const sample = text.slice(0, 4096);
  let control = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) control += 1;
  }
  return control / sample.length < 0.05;
}

/**
 * @param {Buffer} buffer
 * @param {string} subtype - the detected subtype, i.e. the lowercased extension
 * @returns {{extractor:string, extractorVersion:string|null, metadata:object, text:string}}
 */
async function extract(buffer, subtype = "txt") {
  const isMarkup = MARKUP_SUBTYPES.has(subtype);
  const { text: decoded, encoding } = decodeText(buffer);

  if (!looksLikeText(decoded)) {
    return {
      extractor: "unsupported",
      extractorVersion: null,
      metadata: {
        reason:
          `File has a "${subtype}" extension but its contents are not text ` +
          `(decoded as ${encoding} and contains binary data). Not extracted, ` +
          "so binary bytes are never indexed as though they were words.",
      },
      text: "",
    };
  }

  const body = isMarkup ? stripXmlToText(decoded) : decoded;
  // Normalise line endings so a CRLF file and an LF file with identical
  // content produce identical text -- duplicate and version detection compare
  // this string.
  const normalised = body.replace(/\r\n?/g, "\n");
  const truncated = normalised.length > MAX_TEXT_CHARS;

  return {
    extractor: isMarkup ? "text-markup" : "text",
    extractorVersion: "1",
    metadata: {
      encoding,
      subtype,
      lineCount: normalised.length ? normalised.split("\n").length : 0,
      characterCount: normalised.length,
      truncated,
    },
    text: truncated ? normalised.slice(0, MAX_TEXT_CHARS) : normalised,
  };
}

module.exports = { extract, PLAIN_SUBTYPES, MARKUP_SUBTYPES, decodeText, looksLikeText };
