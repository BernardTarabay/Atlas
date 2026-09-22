// Thumbnails: small pictures of files, made once and kept.
//
// WHERE THEY COME FROM
//
// Windows itself, through bin/atlas-winrt.exe: the shell's own thumbnail for
// the file - the same one Explorer shows, from the same handlers, so photos,
// video frames and (where a handler is installed) Office documents all work -
// then a rendered first page for PDFs, then a direct decode for images the
// shell has nothing for. Anything else has no thumbnail and the page shows its
// type badge instead.
//
// WHERE THEY LIVE
//
// <home>/thumbs/ab/<sha>-<size>-v<N>.img, keyed by CONTENT. So every copy of a
// photo shares one thumbnail, and moving or renaming a file never invalidates
// it - the bytes did not change, so neither did the picture. Three sizes only
// (128, 256, 512), so a folder viewed at two icon sizes costs two files, not
// twenty.
//
// WHEN
//
// On demand, when a page asks for one, on a small pool of helper processes kept
// separate from OCR so neither can starve the other. Requests for the same
// thumbnail share one job, and a request the browser has already abandoned
// (scrolled past, navigated away) is dropped before it starts.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { WinRt, winrtAvailable } from "./ocr/winrt.ts";

export const SIZES = [128, 256, 512] as const;

/**
 * Bump when the generator changes what it produces. It is part of the cache
 * file name AND of the URL the pages use (ui/explorer.js, ui/dashboard.js),
 * because thumbnails are served as immutable: a browser that has one will never
 * ask again, so an improved generator reaches nobody unless the URL changes.
 * 2: JPEG unless the image really has transparency (was: PNG for every .png).
 */
export const THUMB_V = 2;
export const bucket = (n: number) => SIZES.find((s) => s >= n) ?? SIZES[SIZES.length - 1];

/** `expect`: the size and mtime of the version that was hashed; a picture of any other version is not this content's. */
interface Expect { size: number; mtime: number }
interface Job { key: string; abs: string; size: number; out: string; gone: () => boolean; expect?: Expect; resolve: (p: string | null) => void }

/** Is the file at `abs` still the hashed version? Asynchronous: never block the main thread on a disk. */
async function same(abs: string, e: Expect | undefined): Promise<boolean> {
  if (!e) return true;
  try {
    const s = await fsp.stat(abs);
    return s.size === e.size && Math.floor(s.mtimeMs) === e.mtime;
  } catch {
    return false;
  }
}

export class Thumbs {
  private dir = path.join(config.home, "thumbs");
  private slots: { rt: WinRt; busy: boolean }[];
  private queue: Job[] = [];
  private inflight = new Map<string, Promise<string | null>>();
  /** Contents Windows could not draw. Remembered so a folder of them is not retried on every scroll. */
  private none = new Set<string>();
  readonly counters = { made: 0, cached: 0, none: 0, dropped: 0, ms: 0 };

  constructor(concurrency = 2) {
    this.slots = winrtAvailable() ? Array.from({ length: concurrency }, () => ({ rt: new WinRt(20_000), busy: false })) : [];
  }

  static available() { return winrtAvailable(); }

  private file(sha: string, size: number) {
    return path.join(this.dir, sha.slice(0, 2).toLowerCase(), `${sha.toLowerCase()}-${size}-v${THUMB_V}.img`);
  }

  /**
   * The cached thumbnail for this content at this size, making it if needed.
   * Resolves to a file path, or null when there is no picture to be had.
   */
  get(sha: string, abs: string, size: number, gone: () => boolean = () => false, expect?: Expect): Promise<string | null> {
    const key = `${sha}-${size}`;
    if (this.none.has(sha)) return Promise.resolve(null);
    const out = this.file(sha, size);
    if (fs.existsSync(out)) { this.counters.cached++; return Promise.resolve(out); }
    const running = this.inflight.get(key);
    if (running) return running;
    if (!this.slots.length) return Promise.resolve(null);
    const p = new Promise<string | null>((resolve) => {
      this.queue.push({ key, abs, size, out, gone, expect, resolve });
      this.pump();
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.busy) continue;
      let job = this.queue.shift();
      // Scrolled past before its turn came: nobody is waiting for this picture.
      while (job && job.gone()) { this.counters.dropped++; job.resolve(null); job = this.queue.shift(); }
      if (!job) return;
      slot.busy = true;
      const j = job;
      const t0 = performance.now();
      fs.mkdirSync(path.dirname(j.out), { recursive: true });
      // Written beside the final name and renamed into place, so a crash mid-write
      // can never leave a half-written file that looks like a finished thumbnail.
      const tmp = `${j.out}.${process.pid}.tmp`;
      // Cached under the content's SHA-256 for good, so it must be a picture of THAT
      // content: the file is checked before and after (it may have been saved over
      // since it was hashed, and not yet rescanned).
      same(j.abs, j.expect)
        .then(async (before) => {
          if (!before) throw new Error("changed since it was read");
          await slot.rt.thumb(j.abs, j.size, tmp);
          if (!(await same(j.abs, j.expect))) throw new Error("changed while its thumbnail was made");
        })
        .then(() => {
          fs.renameSync(tmp, j.out);
          this.counters.made++;
          j.resolve(j.out);
        })
        .catch((e: Error) => {
          fs.rmSync(tmp, { force: true });
          if (/no thumbnail/i.test(e.message)) { this.none.add(j.key.slice(0, j.key.lastIndexOf("-"))); this.counters.none++; }
          else if (/^changed /.test(e.message)) this.counters.dropped++;
          else log.warn("thumbnail failed", { file: j.abs, error: e.message.slice(0, 200) });
          j.resolve(null);
        })
        .finally(() => {
          this.counters.ms += performance.now() - t0;
          slot.busy = false;
          this.pump();
        });
    }
  }

  close() { for (const s of this.slots) s.rt.close(); }
}
