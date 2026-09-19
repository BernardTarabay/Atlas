// JSON-lines log, one file per day, 14 days kept. Deliberately sparse: the engine
// logs runs, scans, errors and state changes -- never one line per file.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

type Level = "debug" | "info" | "warn" | "error";
const dir = path.join(config.home, "logs");
let day = "";
let fd = -1;
const toConsole = !config.hosted;
const minLevel: Level = (process.env.ATLAS_LOG_LEVEL as Level) || "info";
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function file(): number {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    if (fd >= 0) fs.closeSync(fd);
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(path.join(dir, `atlas-${today}.log`), "a");
    day = today;
    prune();
  }
  return fd;
}

function prune() {
  const cutoff = Date.now() - 14 * 86400_000;
  for (const name of fs.readdirSync(dir)) {
    const m = /^atlas-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
    if (m && Date.parse(m[1]) < cutoff) fs.rmSync(path.join(dir, name), { force: true });
  }
}

function write(level: Level, msg: string, data?: Record<string, unknown>) {
  if (order[level] < order[minLevel]) return;
  const rec = { t: new Date().toISOString(), level, msg, ...data };
  const line = JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  try { fs.writeSync(file(), line + "\n"); } catch { /* logging must never take the engine down */ }
  if (toConsole) process.stderr.write(`${rec.t.slice(11, 19)} ${level.padEnd(5)} ${msg}${data ? " " + JSON.stringify(data) : ""}\n`);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => write("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => write("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write("error", msg, data),
};
