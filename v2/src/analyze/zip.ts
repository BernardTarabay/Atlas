// Minimal ZIP reader: central directory + on-demand inflate of named entries.
// Office files (docx/xlsx/pptx/odt/...) are zips of XML; this avoids a zip
// library and never inflates entries nobody asked for. Guards against zip bombs.
import zlib from "node:zlib";

export interface ZipEntry { name: string; method: number; csize: number; usize: number; offset: number }

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export function readZipDirectory(buf: Buffer): ZipEntry[] | null {
  // End of central directory: signature 0x06054b50 within the last 64 KB + 22 bytes.
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff || p >= buf.length) return null; // zip64 or truncated: not an Office document we can read
  const out: ZipEntry[] = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    out.push({ name, method, csize, usize, offset });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

export function readZipEntry(buf: Buffer, e: ZipEntry): Buffer | null {
  if (e.usize > MAX_ENTRY_BYTES || e.offset + 30 > buf.length) return null;
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) return null;
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method !== 8) return null;
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  } catch {
    return null;
  }
}
