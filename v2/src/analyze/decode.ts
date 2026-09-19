// Bytes -> text for plain-text formats, and markup -> text.
// Arabic text files from older Windows tools are windows-1256, not UTF-8.

const utf8 = new TextDecoder("utf-8", { fatal: true });
const utf8Lenient = new TextDecoder("utf-8");
const cp1256 = new TextDecoder("windows-1256");
const cp1252 = new TextDecoder("windows-1252");

export function decodeText(buf: Uint8Array): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return utf8Lenient.decode(buf.subarray(3));
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try {
    return utf8.decode(buf);
  } catch {
    // Not UTF-8. Arabic letters in windows-1256 live in 0xC1-0xDA; in Western text
    // those bytes are rare capitals (ÁÂ...). Majority decides.
    let arabicRange = 0, high = 0;
    const n = Math.min(buf.length, 65536);
    for (let i = 0; i < n; i++) {
      const b = buf[i];
      if (b >= 0x80) { high++; if (b >= 0xc1 && b <= 0xda) arabicRange++; }
    }
    return high && arabicRange / high > 0.5 ? cp1256.decode(buf) : cp1252.decode(buf);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): { text: string; title: string | null } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? null;
  const text = html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return { text: decodeEntities(text).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim(), title: title ? decodeEntities(title).trim() : null };
}

/** RTF: drop groups we do not want, decode \'hh with the declared code page and \uN, strip control words. */
export function rtfToText(rtf: string): string {
  const cpMatch = /\\ansicpg(\d+)/.exec(rtf);
  const dec = cpMatch?.[1] === "1256" ? cp1256 : cp1252;
  let s = rtf.replace(/\{\\\*[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, " ");
  s = s.replace(/\{\\(fonttbl|colortbl|stylesheet|info|pict)[\s\S]*?\}\s*\}/g, " ");
  s = s.replace(/\\u(-?\d+)\??/g, (_m, n: string) => String.fromCharCode((Number(n) + 65536) % 65536));
  s = s.replace(/((?:\\'[0-9a-f]{2})+)/gi, (m) => dec.decode(Uint8Array.from(m.split("\\'").filter(Boolean).map((h) => parseInt(h, 16)))));
  s = s.replace(/\\(par|line|row|cell)\b ?/g, "\n").replace(/\\[a-z]+-?\d* ?/gi, "").replace(/[{}]/g, "");
  return s.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
