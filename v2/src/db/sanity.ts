// The sanity check: does the database agree with itself, with the disk, and with
// the rules of this codebase? Report-only. It never repairs anything: a repair made
// by a program that has just been shown to be wrong about something is how data
// gets lost. Each finding says what it means and what a person can do.
//
// The checks run on a worker thread with a read-only connection (sanity-worker.ts),
// so a large database or a slow disk never stalls the engine. The file re-hash is a
// bounded sample (count and bytes). Reports are kept in <home>/sanity/ (newest 30).
// Run daily after the backup (db/maintenance.ts), from the Status page, or with
// `npm run db -- sanity`.
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { config } from "../config.ts";
import type { Finding, SanityResult } from "./sanity-worker.ts";

export type { Finding } from "./sanity-worker.ts";
export interface SanityReport extends SanityResult {
  at: number;
  /** Counts by level: the headline. */
  errors: number; warnings: number; infos: number;
}

const KEEP = 30;
export const sanityDir = () => path.join(config.home, "sanity");

export function runSanity(file: string, sample = { files: 100, bytes: 512 * 1048576 }): Promise<SanityReport> {
  const at = Date.now();
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./sanity-worker.ts", import.meta.url), {
      workerData: { file, sampleFiles: sample.files, sampleBytes: sample.bytes, home: config.home, backupDir: config.backupDir },
    });
    let done = false;
    w.once("message", (r: SanityResult) => {
      done = true;
      const count = (l: Finding["level"]) => r.findings.filter((f) => f.level === l).length;
      resolve({ ...r, at, errors: count("error"), warnings: count("warn"), infos: count("info") });
    });
    w.once("error", (e) => { done = true; reject(e); });
    w.once("exit", (code) => { if (!done) reject(new Error(`sanity check stopped (${code})`)); });
  });
}

/** Keep a report (atomic write), and only the newest KEEP. */
export function saveReport(r: SanityReport, dir = sanityDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  const name = `report-${new Date(r.at).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}Z.json`;
  const file = path.join(dir, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 1));
  fs.renameSync(tmp, file);
  const all = fs.readdirSync(dir).filter((n) => /^report-.*Z\.json$/.test(n)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

export function latestReport(dir = sanityDir()): SanityReport | null {
  try {
    const all = fs.readdirSync(dir).filter((n) => /^report-.*Z\.json$/.test(n)).sort();
    return all.length ? (JSON.parse(fs.readFileSync(path.join(dir, all[all.length - 1]), "utf8")) as SanityReport) : null;
  } catch {
    return null;
  }
}

/** The report as text, for the command line. */
export function formatReport(r: SanityReport): string {
  const out = [`Sanity check ${new Date(r.at).toLocaleString()} (${r.ms} ms): ${r.errors} error(s), ${r.warnings} warning(s), ${r.infos} note(s).`,
    `${r.checked.length} checks. Re-read ${r.rehash.sampled} unchanged-looking files (${r.rehash.mb} MB): ${r.rehash.verified} match, ${r.rehash.skipped} skipped.`];
  const order = { error: 0, warn: 1, info: 2 } as const;
  for (const f of [...r.findings].sort((a, b) => order[a.level] - order[b.level])) {
    out.push("", `${f.level.toUpperCase().padEnd(5)} ${f.title}: ${f.count}`, `      ${f.fix}`);
    for (const s of f.samples) out.push(`        ${s}`);
  }
  if (!r.findings.length) out.push("", "Everything agrees.");
  return out.join("\n");
}
