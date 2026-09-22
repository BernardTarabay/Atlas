// Keeping the database trustworthy, and a way back when it is not.
//
// INTEGRITY  PRAGMA quick_check at startup, on a worker thread with its own read-only
//            connection (measured 0.8 s warm / 3.5 s cold on a 281 MB database: too
//            long to block startup, fine in the background). quick_check verifies
//            every page and every row's format but not that indexes match their
//            tables; the full integrity_check does, and runs on every backup copy
//            and on demand (`npm run db -- check`).
//            A failure is not repaired automatically. Atlas stops changing the
//            database (the engine stops, the plan/root routes refuse with 503), keeps
//            serving what it can, and says so on the Status page, with the way back.
//
// BACKUPS    Every `backupHours`: VACUUM INTO a new file from a read-only connection
//            (a consistent snapshot while Atlas keeps writing; a single compact file),
//            then integrity_check the COPY. Only a verified copy is kept, as
//            atlas-YYYYMMDD-HHMMSSZ.db; the newest `backupKeep` are retained. A
//            source that fails its check is never copied, so a damaged database can
//            never push a good backup out of the rotation. Nothing here writes to the
//            live database.
//
// RESTORE    restoreBackup(), for scripts/db.ts with Atlas stopped: verify the
//            backup, move the current database files aside (never deleted), copy the
//            backup in, open it (migrations bring an older one forward).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { Db } from "./db.ts";
import { MIGRATIONS } from "./schema.ts";
import { renameRetrying } from "../fsutil.ts";
import { runSanity, saveReport, latestReport, type SanityReport } from "./sanity.ts";

export interface CheckResult { ok: boolean; detail: string[]; ms: number }
export interface BackupInfo { file: string; at: number; bytes: number }
interface Reply { ok: boolean; detail: string[]; ms: number; stage?: "source" | "copy"; schema?: number | null }

const NAME = /^atlas-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z\.db$/;
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15) + "Z";

function work(job: { op: "check" | "backup"; file: string; full?: boolean; out?: string }): Promise<Reply> {
  return new Promise((resolve) => {
    const w = new Worker(new URL("./maint-worker.ts", import.meta.url), { workerData: job });
    w.once("message", (m: Reply) => resolve(m));
    w.once("error", (e) => resolve({ ok: false, detail: [e.message], ms: 0, stage: "copy" }));
    w.once("exit", (code) => resolve({ ok: false, detail: [`maintenance worker exited (${code})`], ms: 0, stage: "copy" }));
  });
}

/** quick_check (or the full integrity_check) of a database file, off the main thread. */
export async function checkDatabase(file: string, full = false): Promise<CheckResult> {
  const r = await work({ op: "check", file, full });
  return { ok: r.ok, detail: r.detail, ms: r.ms };
}

/** Verified backups in `dir`, newest first. */
export function listBackups(dir = config.backupDir): BackupInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: BackupInfo[] = [];
  for (const n of names) {
    const m = NAME.exec(n);
    if (!m) continue;
    const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    try { out.push({ file: path.join(dir, n), at, bytes: fs.statSync(path.join(dir, n)).size }); } catch { /* gone meanwhile */ }
  }
  return out.sort((a, b) => b.at - a.at);
}

export type BackupResult =
  | { ok: true; backup: BackupInfo; removed: string[]; ms: number }
  | { ok: false; stage: "source" | "copy" | "space"; detail: string[] };

