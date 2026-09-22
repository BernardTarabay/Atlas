// Directory enumeration. Primary: bin/atlas-walk.exe (bulk directory reads with
// attributes and file IDs, ~135k files/s warm). Fallback: an async Node walk
// (~70k files/s warm, no Windows attributes) for when the helper is missing or
// blocked. Both are streaming and handle errors per directory.
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { config } from "../config.ts";

export interface Entry {
  path: string;   // relative to root, '/' separated
  size: number;
  mtime: number;
  ctime: number;
  attrs: number;
  fid: string | null;
}

export interface WalkResult {
  volume: string | null;
  fs: string | null;
  files: number;
  dirs: number;
  errors: { dir: string; code: string }[];
  /** false = the walk did not finish; nothing may be concluded about files it did not report. */
  complete: boolean;
  /** the root itself could not be opened (drive gone, permissions) */
  rootMissing: boolean;
  /** the walk was stopped before listing anything: `onVolume` said this is not the expected disk */
  refused?: boolean;
  /** the walk was stopped because it produced nothing for `stallMs` (a hung share) */
  stalled?: boolean;
}

export interface WalkOptions {
  /**
   * Called with the volume serial and filesystem BEFORE any entry is reported.
   * Returning false stops the walk: nothing at all is listed from a disk that is
   * not the one this root was.
   */
  onVolume?: (volume: string | null, fsName: string | null) => boolean;
  /** Give up on a listing that produces nothing for this long (native walker only). */
  stallMs?: number;
}

const SKIP_FILES = new Set(["desktop.ini", "thumbs.db", "ehthumbs.db", ".ds_store", ".localized"]);
const skipFile = (name: string) => SKIP_FILES.has(name.toLowerCase()) || name.startsWith("~$");

/** File IDs are only stable on NTFS/ReFS; on FAT/exFAT they are positions, not identities. */
const stableIds = (fsName: string | null) => fsName === "NTFS" || fsName === "ReFS";

export async function walk(root: string, onBatch: (entries: Entry[]) => void, batchSize = 2000, opts: WalkOptions = {}): Promise<WalkResult> {
  if (process.platform === "win32" && fs.existsSync(config.walkerExe)) return walkNative(root, onBatch, batchSize, opts);
  return walkNode(root, onBatch, batchSize, opts);
}

/** "4043c450": the volume serial as the native walker prints it, from a Node stat. */
export const serialOf = (dev: bigint | number) => BigInt(dev).toString(16).padStart(8, "0");

function walkNative(root: string, onBatch: (e: Entry[]) => void, batchSize: number, opts: WalkOptions): Promise<WalkResult> {
  return new Promise((resolve, reject) => {
    const args = [root];
    for (const d of config.excludeDirs) args.push("--exclude", d);
    const child = spawn(config.walkerExe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const res: WalkResult = { volume: null, fs: null, files: 0, dirs: 0, errors: [], complete: false, rootMissing: false };
    let dir = "";
    let batch: Entry[] = [];
    let ids = true;
    let stderr = "";
    let stopped = false;
    // A listing of a share whose server stopped answering can block for a very long
    // time; every other root's scan waits behind it. Silence for stallMs ends it, as
    // an incomplete walk - from which nothing is concluded.
    let lastOutput = Date.now();
    let settled = false;
    /** Stop listening and report now: a process stuck in I/O on a dead share may take long to die. */
    const stop = () => {
      stopped = true;
      child.kill();
      if (watchdog) clearInterval(watchdog);
      if (settled) return;
      settled = true;
      res.complete = false;
      if (res.stalled) res.errors.push({ dir: "", code: "the listing stopped responding" });
      resolve(res);
    };
    const watchdog = opts.stallMs ? setInterval(() => {
      if (Date.now() - lastOutput > opts.stallMs!) { res.stalled = true; stop(); }
    }, Math.min(5000, opts.stallMs)) : null;
    child.stderr.on("data", (d) => { stderr += d; });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      lastOutput = Date.now();
      if (stopped) return;
      const t = line.charCodeAt(0);
      if (t === 70 /* F */) {
        const p = line.split("\t");
        const name = p[1];
        if (skipFile(name)) return;
        batch.push({
          path: dir ? `${dir}/${name}` : name,
          size: Number(p[2]),
          mtime: Number(p[3]),
          ctime: Number(p[4]),
          attrs: Number(p[5]),
          fid: ids && res.volume ? `${res.volume}:${p[6]}` : null,
        });
        res.files++;
        if (batch.length >= batchSize) { onBatch(batch); batch = []; }
      } else if (t === 68 /* D */) {
        dir = line.slice(2).replaceAll("\\", "/");
        res.dirs++;
      } else if (t === 69 /* E */) {
        const [, d, code] = line.split("\t");
        if (d === "") res.rootMissing = true;
        else res.errors.push({ dir: d.replaceAll("\\", "/"), code });
      } else if (t === 86 /* V */) {
        const [, vol, fsName] = line.split("\t");
        res.volume = vol;
        res.fs = fsName;
        ids = stableIds(fsName);
        if (opts.onVolume && !opts.onVolume(vol || null, fsName || null)) { res.refused = true; stop(); }
      } else if (t === 90 /* Z */) {
        res.complete = true;
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (watchdog) clearInterval(watchdog);
      rl.close();
      if (settled) return;
      settled = true;
      if (batch.length) onBatch(batch);
      if (code === 2) res.rootMissing = true;
      if (code !== 0) res.complete = false;
      if (code !== 0 && code !== 2 && stderr) res.errors.push({ dir: "", code: `walker exit ${code}: ${stderr.trim()}` });
      resolve(res);
    });
  });
}

