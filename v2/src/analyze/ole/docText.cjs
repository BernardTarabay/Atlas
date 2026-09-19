// Text extraction from a legacy Word 97-2003 (.doc) binary document,
// per [MS-DOC].
//
// The naive approach -- scanning the WordDocument stream for runs of
// printable characters -- is what most quick "doc to text" hacks do, and it
// is wrong in a way that matters: the stream also contains deleted text
// still sitting in the file, field codes, and formatting structures, so it
// produces text the document does not actually say. Reading the piece table
// is the difference between "what this document contains" and "what bytes
// happen to be in the file", and this system feeds extracted text into
// classification, naming and duplicate detection, all of which get worse
// when fed phantom content.
//
// The real structure:
//   1. The FIB (File Information Block) at the head of the WordDocument
//      stream says which of "0Table"/"1Table" is the active table stream,
//      and where the Clx lives inside it.
//   2. The Clx contains a PlcPcd -- the piece table -- which maps character
//      positions to byte offsets back in the WordDocument stream.
//   3. Each piece is flagged as either 16-bit (UTF-16LE) or "compressed"
//      8-bit CP1252, and pieces of both kinds routinely coexist in one file.
const { decodeCp1252 } = require("./cp1252.cjs");

// FibBase.flags bit 9. Chooses between the two possible table streams --
// getting this wrong reads the Clx out of the wrong (often stale) stream.
const F_WHICH_TBL_STM = 0x0200;

// Absolute offsets of the fcClx/lcbClx pair inside FibRgFcLcb97, which
// itself begins at 0x9A; fcClx is the 34th FC/LCB pair (0x9A + 33*8 = 0x1A2).
const FC_CLX_OFFSET = 0x01a2;
const LCB_CLX_OFFSET = 0x01a6;

const CLX_PRC = 0x01; // a formatting run -- skipped
const CLX_PCDT = 0x02; // the piece table itself

// In a PCD, bit 30 of fc means "this piece is 8-bit compressed text, and the
// real byte offset is fc/2"; the remaining bits are the offset.
const FC_COMPRESSED = 0x40000000;
const FC_MASK = 0x3fffffff;

const PCD_SIZE = 8;
const CP_SIZE = 4;

class DocParseError extends Error {}

/** Locate the Clx (which holds the piece table) inside the table stream. */
function readClx(wordDocument, cfbFile) {
  if (wordDocument.length < LCB_CLX_OFFSET + 4) {
    throw new DocParseError("WordDocument stream is too short to contain a FIB.");
  }

  const flags = wordDocument.readUInt16LE(0x0a);
  const tableStreamName = flags & F_WHICH_TBL_STM ? "1Table" : "0Table";
  const table = cfbFile.getStream(tableStreamName);
  if (!table) throw new DocParseError(`Table stream "${tableStreamName}" is missing.`);

  const fcClx = wordDocument.readUInt32LE(FC_CLX_OFFSET);
  const lcbClx = wordDocument.readUInt32LE(LCB_CLX_OFFSET);
  if (lcbClx === 0 || fcClx + lcbClx > table.length) {
    throw new DocParseError("Clx offset/length falls outside the table stream.");
  }
  return table.subarray(fcClx, fcClx + lcbClx);
}

/** Walk the Clx, skipping Prc entries, and return the PlcPcd bytes. */
function findPlcPcd(clx) {
  let offset = 0;
  while (offset < clx.length) {
    const kind = clx[offset];
    if (kind === CLX_PRC) {
      if (offset + 3 > clx.length) break;
      const cbGrpprl = clx.readInt16LE(offset + 1);
      offset += 3 + cbGrpprl;
    } else if (kind === CLX_PCDT) {
      if (offset + 5 > clx.length) break;
      const lcb = clx.readUInt32LE(offset + 1);
      const start = offset + 5;
      return clx.subarray(start, Math.min(start + lcb, clx.length));
    } else {
      break; // unknown entry kind -- stop rather than guess
    }
  }
  throw new DocParseError("No piece table (PlcPcd) found in the Clx.");
}

/**
 * A PlcPcd is (n+1) character positions followed by n 8-byte piece
 * descriptors, so n is derivable from the total length.
 */
