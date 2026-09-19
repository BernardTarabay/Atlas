// Image facts: EXIF (capture time, camera) via exifr, dimensions from headers.
import exifr from "exifr";

export interface ImageResult { taken: unknown; created: unknown; make: string | null; model: string | null; width: number | null; height: number | null; software: string | null }

const PICK = ["DateTimeOriginal", "CreateDate", "ModifyDate", "Make", "Model", "ExifImageWidth", "ExifImageHeight", "ImageWidth", "ImageHeight", "Software"];

export async function imageInfo(buf: Buffer): Promise<ImageResult> {
  let e: Record<string, unknown> | undefined;
  try {
    e = await exifr.parse(buf, { pick: PICK, reviveValues: false, translateValues: false, xmp: false, icc: false, iptc: false, jfif: false, ihdr: true });
  } catch {
    e = undefined;
  }
  const dims = dimensions(buf);
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.replace(/\0/g, "").trim() : null);
  const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : null);
  return {
    taken: e?.DateTimeOriginal ?? null,
    created: e?.CreateDate ?? null,
    make: s(e?.Make),
    model: s(e?.Model),
    width: dims?.[0] ?? n(e?.ExifImageWidth) ?? n(e?.ImageWidth),
    height: dims?.[1] ?? n(e?.ExifImageHeight) ?? n(e?.ImageHeight),
    software: s(e?.Software),
  };
}

/** Width/height straight from PNG, GIF, JPEG and WebP headers. */
export function dimensions(b: Buffer): [number, number] | null {
  if (b.length < 30) return null;
  if (b[0] === 0x89 && b[1] === 0x50) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] === 0x47 && b[1] === 0x49) return [b.readUInt16LE(6), b.readUInt16LE(8)];
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (chunk === "VP8L") { const v = b.readUInt32LE(21); return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1]; }
    if (chunk === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    const end = Math.min(b.length, 1 << 20);
    while (i + 9 < end) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}
