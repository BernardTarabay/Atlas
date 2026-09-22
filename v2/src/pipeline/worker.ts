// Analysis worker thread: read a file ONCE, hash it, and -- only if the main
// thread says the content is new -- analyze it from the same buffer.
//
//   main -> worker  { t: "job", ...Job }
//   worker -> main  { t: "progress", id, bytes }    while reading, at most once a second
//   worker -> main  { t: "hash", id, sha }          after the full read
//   main -> worker  { t: "go", id, extract }        extract=false for known content
//   worker -> main  { t: "done", id, sha, a?, index? } | { t: "err", id, code, message }
import { parentPort } from "node:worker_threads";
import crypto from "node:crypto";
import fs from "node:fs";
import { analyze } from "../analyze/analyze.ts";
import { indexText } from "../search/text.ts";
import { sniff } from "../analyze/sniff.ts";

export interface Job {
  id: number;
  /** The row this job is about, so a late result can never land on another file. */
  root: number;
  rel: string;
  abs: string;
  size: number;
  ext: string;
  wholeFileBytes: number;
  maxParseBytes: number;
  maxTextChars: number;
  /** Files modified less than this long ago are left to settle before they are read. */
  settleMs: number;
}

const port = parentPort!;
const HEAD = 64 * 1024;
const CHUNK = 4 * 1024 * 1024;
let chunk: Buffer | null = null;
const decisions = new Map<number, (extract: boolean) => void>();

port.on("message", (m: { t: string; id: number; extract?: boolean } & Job) => {
  if (m.t === "go") {
    decisions.get(m.id)?.(Boolean(m.extract));
    decisions.delete(m.id);
  } else if (m.t === "job") {
    run(m).catch((e: NodeJS.ErrnoException) => port.postMessage({ t: "err", id: m.id, code: e.code ?? "ERR", message: String(e.message).slice(0, 300) }));
  }
});

/**
 * Tell the pool the read is still moving. Reading has no deadline (a big file on a
 * slow disk is not a hung parser); what the pool watches for is a read that STOPS.
 */
let lastProgress = 0;
function progress(id: number, bytes: number) {
  const now = Date.now();
  if (now - lastProgress < 1000) return;
  lastProgress = now;
  port.postMessage({ t: "progress", id, bytes });
}

/** Fill `buf` from the file, in CHUNK-sized reads so a slow disk still shows progress. */
function readInto(fd: number, buf: Buffer, len: number, onRead: (n: number) => void): number {
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, buf, off, Math.min(CHUNK, len - off), null);
    if (n === 0) break;
    off += n;
    onRead(n);
  }
  return off;
}

/**
 * Read the whole file a second time (large documents: the hash pass streamed it)
 * and prove it is still the version that was hashed. Otherwise the analysis would
 * describe other bytes, filed under this content's SHA-256 for good.
 */
function readAgain(abs: string, size: number, mtimeMs: number): Buffer {
  const fd = fs.openSync(abs, "r");
  try {
    const a = fs.fstatSync(fd);
    const buf = Buffer.allocUnsafeSlow(size);
    const n = a.size === size && a.mtimeMs === mtimeMs ? readInto(fd, buf, size, () => {}) : -1;
    const b = fs.fstatSync(fd);
    if (n !== size || b.size !== size || b.mtimeMs !== mtimeMs) {
      const e = new Error("the file changed between reading and analysing it") as NodeJS.ErrnoException;
      e.code = "UNSTABLE";
      throw e;
    }
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

async function run(job: Job) {
  const hash = crypto.createHash("sha256");
  let whole: Buffer | null = null;
  let head: Buffer;
  const fd = fs.openSync(job.abs, "r");
  // The size and time that matter are the ones of the open file NOW, not what the
  // scan recorded: the file may have changed since, and a directory listing can be
  // stale (NTFS updates only the entry of the hard link that was written through).
  const before = fs.fstatSync(fd);
  const size = before.size;
  // Modified seconds ago: most likely still being written (a copy in progress, a
  // download, an editor saving). Reading it now would hash a version that is about
  // to change. Come back shortly - without having read a byte.
  const age = Date.now() - before.mtimeMs;
  if (age >= -5_000 && age < job.settleMs) {
    fs.closeSync(fd);
    const e = new Error("modified moments ago; waiting for it to settle") as NodeJS.ErrnoException;
    e.code = "SETTLING";
    throw e;
  }
  let read = 0;
  const onRead = (n: number) => { read += n; progress(job.id, read); };
  try {
    if (size <= job.wholeFileBytes) {
      whole = Buffer.allocUnsafeSlow(size);
      const n = readInto(fd, whole, size, onRead);
      if (n !== size) whole = whole.subarray(0, n);
      hash.update(whole);
      head = whole.subarray(0, HEAD);
    } else {
      chunk ??= Buffer.allocUnsafeSlow(CHUNK);
      head = Buffer.alloc(0);
      for (;;) {
        const n = readInto(fd, chunk, CHUNK, onRead);
        if (n === 0) break;
        if (head.length === 0) head = Buffer.from(chunk.subarray(0, Math.min(n, HEAD)));
        hash.update(n === CHUNK ? chunk : chunk.subarray(0, n));
        if (n < CHUNK) break;
      }
    }
    // Written to while we read it: the hash describes no real version of the file.
    const after = fs.fstatSync(fd);
    if (after.size !== size || after.mtimeMs !== before.mtimeMs) {
      const e = new Error("the file changed while it was being read") as NodeJS.ErrnoException;
      e.code = "UNSTABLE";
      throw e;
    }
  } finally {
    fs.closeSync(fd);
  }
  const sha = hash.digest();
  const actual = { size, mtime: Math.floor(before.mtimeMs) };
  port.postMessage({ t: "hash", id: job.id, sha });
  const extract = await new Promise<boolean>((resolve) => decisions.set(job.id, resolve));
  if (!extract) {
    port.postMessage({ t: "done", id: job.id, sha, actual });
    return;
  }
  // Too large to have been held: parse formats that need the whole file (PDF, Office) with a
  // second read -- it comes from the OS cache, which the hashing pass just filled.
  if (!whole && size <= job.maxParseBytes) {
    const k = sniff(head, job.ext).kind;
    if (k === "pdf" || k === "doc" || k === "sheet" || k === "slides") whole = readAgain(job.abs, size, before.mtimeMs);
  }
  const a = await analyze(whole, head, job.ext, size, job.maxTextChars);
  const index = a.text && a.quality === "ok" ? indexText(`${a.title ?? ""}\n${(a.meta?.heading as string) ?? ""}\n${a.text}`) : "";
  port.postMessage({ t: "done", id: job.id, sha, actual, a, index });
}
