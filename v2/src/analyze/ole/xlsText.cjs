// Text extraction from a legacy Excel 97-2003 (.xls) workbook, per [MS-XLS].
//
// The Workbook stream is a flat sequence of BIFF records: uint16 record id,
// uint16 payload length, payload. Almost all of a spreadsheet's text lives
// in one place -- the SST (Shared String Table), which every text cell
// references by index -- so extracting text is mostly "parse the SST", plus
// sheet names from BOUNDSHEET records and the handful of strings stored
// inline rather than shared.
//
// The genuinely awkward part is CONTINUE records. A record's payload is
// capped at 8224 bytes, so a large SST spills into following CONTINUE
// records -- and a single string can be cut in half across that boundary,
// with the continuation restarting with a fresh "is this 8-bit or 16-bit"
// flag byte. A parser that ignores this (many do) produces mojibake from
// the first large workbook it meets. The boundary set below is what handles
// it correctly.
const { decodeCp1252 } = require("./cp1252.cjs");

const RECORD_HEADER_SIZE = 4;

const REC = {
  BOF: 0x0809,
  EOF: 0x000a,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABEL: 0x0204, // inline string cell (BIFF8 uses SST instead, but these persist)
  RSTRING: 0x00d6,
  NOTE: 0x001c,
  TXO: 0x01b6, // text box / comment object
  HEADER: 0x0014,
  FOOTER: 0x0015,
};

class XlsParseError extends Error {}

/** Iterate the raw record stream. */
function* records(buffer) {
  let offset = 0;
  while (offset + RECORD_HEADER_SIZE <= buffer.length) {
    const id = buffer.readUInt16LE(offset);
    const length = buffer.readUInt16LE(offset + 2);
    const start = offset + RECORD_HEADER_SIZE;
    const end = start + length;
    if (end > buffer.length) break; // truncated tail -- stop cleanly
    yield { id, data: buffer.subarray(start, end), offset };
    offset = end;
  }
}

/**
 * Reads a BIFF8 XLUnicodeString from `buf` at `pos`.
 *
 * `boundaries` is the set of byte offsets in `buf` at which a CONTINUE
 * record began. When character data crosses one of those offsets, the
 * format inserts a fresh flag byte there and the encoding may flip between
 * 8-bit and 16-bit mid-string -- so the copy loop has to check for the
 * boundary on every character, not just at the start.
 */
function readUnicodeString(buf, pos, boundaries, lengthBytes = 2) {
  if (pos + lengthBytes + 1 > buf.length) return null;

  const cch = lengthBytes === 2 ? buf.readUInt16LE(pos) : buf.readUInt8(pos);
  let p = pos + lengthBytes;
  let flags = buf.readUInt8(p);
  p += 1;

  let highByte = Boolean(flags & 0x01);
  const extSt = Boolean(flags & 0x04);
  const richSt = Boolean(flags & 0x08);

  let cRun = 0;
  let cbExtRst = 0;
  if (richSt) {
    if (p + 2 > buf.length) return null;
    cRun = buf.readUInt16LE(p);
    p += 2;
  }
  if (extSt) {
    if (p + 4 > buf.length) return null;
    cbExtRst = buf.readUInt32LE(p);
    p += 4;
  }

  let out = "";
  for (let i = 0; i < cch; i += 1) {
    if (boundaries.has(p)) {
      // A CONTINUE record starts here: consume its flag byte, which may
      // switch the encoding for the remainder of this same string.
      if (p >= buf.length) break;
      flags = buf.readUInt8(p);
      p += 1;
      highByte = Boolean(flags & 0x01);
    }
    if (highByte) {
      if (p + 2 > buf.length) break;
      out += buf.subarray(p, p + 2).toString("utf16le");
      p += 2;
    } else {
      if (p + 1 > buf.length) break;
      out += decodeCp1252(buf.subarray(p, p + 1));
      p += 1;
    }
  }

  // Skip the trailing rich-text run and phonetic blocks, which are not text.
  p += cRun * 4;
  p += cbExtRst;

  return { value: out, next: p };
}

/**
 * Concatenate an SST record with its following CONTINUE records into one
 * buffer, remembering where each continuation began so readUnicodeString
 * can honour the mid-string flag bytes.
 */