/** One verified backup of `file` into `dir`, then rotation to the newest `keep`. */
export async function makeBackup(file: string, dir = config.backupDir, keep = config.backupKeep): Promise<BackupResult> {
  fs.mkdirSync(dir, { recursive: true });
  // Room for the copy, with a margin: a backup must never be what fills the disk.
  const size = ["", "-wal"].reduce((s, x) => { try { return s + fs.statSync(file + x).size; } catch { return s; } }, 0);
  const fsInfo = fs.statfsSync(dir);
  const free = Number(fsInfo.bavail) * Number(fsInfo.bsize);
  const need = Math.round(size * 1.1) + 64 * 1024 * 1024;
  if (free < need) return { ok: false, stage: "space", detail: [`${Math.round(free / 1048576)} MB free in ${dir}, ${Math.round(need / 1048576)} MB needed`] };
  const at = Date.now();
  const final = path.join(dir, `atlas-${stamp(at)}.db`);
  const part = `${final}.part`;
  fs.rmSync(part, { force: true });
  const r = await work({ op: "backup", file, out: part });
  if (!r.ok) {
    fs.rmSync(part, { force: true });
    return { ok: false, stage: r.stage ?? "copy", detail: r.detail };
  }
  await renameRetrying(part, final);
  const all = listBackups(dir);
  const removed: string[] = [];
  for (const old of all.slice(keep)) {
    try { fs.rmSync(old.file); removed.push(old.file); } catch (e) { log.warn("could not remove an old backup", { file: old.file, error: (e as Error).message }); }
  }
  return { ok: true, backup: { file: final, at, bytes: fs.statSync(final).size }, removed, ms: r.ms };
}

export interface Health {
  integrity: "checking" | "ok" | "failed";
  detail: string[];
  checkedAt: number;
  backup: { last: BackupInfo | null; count: number; running: boolean; error: string | null; dir: string };
  /** The last sanity check (db/sanity.ts): its headline counts. */
  sanity: { at: number | null; running: boolean; errors: number; warnings: number; infos: number; error: string | null };
}

export class Maintenance {
  readonly health: Health;
  private timers: NodeJS.Timeout[] = [];
  private file: string;
  private onCorrupt: (detail: string[]) => void;
  private reported = false;

  constructor(file: string, onCorrupt: (detail: string[]) => void) {
    this.file = file;
    this.onCorrupt = onCorrupt;
    const all = listBackups();
    const last = latestReport();
    this.health = {
      integrity: "checking", detail: [], checkedAt: 0,
      backup: { last: all[0] ?? null, count: all.length, running: false, error: null, dir: config.backupDir },
      sanity: { at: last?.at ?? null, running: false, errors: last?.errors ?? 0, warnings: last?.warnings ?? 0, infos: last?.infos ?? 0, error: null },
    };
  }

