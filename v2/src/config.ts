import os from "node:os";
import path from "node:path";

import fs from "node:fs";

const appDir = path.resolve(import.meta.dirname, "..");

/**
 * Secrets come from the environment, and for development from a .env beside the
 * app - which is gitignored, because an API key in a repository is a key that
 * has already leaked. Nothing here is ever sent to the browser.
 */
function loadEnvFile(): void {
  for (const file of [path.join(appDir, ".env"), path.join(process.env.ATLAS_HOME ?? "", ".env")]) {
    if (!file || !fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}
loadEnvFile();

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

const home = path.resolve(env.ATLAS_HOME ?? path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"), "AtlasDev"));

export const config = {
  appDir,
  /**
   * Where the database, logs, thumbnails and caches live. The service sets %ProgramData%\Atlas.
   * The development default is deliberately NOT inside the repo: the repo may sit in a
   * OneDrive-synced folder, and a live SQLite database must never be under a sync client.
   */
  home,
  port: num(env.ATLAS_PORT, 7717),
  /** Loopback only. Remote access arrives through `tailscale serve`, which also connects to loopback. */
  bindHost: "127.0.0.1",
  /** Started by bin/AtlasService.exe, which speaks the @@alive/@@awake protocol on stdout. */
  hosted: env.ATLAS_HOSTED === "1",
  /**
   * The directory lister. ATLAS_WALKER puts another one in its place - a .ts/.mjs file
   * is run with Node - which is how a listing that hangs, or a disk that answers wrongly,
   * is tested (test/faults.test.ts); nothing else should set it.
   */
  walkerExe: env.ATLAS_WALKER || path.join(appDir, "bin", "atlas-walk.exe"),
  uiDir: path.join(appDir, "ui"),

  /** Read-and-hash workers. Each holds at most `wholeFileBytes` in memory. */
  analyzeWorkers: num(env.ATLAS_WORKERS, Math.max(2, Math.min(6, os.availableParallelism() - 2))),
  /** Files up to this size are read into memory once and analyzed from that buffer. */
  wholeFileBytes: num(env.ATLAS_WHOLE_FILE_MB, 32) * 1024 * 1024,
  /** Documents larger than this are hashed but not parsed. */
  maxParseBytes: num(env.ATLAS_MAX_PARSE_MB, 256) * 1024 * 1024,
  /** Text kept per content for display/snippets; the index sees the same text. */
  maxTextChars: num(env.ATLAS_MAX_TEXT_CHARS, 1_000_000),
  /** Concurrent OCR engines (Windows OCR helpers). 0 disables OCR. */
  ocrWorkers: num(env.ATLAS_OCR_WORKERS, 2),
  /**
   * Analysis (parsing) of one file longer than this is a hung parser: the worker is
   * killed and the failure counts against the CONTENT. Reading and hashing have no
   * such deadline - a 40 GB video on a USB 2 disk takes as long as it takes.
   */
  jobTimeoutMs: num(env.ATLAS_JOB_TIMEOUT_S, 180) * 1000,
  /**
   * A file modified less than this long ago is probably still being written (a copy,
   * a download, a save): it is left to settle, unread, and tried again shortly.
   */
  settleMs: num(env.ATLAS_SETTLE_S, 10) * 1000,
  /** A read that makes no progress for this long is stuck (dead share, failing disk): an ACCESS failure. */
  stallTimeoutMs: num(env.ATLAS_STALL_S, 60) * 1000,
  maxTries: 3,

  rescanMinutes: num(env.ATLAS_RESCAN_MINUTES, 60),
  /** A directory listing that produces nothing for this long is stuck (a hung share): the scan is abandoned as incomplete. */
  scanStallMs: num(env.ATLAS_SCAN_STALL_S, 120) * 1000,

  /**
   * Database backups (src/db/maintenance.ts): a verified copy every `backupHours`,
   * the newest `backupKeep` kept. Each is about the size of the database, most of it
   * extracted text and OCR - rebuildable, but hours of work. Put `backupDir` on
   * another disk if there is one: a backup on the same disk survives corruption,
   * not a dead disk.
   */
  backupDir: path.resolve(env.ATLAS_BACKUP_DIR ?? path.join(home, "backups")),
  backupKeep: num(env.ATLAS_BACKUP_KEEP, 7),
  backupHours: num(env.ATLAS_BACKUP_HOURS, 24),
  /** Directory names never descended into, whatever root they appear under. */
  excludeDirs: [
    "$RECYCLE.BIN", "System Volume Information", ".git", ".svn", ".hg", "node_modules",
    "__pycache__", ".venv", "venv", ".tox", ".cache", ".atlas-quarantine", ".atlas-mirror",
  ],

  /**
   * The assistant. One call per message a person types - never per file, never
   * in the pipeline, never on a timer. Unset key = the assistant is simply off.
   */
  ai: {
    key: env.GEMINI_API_KEY ?? "",
    model: env.GEMINI_MODEL ?? "gemini-3.1-flash-lite",
    timeoutMs: num(env.GEMINI_TIMEOUT_MS, 30000),
  },
};

export type Config = typeof config;
