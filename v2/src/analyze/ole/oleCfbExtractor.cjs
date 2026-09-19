// Legacy OLE-CFB Office formats: .doc / .xls / .ppt (Office 97-2003).
//
// fileSignature.js already identifies the container by its magic bytes, but
// all three formats share it -- the D0CF11E0 header says "compound file",
// not which application wrote it. The reliable discriminator is which
// top-level stream is present ("WordDocument", "Workbook"/"Book",
// "PowerPoint Document"), which is why dispatch happens here on stream
// names rather than on the file extension. A .doc that has been renamed
// .xls still extracts correctly, consistent with spec §7's requirement not
// to rely on extensions.
//
// Filling in the gap documented in docs/07-supported-formats.md: these
// formats were previously detected and then reported unextractable.
const cfb = require("./cfb.cjs");
const { extractDocText } = require("./docText.cjs");
const { extractXlsText } = require("./xlsText.cjs");
const { extractPptText } = require("./pptText.cjs");

const { decodeCodePageString, normalizeCodePage } = require("./codePageString.cjs");

// Property-set stream holding Title/Author/etc. Parsed only far enough to
// recover a title, which namingService prefers over anything AI-derived
// (see its header comment). Full OLE property-set parsing is deliberately
// out of scope; this reads the common case and gives up quietly otherwise.
// The real stream name begins with byte 0x05 (the OLE convention marking a
// property-set stream), so a plain "SummaryInformation" lookup never matches.
// Built via fromCharCode to keep the control byte out of the source.
const SUMMARY_INFORMATION = String.fromCharCode(5) + "SummaryInformation";
const PID_CODEPAGE = 0x00000001;
const PID_TITLE = 0x00000002;
const PID_AUTHOR = 0x00000004;
// PIDSI_CREATE_DTM / PIDSI_LASTSAVE_DTM. These are the only real evidence of
// when a legacy .doc is from -- the filesystem timestamps on this corpus
// mostly record when it was copied off a backup.
const PID_CREATED = 0x0000000c;
const PID_MODIFIED = 0x0000000d;
const VT_I2 = 2;
const VT_FILETIME = 64;
const VT_LPSTR = 30;
const VT_LPWSTR = 31;

function readSummaryInformation(buffer) {
  const empty = { title: null, creator: null, createdFileTime: null, modifiedFileTime: null };
  if (!buffer || buffer.length < 48) return empty;

  try {
    // Header: byteOrder(2) version(2) osVersion(4) clsid(16) numSections(4),
    // then per section: formatId(16) sectionOffset(4).
    const numSections = buffer.readUInt32LE(24);
    if (numSections < 1) return empty;
    const sectionOffset = buffer.readUInt32LE(44);
    if (sectionOffset + 8 > buffer.length) return empty;

    const propertyCount = buffer.readUInt32LE(sectionOffset + 4);
    const out = { ...empty };

    // FIRST PASS: the code page, which every VT_LPSTR in this section is
    // encoded with. [MS-OLEPS] requires PID_CODEPAGE to come first, but not
    // every writer obeys that, so it is read in its own pass rather than
    // relying on encountering it before the title.
    let codePage = null;
    for (let i = 0; i < propertyCount; i += 1) {
      const entry = sectionOffset + 8 + i * 8;
      if (entry + 8 > buffer.length) break;
      if (buffer.readUInt32LE(entry) !== PID_CODEPAGE) continue;
      const valueOffset = sectionOffset + buffer.readUInt32LE(entry + 4);
      if (valueOffset + 6 > buffer.length) break;
      if (buffer.readUInt32LE(valueOffset) !== VT_I2) break;
      codePage = normalizeCodePage(buffer.readInt16LE(valueOffset + 4));
      break;
    }

    for (let i = 0; i < propertyCount; i += 1) {
      const entry = sectionOffset + 8 + i * 8;
      if (entry + 8 > buffer.length) break;
      const propertyId = buffer.readUInt32LE(entry);
      const wanted = propertyId === PID_TITLE || propertyId === PID_AUTHOR ||
                     propertyId === PID_CREATED || propertyId === PID_MODIFIED;
      if (!wanted) continue;

      const valueOffset = sectionOffset + buffer.readUInt32LE(entry + 4);
      if (valueOffset + 8 > buffer.length) continue;

      const type = buffer.readUInt32LE(valueOffset);

      // FILETIME: 64-bit little-endian, 100ns ticks since 1601. Kept as a
      // string because it exceeds Number's safe integer range and this value
      // goes through JSON into a jsonb column; documentDate.js parses it.
      if (type === VT_FILETIME) {
        if (valueOffset + 12 > buffer.length) continue;
        const ticks = buffer.readBigUInt64LE(valueOffset + 4);
        if (ticks > 0n) {
          if (propertyId === PID_CREATED) out.createdFileTime = ticks.toString();
          else if (propertyId === PID_MODIFIED) out.modifiedFileTime = ticks.toString();
        }
        continue;
      }
      if (propertyId !== PID_TITLE && propertyId !== PID_AUTHOR) continue;
      const length = buffer.readUInt32LE(valueOffset + 4);
      const start = valueOffset + 8;
      if (length === 0 || start + length > buffer.length) continue;

      let value = null;
      if (type === VT_LPSTR) {
        // Was `.toString("latin1")`, which mangled every Arabic title in the
        // repository into "Ù…Ø¯Ø®Ù„"-style mojibake. See ole/codePageString.js.
        value = decodeCodePageString(buffer.subarray(start, start + length), codePage).replace(/\0.*$/s, "");
      } else if (type === VT_LPWSTR) {
        value = buffer.subarray(start, start + length * 2).toString("utf16le").replace(/\0.*$/s, "");
      }
      value = value ? value.trim() : null;
      if (!value) continue;

      if (propertyId === PID_TITLE) out.title = value;
      else out.creator = value;
    }
    return out;
  } catch {
    return empty; // metadata is a bonus; never fail extraction over it
  }
}

async function extract(buffer) {
  const container = cfb.parse(buffer);
  const { title, creator, createdFileTime, modifiedFileTime } =
    readSummaryInformation(container.getStream(SUMMARY_INFORMATION));

  const base = {
    extractorVersion: "cfb+native",
    metadata: {
      title: title || null,
      creator: creator || null,
      createdFileTime: createdFileTime || null,
      modifiedFileTime: modifiedFileTime || null,
    },
  };

  const wordDocument = container.getStream("WordDocument");
  if (wordDocument) {
    const { text, pieceCount } = extractDocText(wordDocument, container);
    return { ...base, extractor: "doc", metadata: { ...base.metadata, pieceCount }, text };
  }

  const workbook = container.getStream("Workbook") || container.getStream("Book");
  if (workbook) {
    const { text, sheetNames, sharedStringCount } = extractXlsText(workbook);
    return {
      ...base,
      extractor: "xls",
      metadata: { ...base.metadata, sheetNames, sheetCount: sheetNames.length, sharedStringCount },
      text,
    };
  }

  const presentation = container.getStream("PowerPoint Document");
  if (presentation) {
    const { text, atomCount } = extractPptText(presentation);
    return { ...base, extractor: "ppt", metadata: { ...base.metadata, textAtomCount: atomCount }, text };
  }

  // A compound file this app has no reader for -- e.g. Visio, an MSI, or an
  // Outlook .msg. Thrown so extraction/index.js reports it as unsupported
  // with the stream list as evidence, rather than silently returning "".
  throw new cfb.CfbError(
    `Compound file has no recognized Office document stream (streams: ${container.streamNames.join(", ")})`
  );
}

module.exports = { extract, readSummaryInformation };