function parsePieces(plcPcd) {
  const n = Math.floor((plcPcd.length - CP_SIZE) / (CP_SIZE + PCD_SIZE));
  if (n <= 0) throw new DocParseError("Piece table contains no pieces.");

  const pieces = [];
  const pcdBase = (n + 1) * CP_SIZE;
  for (let i = 0; i < n; i += 1) {
    const cpStart = plcPcd.readUInt32LE(i * CP_SIZE);
    const cpEnd = plcPcd.readUInt32LE((i + 1) * CP_SIZE);
    const fc = plcPcd.readUInt32LE(pcdBase + i * PCD_SIZE + 2);

    const compressed = Boolean(fc & FC_COMPRESSED);
    const charCount = cpEnd - cpStart;
    if (charCount <= 0) continue;

    pieces.push({
      compressed,
      // A compressed piece stores its offset doubled, so it is halved back.
      offset: compressed ? (fc & FC_MASK) / 2 : fc & FC_MASK,
      byteLength: compressed ? charCount : charCount * 2,
    });
  }
  return pieces;
}

// Characters below 0x20 are structural markers in Word, not text: 0x07 is a
// cell/row mark, 0x0B a line break, 0x0C a page break, 0x0D a paragraph
// mark, 0x13/0x14/0x15 delimit field codes, 0x01/0x08 mark embedded
// objects, and 0x1E/0x1F are the non-breaking and soft hyphens. These are
// built with explicit \uXXXX escapes rather than literal control bytes so
// the source stays readable and survives any editor, diff or encoding.
const FIELD_INSTRUCTION = new RegExp("\\u0013[^]*?(?:\\u0014|(?=\\u0015))", "g"); // begin..separator
const FIELD_DELIMITERS = new RegExp("[\\u0013\\u0014\\u0015]", "g");
const NON_BREAKING_HYPHEN = new RegExp("\\u001E", "g");
const SOFT_HYPHEN = new RegExp("\\u001F", "g");
const NON_BREAKING_SPACE = new RegExp("\\u00A0", "g");
const BREAK_MARKERS = /[\r\v\f]/g;
// 0x07 ends a table cell (and, at the end of a row, the row). It MUST become
// whitespace rather than being dropped: deleting it glues adjacent cells
// into one token -- "Date|Événement|Section" collapsing to
// "DateÉvénementSection" -- which invents words that are in no document and
// destroys the real ones, poisoning search, classification and similarity
// scoring alike.
const CELL_MARK = new RegExp("\\u0007", "g");
// Everything else in C0 that survived, plus DEL. Note 0x07 is excluded --
// it is handled above.
const RESIDUAL_CONTROLS = new RegExp("[\\u0000-\\u0006\\u0008\\u000E-\\u001F\\u007F]", "g");

function cleanDocText(raw) {
  return raw
    // Field-code instructions are markup (e.g. `HYPERLINK "http://..."`);
    // the text the reader actually sees follows the separator, so dropping
    // the instruction half keeps the visible link text and discards the code.
    .replace(FIELD_INSTRUCTION, "")
    .replace(FIELD_DELIMITERS, "")
    .replace(CELL_MARK, "\t")
    .replace(BREAK_MARKERS, "\n")
    .replace(NON_BREAKING_HYPHEN, "-")
    .replace(SOFT_HYPHEN, "")
    .replace(NON_BREAKING_SPACE, " ")
    .replace(RESIDUAL_CONTROLS, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {Buffer} wordDocument - the "WordDocument" stream
 * @param {{getStream: (name: string) => Buffer|null}} cfbFile
 * @returns {{text: string, pieceCount: number}}
 */
function extractDocText(wordDocument, cfbFile) {
  const pieces = parsePieces(findPlcPcd(readClx(wordDocument, cfbFile)));

  const parts = [];
  for (const piece of pieces) {
    const end = piece.offset + piece.byteLength;
    if (piece.offset < 0 || end > wordDocument.length) continue; // skip a corrupt piece, keep the rest
    const slice = wordDocument.subarray(piece.offset, end);
    parts.push(piece.compressed ? decodeCp1252(slice) : slice.toString("utf16le"));
  }

  return { text: cleanDocText(parts.join("")), pieceCount: pieces.length };
}

module.exports = { extractDocText, cleanDocText, DocParseError };
