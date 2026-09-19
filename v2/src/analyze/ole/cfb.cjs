// Minimal reader for the OLE2 / Compound File Binary container format
// (Microsoft [MS-CFB]) -- the "filesystem in a file" that legacy .doc, .xls
// and .ppt are stored in. fileSignature.js already detects the container by
// its D0CF11E0A1B11AE1 magic; this turns it into named streams so the
// per-format extractors can read "WordDocument", "Workbook", etc.
//
// Written by hand rather than pulling in SheetJS's `cfb` package, matching
// how the rest of this codebase treats well-documented formats (raw fetch
// instead of vendor SDKs, adm-zip + manual XML for OOXML). The container
// format is small and stable -- the parsing below is essentially a direct
// transcription of the spec's structure definitions.
//
// Scope: reading streams out of a well-formed file. It does not write, does
// not repair damaged containers, and treats anything malformed as an error
// for the caller to turn into "unsupported" rather than guessing.

const HEADER_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

// Special FAT sector values ([MS-CFB] 2.2).
const MAXREGSECT = 0xfffffffa;
const DIFSECT = 0xfffffffc;
const FATSECT = 0xfffffffd;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

const DIR_ENTRY_SIZE = 128;
const OBJ_TYPE_STREAM = 2;
const OBJ_TYPE_ROOT = 5;

// A chain longer than this means the FAT is cyclic or corrupt. Bounded so a
// malformed file can never spin forever (same defensive posture as
// resolveAvailableFilename's attempt cap).
const MAX_CHAIN_LENGTH = 1 << 22;

class CfbError extends Error {}

function isCfb(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(HEADER_SIGNATURE);
}

/**
 * Walk a FAT chain from `start`, returning the ordered sector numbers.
 * Guards against both cycles and runaway lengths.
 */
function followChain(fat, start) {
  const chain = [];
  const seen = new Set();
  let sector = start;
  while (sector <= MAXREGSECT && chain.length < MAX_CHAIN_LENGTH) {
    if (seen.has(sector)) throw new CfbError("Cyclic FAT chain.");
    if (sector >= fat.length) throw new CfbError(`FAT chain points past the end of the FAT (${sector}).`);
    seen.add(sector);
    chain.push(sector);
    sector = fat[sector];
  }
  return chain;
}

