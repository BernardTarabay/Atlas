// The only file operations Apply uses, behind one interface - so that every one of
// them can be made to fail on purpose (Phase 8 fault injection) and so that Apply's
// logic cannot reach for anything more dangerous by accident.
//
// Deliberately absent: fs.rename (on Windows it REPLACES an existing destination),
// any recursive delete, any overwrite. The move never replaces (native MoveFileExW
// without REPLACE_EXISTING); the copy never replaces (CopyFileW fail-if-exists).
//
// Errors are normalised to a small set of codes Apply decides on:
//   EXIST  the destination exists            NOENT  the source (or a folder) is not there
//   BUSY   the file is in use by a program    ACCES  permission denied
//   XDEV   not on the same volume             (anything else passes through as is)
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { WinRt } from "../ocr/winrt.ts";
import { serialOf } from "../scan/walker.ts";

export interface FileFacts {
  /** "volserial:fileid", as the walker records it (compared only where the index has one). */
  fid: string;
  size: number;
  /** ms, floored: the index's convention (scan/walker.ts, pipeline/worker.ts). */
  mtime: number;
  birth: number;
}

export interface FsOps {
  /** Facts about a file, or null when there is nothing there. */
  stat(file: string): Promise<FileFacts | null>;
  mkdirp(dir: string): Promise<void>;
  /** Same-volume rename that never replaces an existing file. */
  move(from: string, to: string): Promise<void>;
  /** Copy that never replaces an existing file (keeps the modified time and attributes). */
  copy(from: string, to: string): Promise<void>;
  /** Force a file's data to the disk. */
  flush(file: string): Promise<void>;
  /** SHA-256, lower-case hex. */
  hash(file: string): Promise<string>;
  setCreated(file: string, unixMs: number): Promise<void>;
  /** Delete one file. Never a folder, never recursive. */
  remove(file: string): Promise<void>;
  close(): void;
}

export class FsError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const WIN32: Record<number, string> = { 80: "EXIST", 183: "EXIST", 17: "XDEV", 32: "BUSY", 33: "BUSY", 2: "NOENT", 3: "NOENT", 5: "ACCES" };
const NODE: Record<string, string> = { EEXIST: "EXIST", ENOENT: "NOENT", EBUSY: "BUSY", EPERM: "ACCES", EACCES: "ACCES", EXDEV: "XDEV" };

function normalise(e: unknown): FsError {
  const err = e as { code?: string | number; message?: string };
  const code = typeof err.code === "number" ? WIN32[err.code] ?? `WIN${err.code}` : NODE[err.code ?? ""] ?? String(err.code ?? "ERR");
  return new FsError(code, err.message ?? String(e));
}

/**
 * The facts a move is proven against. Used on its own by the engine, which only ever
 * LOOKS at interrupted operations (main.ts) and must not spawn a helper to do it.
 */
export async function statFacts(file: string): Promise<FileFacts | null> {
  try {
    const s = await fsp.stat(file, { bigint: true });
    if (!s.isFile()) return null;
    return { fid: `${serialOf(s.dev)}:${s.ino.toString(16)}`, size: Number(s.size), mtime: Number(s.mtimeMs), birth: Number(s.birthtimeMs) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw normalise(e);
  }
}

/** One hashing thread, reused for every file of a batch. */
class Hasher {
  private w: Worker | null = null;
  private next = 1;
  private pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>();

  hash(file: string): Promise<string> {
    if (!this.w) {
      const w = new Worker(new URL("./hash-worker.ts", import.meta.url));
      w.on("message", (m: { id: number; sha?: string; error?: string; code?: string }) => {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.sha) p.resolve(m.sha); else p.reject(Object.assign(new Error(m.error), { code: m.code }));
      });
      w.on("error", (e) => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); this.w = null; });
      // Not unref'd: a command-line Apply awaiting a hash must not have Node decide the
      // process has nothing left to do and exit mid-operation. close() ends it.
      this.w = w;
    }
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.w!.postMessage({ id, path: file });
    });
  }

  close() { void this.w?.terminate(); this.w = null; }
}

/** The real thing: Node's async fs, the native helper for the two calls Node lacks, a hashing thread. */
export function nativeFsOps(): FsOps {
  const helper = new WinRt(120_000);
  const hasher = new Hasher();
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { throw normalise(e); } };
  return {
    stat: statFacts,
    mkdirp: (dir) => wrap(async () => { await fsp.mkdir(dir, { recursive: true }); }),
    move: (from, to) => wrap(() => helper.move(from, to)),
    copy: (from, to) => wrap(() => fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL)),
    flush: (file) => wrap(async () => { const h = await fsp.open(file, "r+"); try { await h.sync(); } finally { await h.close(); } }),
    hash: (file) => wrap(() => hasher.hash(file)),
    setCreated: (file, ms) => wrap(() => helper.setCreated(file, ms)),
    remove: (file) => wrap(() => fsp.unlink(file)),
    close() { helper.close(); hasher.close(); },
  };
}
