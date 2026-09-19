// Build real zip/docx files in memory for tests.
import zlib from "node:zlib";

export function zip(entries: [string, string][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content, "utf8");
    const comp = zlib.deflateRawSync(data);
    const nameB = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameB.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(local, nameB, comp);
    central.push(cen, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function docx(title: string, paragraphs: string[], created = "2023-02-19T10:00:00Z"): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xml(p)}</w:t></w:r></w:p>`).join("");
  return zip([
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`],
    ["word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`],
    ["docProps/core.xml", `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y" xmlns:dcterms="z"><dc:title>${xml(title)}</dc:title><dcterms:created>${created}</dcterms:created></cp:coreProperties>`],
  ]);
}
