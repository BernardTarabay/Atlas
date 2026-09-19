// Text extraction from a legacy PowerPoint 97-2003 (.ppt) file, per
// [MS-PPT].
//
// The "PowerPoint Document" stream is a tree of records, each with an
// 8-byte header: recVerAndInstance (uint16), recType (uint16), recLen
// (uint32). When the low nibble of the first field is 0xF the record is a
// container whose payload is more records; otherwise it is a leaf atom.
//
// Slide text lives in just three atom types, so extraction is a recursive
// walk collecting those. Unlike .doc there is no piece table to consult --
// the atoms are the text -- but the container/atom distinction still has to
// be respected, because scanning linearly for the atom type bytes without
// tracking record boundaries produces false matches inside binary payloads
// (picture data especially).
const { decodeCp1252 } = require("./cp1252.cjs");

const HEADER_SIZE = 8;
const CONTAINER_VERSION = 0x0f;

const REC_TYPE = {
  TEXT_CHARS_ATOM: 0x0fa0, // UTF-16LE
  TEXT_BYTES_ATOM: 0x0fa8, // CP1252, one byte per character
  CSTRING: 0x0fba, // UTF-16LE -- slide/note titles, hyperlink text
};

// The slide master holds the template placeholder prompts ("Click to edit
// the title text format", "Second Outline Level", the bullet glyphs). That
// text is identical in every deck built from a stock template, so including
// it would (a) pollute search results with text no reader ever sees and
// (b) make every .ppt look similar to every other one -- which would feed
// straight into probable-duplicate detection as false positives. Skipped
// wholesale rather than filtered by string, since the prompts are localized
// and a string blacklist would only work for English.
const MAIN_MASTER_CONTAINER = 0x03f8;

// An internal version marker PowerPoint writes into a ProgTags CString.
const INTERNAL_MARKERS = /^_*PPT\d+$/;

// Layout placeholders often carry a lone bullet glyph as their text. An atom
// with no letter or digit in any script carries no content worth indexing.
const HAS_CONTENT = /[\p{L}\p{N}]/u;

// Deep nesting is legal but bounded in practice; this stops a malformed or
// cyclic file from recursing without limit.
const MAX_DEPTH = 32;

class PptParseError extends Error {}

function walk(buffer, depth, out) {
  if (depth > MAX_DEPTH) return;

  let offset = 0;
  while (offset + HEADER_SIZE <= buffer.length) {
    const verAndInstance = buffer.readUInt16LE(offset);
    const recType = buffer.readUInt16LE(offset + 2);
    const recLen = buffer.readUInt32LE(offset + 4);

    const bodyStart = offset + HEADER_SIZE;
    const bodyEnd = bodyStart + recLen;
    if (bodyEnd > buffer.length) break; // truncated -- stop cleanly

    const body = buffer.subarray(bodyStart, bodyEnd);

    if (recType === MAIN_MASTER_CONTAINER) {
      // Skip the whole subtree, not just its atoms.
    } else if ((verAndInstance & 0x0f) === CONTAINER_VERSION) {
      walk(body, depth + 1, out);
    } else if (recType === REC_TYPE.TEXT_CHARS_ATOM || recType === REC_TYPE.CSTRING) {
      out.push(body.toString("utf16le"));
    } else if (recType === REC_TYPE.TEXT_BYTES_ATOM) {
      out.push(decodeCp1252(body));
    }

    // Always advances: bodyEnd is at least offset + HEADER_SIZE, so a
    // zero-length atom still moves past its own header and the loop
    // terminates even on a file full of empty records.
    offset = bodyEnd;
  }
}

// PowerPoint uses \r as its paragraph separator and \v as a soft line break
// within a paragraph; 0x0B and 0x0D both need to become real newlines or
// every slide collapses into one run-on line.
const PARAGRAPH_BREAKS = /[\r\v\f]/g;
const RESIDUAL_CONTROLS = new RegExp("[\\u0000-\\u0008\\u000E-\\u001F\\u007F]", "g");

function cleanPptText(raw) {
  return raw
    .replace(PARAGRAPH_BREAKS, "\n")
    .replace(RESIDUAL_CONTROLS, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {Buffer} pptStream - the "PowerPoint Document" stream
 * @returns {{text: string, atomCount: number}}
 */
function extractPptText(pptStream) {
  if (!pptStream || pptStream.length < HEADER_SIZE) {
    throw new PptParseError("PowerPoint Document stream is empty or truncated.");
  }

  const parts = [];
  walk(pptStream, 0, parts);
  if (parts.length === 0) {
    return { text: "", atomCount: 0 };
  }

  // Each atom is a separate text run (a shape, a title, a bullet), so they
  // are newline-joined rather than concatenated -- otherwise the last word
  // of one shape fuses with the first word of the next.
  const kept = parts.filter((p) => {
    const trimmed = p.trim();
    return HAS_CONTENT.test(trimmed) && !INTERNAL_MARKERS.test(trimmed);
  });
  return { text: cleanPptText(kept.join("\n")), atomCount: kept.length };
}

module.exports = { extractPptText, cleanPptText, PptParseError };