function joinContinuations(sstData, continuations) {
  const parts = [sstData];
  const boundaries = new Set();
  let position = sstData.length;
  for (const chunk of continuations) {
    boundaries.add(position);
    parts.push(chunk);
    position += chunk.length;
  }
  return { buffer: Buffer.concat(parts), boundaries };
}

// Explicit \uXXXX escapes rather than literal control bytes, for the same
// readability reason as docText.js.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");

/**
 * Header/footer strings are stored with Excel's formatting codes inline:
 * "&CPrinted on &D&R&P" means centre-aligned "Printed on", the current
 * date, then right-aligned page number. The codes are layout directives,
 * not content -- leaving them in injects tokens like "cprinted" and "d"
 * into the text that feeds search and similarity scoring.
 */
function stripHeaderFooterCodes(text) {
  return text
    .replace(/&"[^"]*"/g, "") // font specification, e.g. &"Arial,Bold"
    .replace(/&\d+/g, "") // font size
    .replace(/&[A-Za-z]/g, "") // alignment/date/time/page/file/tab codes
    .replace(/\s+/g, " ")
    .trim();
}

function isPrintable(text) {
  // Reject strings that are mostly control characters -- a sign the offsets
  // drifted, in which case emitting the garbage is worse than emitting
  // nothing.
  if (!text) return false;
  const controlCount = (text.match(CONTROL_CHARS) || []).length;
  return controlCount / text.length < 0.2;
}

/**
 * @param {Buffer} workbook - the "Workbook" (BIFF8) or "Book" (BIFF5) stream
 * @returns {{text: string, sheetNames: string[], sharedStringCount: number}}
 */
function extractXlsText(workbook) {
  if (!workbook || workbook.length < RECORD_HEADER_SIZE) {
    throw new XlsParseError("Workbook stream is empty or truncated.");
  }

  const all = [...records(workbook)];
  if (all.length === 0) throw new XlsParseError("No BIFF records found in the workbook stream.");

  const sheetNames = [];
  const strings = [];
  const inlineText = [];

  for (let i = 0; i < all.length; i += 1) {
    const rec = all[i];

    if (rec.id === REC.BOUNDSHEET) {
      // name starts at offset 6: cch (uint8), then a standard flag byte.
      const parsed = readUnicodeString(rec.data, 6, new Set(), 1);
      if (parsed && parsed.value) sheetNames.push(parsed.value);
      continue;
    }

    if (rec.id === REC.SST) {
      const continuations = [];
      for (let j = i + 1; j < all.length && all[j].id === REC.CONTINUE; j += 1) {
        continuations.push(all[j].data);
      }
      const { buffer, boundaries } = joinContinuations(rec.data, continuations);

      // SST payload: cstTotal (uint32), cstUnique (uint32), then the strings.
      const cstUnique = buffer.length >= 8 ? buffer.readUInt32LE(4) : 0;
      let pos = 8;
      for (let n = 0; n < cstUnique; n += 1) {
        const parsed = readUnicodeString(buffer, pos, boundaries);
        if (!parsed || parsed.next <= pos) break; // no forward progress -- bail rather than loop
        if (parsed.value) strings.push(parsed.value);
        pos = parsed.next;
      }
      continue;
    }

    if (rec.id === REC.LABEL || rec.id === REC.RSTRING) {
      // row(2) col(2) ixfe(2) then the string
      const parsed = readUnicodeString(rec.data, 6, new Set());
      if (parsed && parsed.value) inlineText.push(parsed.value);
      continue;
    }

    if (rec.id === REC.HEADER || rec.id === REC.FOOTER) {
      if (rec.data.length > 3) {
        const parsed = readUnicodeString(rec.data, 0, new Set());
        const cleaned = parsed && parsed.value ? stripHeaderFooterCodes(parsed.value) : "";
        if (cleaned) inlineText.push(cleaned);
      }
    }
  }

  const pieces = [...sheetNames, ...strings, ...inlineText].filter(isPrintable);
  const text = pieces
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, sheetNames, sharedStringCount: strings.length };
}

module.exports = { extractXlsText, XlsParseError };