async function walkNode(root: string, onBatch: (e: Entry[]) => void, batchSize: number, opts: WalkOptions): Promise<WalkResult> {
  const res: WalkResult = { volume: null, fs: null, files: 0, dirs: 0, errors: [], complete: false, rootMissing: false };
  try {
    const st = await fsp.stat(root, { bigint: true });
    res.volume = serialOf(st.dev);
  } catch {
    res.rootMissing = true;
    return res;
  }
  if (opts.onVolume && !opts.onVolume(res.volume, null)) { res.refused = true; return res; }
  const exclude = new Set(config.excludeDirs.map((d) => d.toLowerCase()));
  const queue: string[] = [""];
  let batch: Entry[] = [];
  let active = 0;
  await new Promise<void>((done) => {
    const pump = () => {
      while (active < 64 && queue.length) {
        const rel = queue.pop()!;
        active++;
        const abs = rel ? path.join(root, rel) : root;
        fsp.readdir(abs, { withFileTypes: true })
          .then(async (ents) => {
            res.dirs++;
            await Promise.all(ents.map(async (e) => {
              const r = rel ? `${rel}/${e.name}` : e.name;
              if (e.isDirectory()) { if (!exclude.has(e.name.toLowerCase())) queue.push(r); return; }
              if (!e.isFile() || skipFile(e.name)) return;
              try {
                const s = await fsp.stat(path.join(abs, e.name), { bigint: true });
                // No attributes without the helper: a large file occupying no blocks is
                // how a dehydrated cloud placeholder looks from stat.
                const placeholder = s.size >= 1048576n && s.blocks === 0n;
                // No file ID either: without the filesystem's name there is no telling a
                // stable NTFS ID from a FAT position that a new file may reuse.
                batch.push({
                  path: r, size: Number(s.size), mtime: Number(s.mtimeMs), ctime: Number(s.birthtimeMs),
                  attrs: placeholder ? 0x400000 : 0, fid: null,
                });
                res.files++;
                if (batch.length >= batchSize) { onBatch(batch); batch = []; }
                // A file that cannot be stat'ed is still there: its FOLDER is reported as not
                // fully listed, so nothing in it is concluded to be gone.
              } catch (err) { res.errors.push({ dir: rel, code: (err as NodeJS.ErrnoException).code ?? "ERR" }); }
            }));
          }, (err: NodeJS.ErrnoException) => { res.errors.push({ dir: rel, code: err.code ?? "ERR" }); })
          .finally(() => {
            active--;
            if (!queue.length && active === 0) done(); else pump();
          });
      }
    };
    pump();
  });
  if (batch.length) onBatch(batch);
  res.complete = true;
  return res;
}