  /** The startup check now; backups from a few minutes after startup, then whenever one is due. */
  start() {
    // A crash in the middle of a backup leaves its .part behind: never a backup, safe to remove.
    try {
      for (const n of fs.readdirSync(config.backupDir)) if (/^atlas-.*\.db\.part$/.test(n)) fs.rmSync(path.join(config.backupDir, n), { force: true });
    } catch { /* no backup folder yet */ }
    void this.check();
    // Backup, then the sanity check, each when due: a day since the last one.
    const due = () => void this.maybeBackup().then(() => this.maybeSanity());
    const first = setTimeout(due, 3 * 60_000);
    const every = setInterval(due, 10 * 60_000);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  stop() { for (const t of this.timers) clearTimeout(t); }

  async check(): Promise<CheckResult> {
    this.health.integrity = "checking";
    const r = await checkDatabase(this.file);
    this.health.checkedAt = Date.now();
    if (r.ok) {
      this.health.integrity = "ok";
      this.health.detail = [];
      log.info("database integrity checked", { ms: r.ms });
    } else this.corrupt(r.detail);
    return r;
  }

  private corrupt(detail: string[]) {
    this.health.integrity = "failed";
    this.health.detail = detail;
    log.error("the database failed its integrity check", { detail: detail.slice(0, 10) });
    if (!this.reported) { this.reported = true; this.onCorrupt(detail); }
  }

  /** A backup if one is due (or `force`), unless the database is not known to be sound. */
  async maybeBackup(force = false): Promise<BackupResult | null> {
    const b = this.health.backup;
    if (b.running || this.health.integrity !== "ok") return null;
    const last = listBackups()[0];
    if (!force && last && Date.now() - last.at < config.backupHours * 3_600_000) return null;
    b.running = true;
    try {
      const r = await makeBackup(this.file);
      const all = listBackups();
      b.last = all[0] ?? null;
      b.count = all.length;
      if (r.ok) {
        b.error = null;
        log.info("database backed up", { file: r.backup.file, mb: Math.round(r.backup.bytes / 1048576), ms: r.ms, removed: r.removed.length });
      } else if (r.stage === "source") {
        b.error = "the database failed its check, so it was not copied";
        this.corrupt(r.detail);
      } else {
        b.error = r.detail.join("; ");
        log.error("backup failed", { stage: r.stage, detail: r.detail });
      }
      return r;
    } finally {
      b.running = false;
    }
  }

  /**
   * The sanity check if one is due (a day since the last) or `force`d. Report-only;
   * skipped while the database is not known to be sound (the integrity alarm is
   * already the finding that matters).
   */
  async maybeSanity(force = false): Promise<SanityReport | null> {
    const h = this.health.sanity;
    if (h.running || this.health.integrity !== "ok") return null;
    if (!force && h.at && Date.now() - h.at < 24 * 3_600_000) return null;
    h.running = true;
    try {
      const r = await runSanity(this.file);
      saveReport(r);
      Object.assign(h, { at: r.at, errors: r.errors, warnings: r.warnings, infos: r.infos, error: null });
      const log_ = r.errors ? log.error : r.warnings ? log.warn : log.info;
      log_("sanity check", { ms: r.ms, errors: r.errors, warnings: r.warnings, notes: r.infos,
        findings: r.findings.filter((f) => f.level !== "info").map((f) => `${f.id}: ${f.count}`) });
      return r;
    } catch (e) {
      h.error = (e as Error).message;
      log.error("sanity check could not run", { error: h.error });
      return null;
    } finally {
      h.running = false;
    }
  }
}

export interface RestoreResult { restored: string; replacedDir: string | null; schema: number }

/**
 * Put a backup in place of the live database. Atlas must be stopped (the caller
 * checks). Verifies first, moves the current files aside rather than deleting
 * them, and puts them back if anything goes wrong before the copy is in place.
 */
export async function restoreBackup(backup: string, home = config.home): Promise<RestoreResult> {
  const v = await checkDatabase(backup, true);
  if (!v.ok) throw new Error(`the backup failed its integrity check: ${v.detail.slice(0, 3).join("; ")}`);
  const ro = new DatabaseSync(backup, { readOnly: true });
  const schema = Number((ro.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined)?.value ?? 0);
  ro.close();
  if (schema > MIGRATIONS.length) throw new Error(`the backup was made by a newer Atlas (schema ${schema}; this one knows ${MIGRATIONS.length})`);

  const live = path.join(home, "atlas.db");
  const present = [live, `${live}-wal`, `${live}-shm`].filter((f) => fs.existsSync(f));
  let replacedDir: string | null = null;
  const moved: [string, string][] = [];
  if (present.length) {
    replacedDir = path.join(home, `replaced-${stamp(Date.now())}`);
    fs.mkdirSync(replacedDir, { recursive: true });
    try {
      for (const f of present) {
        const to = path.join(replacedDir, path.basename(f));
        await renameRetrying(f, to);
        moved.push([f, to]);
      }
    } catch (e) {
      for (const [from, to] of moved.reverse()) await renameRetrying(to, from);
      throw new Error(`could not move the current database aside (is Atlas still running?): ${(e as Error).message}`);
    }
  }
  try {
    const tmp = `${live}.restoring`;
    fs.copyFileSync(backup, tmp);
    const fd = fs.openSync(tmp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    await renameRetrying(tmp, live);
  } catch (e) {
    fs.rmSync(`${live}.restoring`, { force: true });
    for (const [from, to] of moved.reverse()) await renameRetrying(to, from);
    throw new Error(`could not put the backup in place; the previous database is back: ${(e as Error).message}`);
  }
  // Opening it applies any migrations a backup from an older Atlas needs.
  const db = new Db(live);
  db.close();
  return { restored: live, replacedDir, schema };
}
