// Dates: when a document/photo is FROM, not when this copy was written.
// Metadata parsers ported from V1's documentDate.js; filename patterns are new.

const EARLIEST = Date.UTC(1900, 0, 1);
const plausible = (t: number | null | undefined): number | null =>
  t != null && Number.isFinite(t) && t >= EARLIEST && t <= Date.now() + 366 * 86400_000 ? t : null;

export function parsePdfDate(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(v.trim());
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", sign, oh = "00", om = "00"] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${sign === "Z" || !sign ? "Z" : `${sign}${oh}:${om}`}`;
  return plausible(Date.parse(iso));
}

/** EXIF "YYYY:MM:DD HH:MM:SS" (local camera time, stored as if UTC -- what the photographer saw). */
export function parseExifDate(v: unknown): number | null {
  if (v instanceof Date) return plausible(v.getTime());
  if (typeof v !== "string") return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v.trim());
  return m ? plausible(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

export function parseIsoDate(v: unknown): number | null {
  if (v instanceof Date) return plausible(v.getTime());
  if (typeof v !== "string" || !v.trim()) return null;
  return plausible(Date.parse(v.trim()));
}

export function parseFileTime(ticks: unknown): number | null {
  try {
    const big = typeof ticks === "bigint" ? ticks : BigInt(ticks as string | number);
    if (big <= 0n) return null;
    return plausible(Number(big / 10000n) - 11644473600000);
  } catch {
    return null;
  }
}

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return plausible(Date.UTC(y, mo - 1, d, h, mi, s));
};

// Ordered most specific first. Each returns [timestamp, hasTime].
const NAME_PATTERNS: [RegExp, (m: RegExpExecArray) => [number | null, boolean]][] = [
  // WhatsApp Image 2026-07-29 at 20.17.33 / WhatsApp Video 2026-07-16 at 00.16.15
  [/(\d{4})-(\d{2})-(\d{2}) at (\d{2})\.(\d{2})\.(\d{2})/, (m) => [utc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]), true]],
  // Screenshot 2026-04-26 211704 / Capture d'écran 2026-04-26 211704
  [/(\d{4})-(\d{2})-(\d{2})[ _](\d{2})(\d{2})(\d{2})(?!\d)/, (m) => [utc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]), true]],
  // IMG_20240712_153012 / VID_20240712_153012 / PXL_20240712_153012123 / 20240712_153012
  [/(?:^|[^\d])(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/, (m) => [utc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]), true]],
  // 2024-07-12 15.30.12 / 2024-07-12_15-30-12
  [/(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[.:-](\d{2})[.:-](\d{2})/, (m) => [utc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]), true]],
  // IMG-20240712-WA0001 (WhatsApp Android)
  [/-(\d{4})(\d{2})(\d{2})-WA\d+/i, (m) => [utc(+m[1], +m[2], +m[3]), false]],
  // 2024-07-12 / 2024_07_12 / 2024.07.12
  [/(?:^|[^\d])(\d{4})[-_.](\d{2})[-_.](\d{2})(?!\d)/, (m) => [utc(+m[1], +m[2], +m[3]), false]],
  // 12.07.2024 / 12-07-2024 / 12/07/2024 (day first: European and Arabic usage)
  [/(?:^|[^\d])(\d{2})[-_.](\d{2})[-_.](\d{4})(?!\d)/, (m) => [utc(+m[3], +m[2], +m[1]), false]],
  // 20240712 standing alone
  [/(?:^|[^\d])(20\d{2}|19\d{2})(\d{2})(\d{2})(?!\d)/, (m) => [utc(+m[1], +m[2], +m[3]), false]],
];

const toAsciiDigits = (s: string) => s.replace(/[٠-٩۰-۹]/g, (c) => {
  const code = c.charCodeAt(0);
  return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
});

/** A date written in the file's own name, if any. */
export function dateFromName(name: string): { t: number; hasTime: boolean } | null {
  const s = toAsciiDigits(name);
  for (const [re, fn] of NAME_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const [t, hasTime] = fn(m);
    if (t != null) return { t, hasTime };
  }
  return null;
}