function parse(buffer) {
  if (!isCfb(buffer)) throw new CfbError("Not an OLE compound file (bad signature).");
  if (buffer.length < 512) throw new CfbError("Truncated compound file header.");

  const sectorShift = buffer.readUInt16LE(0x1e);
  const miniSectorShift = buffer.readUInt16LE(0x20);
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;
  if (sectorSize !== 512 && sectorSize !== 4096) {
    throw new CfbError(`Unsupported sector size ${sectorSize}.`);
  }

  const numFatSectors = buffer.readUInt32LE(0x2c);
  const firstDirSector = buffer.readUInt32LE(0x30);
  const miniStreamCutoff = buffer.readUInt32LE(0x38);
  const firstMiniFatSector = buffer.readUInt32LE(0x3c);
  const numMiniFatSectors = buffer.readUInt32LE(0x40);
  const firstDifatSector = buffer.readUInt32LE(0x44);
  const numDifatSectors = buffer.readUInt32LE(0x48);

  // Sector N of the file body starts immediately after the 512-byte header.
  // With 4096-byte sectors the header still occupies only its first 512
  // bytes, but sector 0 begins at a full sector boundary.
  const sectorOffset = (n) => (n + 1) * sectorSize;

  function readSector(n) {
    const start = sectorOffset(n);
    const end = start + sectorSize;
    if (end > buffer.length) throw new CfbError(`Sector ${n} extends past end of file.`);
    return buffer.subarray(start, end);
  }

  // --- DIFAT: the list of sectors that hold the FAT itself ---------------
  const difat = [];
  for (let i = 0; i < 109; i += 1) {
    const entry = buffer.readUInt32LE(0x4c + i * 4);
    if (entry === FREESECT || entry === ENDOFCHAIN) break;
    difat.push(entry);
  }
  // Large files continue the DIFAT in its own sector chain; each such sector
  // holds (sectorSize/4 - 1) FAT sector numbers plus a pointer to the next.
  let difatSector = firstDifatSector;
  let difatSectorsRead = 0;
  while (difatSector <= MAXREGSECT && difatSectorsRead <= numDifatSectors) {
    const sec = readSector(difatSector);
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector; i += 1) {
      const entry = sec.readUInt32LE(i * 4);
      if (entry === FREESECT || entry === ENDOFCHAIN) break;
      difat.push(entry);
    }
    difatSector = sec.readUInt32LE(sectorSize - 4);
    difatSectorsRead += 1;
  }

  // --- FAT ---------------------------------------------------------------
  const entriesPerSector = sectorSize / 4;
  const fat = new Uint32Array(difat.length * entriesPerSector);
  let fatIndex = 0;
  for (const fatSectorNumber of difat.slice(0, numFatSectors || difat.length)) {
    const sec = readSector(fatSectorNumber);
    for (let i = 0; i < entriesPerSector; i += 1) {
      fat[fatIndex++] = sec.readUInt32LE(i * 4);
    }
  }

  function readChain(start, sizeLimit = Infinity) {
    const parts = followChain(fat, start).map(readSector);
    const joined = Buffer.concat(parts);
    return Number.isFinite(sizeLimit) ? joined.subarray(0, sizeLimit) : joined;
  }

  // --- Directory ---------------------------------------------------------
  const dirBytes = readChain(firstDirSector);
  const entries = [];
  for (let offset = 0; offset + DIR_ENTRY_SIZE <= dirBytes.length; offset += DIR_ENTRY_SIZE) {
    const raw = dirBytes.subarray(offset, offset + DIR_ENTRY_SIZE);
    const nameLength = raw.readUInt16LE(64);
    const objectType = raw.readUInt8(66);
    if (objectType !== OBJ_TYPE_STREAM && objectType !== OBJ_TYPE_ROOT) continue;

    // nameLength counts bytes INCLUDING the UTF-16 null terminator.
    const name = nameLength > 2 ? raw.subarray(0, nameLength - 2).toString("utf16le") : "";
    // Stream size is a 64-bit value; sizes beyond 2^32 are not reachable for
    // the legacy formats this exists to serve, so the low word is enough and
    // avoids a BigInt conversion on every entry.
    const size = raw.readUInt32LE(120);
    entries.push({ name, objectType, startSector: raw.readUInt32LE(116), size });
  }

  const root = entries.find((e) => e.objectType === OBJ_TYPE_ROOT);
  if (!root) throw new CfbError("Compound file has no root directory entry.");

  // --- Mini FAT ----------------------------------------------------------
  // Streams smaller than the cutoff (normally 4096 bytes) do not get their
  // own sectors; they live packed inside the root entry's "mini stream" and
  // are chained through a separate mini FAT.
  let miniFat = new Uint32Array(0);
  if (firstMiniFatSector <= MAXREGSECT && numMiniFatSectors > 0) {
    const miniFatBytes = readChain(firstMiniFatSector);
    miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
    for (let i = 0; i < miniFat.length; i += 1) miniFat[i] = miniFatBytes.readUInt32LE(i * 4);
  }

  let miniStream = Buffer.alloc(0);
  if (root.startSector <= MAXREGSECT && root.size > 0) {
    miniStream = readChain(root.startSector, root.size);
  }

  function readMiniChain(start, size) {
    const parts = [];
    const seen = new Set();
    let sector = start;
    while (sector <= MAXREGSECT && parts.length < MAX_CHAIN_LENGTH) {
      if (seen.has(sector)) throw new CfbError("Cyclic mini-FAT chain.");
      seen.add(sector);
      const offset = sector * miniSectorSize;
      parts.push(miniStream.subarray(offset, offset + miniSectorSize));
      sector = sector < miniFat.length ? miniFat[sector] : ENDOFCHAIN;
    }
    return Buffer.concat(parts).subarray(0, size);
  }

  const streams = new Map();
  for (const entry of entries) {
    if (entry.objectType !== OBJ_TYPE_STREAM || entry.size === 0) continue;
    try {
      const data =
        entry.size < miniStreamCutoff
          ? readMiniChain(entry.startSector, entry.size)
          : readChain(entry.startSector, entry.size);
      // Duplicate names are legal in a CFB (different storages); the first
      // wins, which for these formats is always the top-level one.
      if (!streams.has(entry.name)) streams.set(entry.name, data);
    } catch {
      // A single unreadable stream shouldn't sink the whole file -- the
      // caller may only need one of them.
    }
  }

  return {
    sectorSize,
    miniSectorSize,
    streamNames: [...streams.keys()],
    streams,
    getStream(name) {
      return streams.get(name) || null;
    },
  };
}

module.exports = { parse, isCfb, CfbError, HEADER_SIGNATURE };
