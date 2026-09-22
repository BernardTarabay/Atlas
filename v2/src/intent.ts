// What a person decided, kept apart from what Atlas worked out.
//
// Almost all of the database is derived: hashes, text, OCR, the plan, the search
// index - lose it and a rescan rebuilds it. A few things are not: which folders
// are roots (and their roles), and a folder or name someone chose by hand
// (files.pin / files.pinname). Those are written durably (Db.durable) and ALSO
// exported here, to <home>/intent/latest.json, so that losing the database is
// painful but recoverable and losing a decision is hard.
//
//   - written after every change (debounced), atomically: temp file, fsync, rename
//   - keyed by what survives a rebuild: root path + relative path, plus the NTFS
//     file ID and SHA-256 to find a file that has moved since
//   - an export never silently loses a decision: before latest.json is replaced
//     by one that drops or changes anything it recorded, the old one is kept in
//     intent/history/ (newest 50)
//   - an empty database (no roots) never overwrites an export
//
// importIntent() is the way back: it re-adds the roots, scans them, and
// re-attaches each decision to its file by path, then file ID, then SHA-256 when
// exactly one file matches. Anything ambiguous is reported, never guessed.
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db/db.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { addRoot } from "./roots.ts";
import { S } from "./pipeline/states.ts";
import { renameRetryingSync } from "./fsutil.ts";

export interface IntentRoot { path: string; role: string; enabled: boolean; volume: string | null; fs: string | null }
export interface IntentEntry {
  root: string; path: string; fid: string | null; sha: string | null; size: number;
  pin: string | null; pinname: string | null; missing?: true;
}
export interface IntentFile { format: "atlas-intent"; version: 1; written: string; roots: IntentRoot[]; files: IntentEntry[] }

const HISTORY_KEEP = 50;

/** Every decision in the database, in a stable order (so equal content is equal text). */
export function collectIntent(db: Db): Omit<IntentFile, "written"> {
  const roots = db.all<{ path: string; role: string; enabled: number; volume: string | null; fs: string | null }>(
    "SELECT path, role, enabled, volume, fs FROM roots ORDER BY path").map((r) => ({
    path: r.path, role: r.role, enabled: r.enabled === 1, volume: r.volume, fs: r.fs,
  }));
  const files = db.all<{ root: string; path: string; fid: string | null; sha: string | null; size: number; pin: string | null; pinname: string | null; state: number }>(
    `SELECT r.path AS root, f.path, f.fid, lower(hex(c.sha)) AS sha, f.size, f.pin, f.pinname, f.state
     FROM files f JOIN roots r ON r.id = f.root LEFT JOIN contents c ON c.id = f.content
     WHERE f.pin IS NOT NULL OR f.pinname IS NOT NULL
     ORDER BY r.path, f.path`).map((f) => ({
    root: f.root, path: f.path, fid: f.fid, sha: f.sha || null, size: f.size, pin: f.pin, pinname: f.pinname,
    ...(f.state === S.MISSING ? { missing: true as const } : {}),
  }));
  return { format: "atlas-intent", version: 1, roots, files };
}

/**
 * The decisions an export records, one key each, so that "does the new export
 * still say everything the old one said?" is a set difference. A folder and a
 * name are separate decisions: choosing a name for a file that already had a
 * folder loses nothing.
 */
function decisions(x: Pick<IntentFile, "roots" | "files">): Set<string> {
  const out = new Set<string>();
  for (const r of x.roots) out.add(`root\t${r.path.toLowerCase()}\t${r.role}\t${r.enabled}`);
  for (const f of x.files) {
    const at = `${f.root.toLowerCase()}\t${f.path}`;
    if (f.pin != null) out.add(`folder\t${at}\t${f.pin}`);
    if (f.pinname != null) out.add(`name\t${at}\t${f.pinname}`);
  }
  return out;
}

export function readIntent(file: string): IntentFile | null {
  try {
    const x = JSON.parse(fs.readFileSync(file, "utf8")) as IntentFile;
    return x && x.format === "atlas-intent" && x.version === 1 && Array.isArray(x.roots) && Array.isArray(x.files) ? x : null;
  } catch {
    return null;
  }
}

/** Write `text` to `file` so that a crash or power loss leaves either the old file or the new one, never half. */
function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameRetryingSync(tmp, file);
}

export class IntentExport {
  readonly dir: string;
  readonly latest: string;
  private db: Db;
  private timer: NodeJS.Timeout | null = null;
  private last = "";
  private warnedEmpty = false;

  constructor(db: Db, dir = path.join(config.home, "intent")) {
    this.db = db;
    this.dir = dir;
    this.latest = path.join(dir, "latest.json");
    const prev = readIntent(this.latest);
    if (prev) this.last = JSON.stringify({ roots: prev.roots, files: prev.files });
  }

  /** Something a person decided may have changed: export soon (changes in a burst are written once). */
  changed(delayMs = 2000) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.write(); }, delayMs);
    this.timer.unref();
  }

  /** Write now if a write is waiting (shutdown). */
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  /**
   * Export the current decisions. Returns what happened, for the log and the CLI.
   * Never throws: a failed export is logged and tried again on the next change.
   */
  write(): "written" | "unchanged" | "empty" | "failed" {
    try {
      const now = collectIntent(this.db);
      if (!now.roots.length) {
        // A database with no roots is new or lost. Its export would say "nothing was
        // ever decided" - exactly the file that must not be overwritten.
        if (!this.warnedEmpty) log.warn("intent export skipped: the database has no roots", { keeping: this.latest });
        this.warnedEmpty = true;
        return "empty";
      }
      const body = JSON.stringify({ roots: now.roots, files: now.files });
      if (body === this.last) return "unchanged";
      fs.mkdirSync(this.dir, { recursive: true });
      const prev = readIntent(this.latest);
      if (prev) {
        const kept = decisions(now);
        const lost = [...decisions(prev)].filter((d) => !kept.has(d)).length;
        if (lost) this.keep(prev, lost);
      }
      const file: IntentFile = { ...now, written: new Date().toISOString() };
      writeAtomic(this.latest, JSON.stringify(file, null, 1) + "\n");
      this.last = body;
      return "written";
    } catch (e) {
      log.error("intent export failed", { error: (e as Error).message });
      return "failed";
    }
  }

  /** The export about to be replaced dropped or changed something: keep it. */
  private keep(prev: IntentFile, lost: number) {
    const hist = path.join(this.dir, "history");
    fs.mkdirSync(hist, { recursive: true });
    const name = `intent-${(prev.written ?? new Date().toISOString()).replace(/[:.]/g, "-")}.json`;
    fs.copyFileSync(this.latest, path.join(hist, name));
    log.info("intent export: previous version kept", { file: name, decisionsNotInNew: lost });
    const all = fs.readdirSync(hist).filter((n) => /^intent-.*\.json$/.test(n)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) fs.rmSync(path.join(hist, old), { force: true });
  }
}

export interface ImportReport {
  roots: { added: string[]; present: string[]; updated: string[]; skipped: { path: string; reason: string }[] };
  files: {
    byPath: number; byFileId: number; bySha: number; already: number;
    conflicts: { entry: string; kept: string }[];
    ambiguous: string[];
    unmatched: string[];
    /** exact mode: choices removed because the export does not have them. */
    cleared: number;
  };
}

/**
 * Re-attach exported decisions to this database. Idempotent: running it twice
 * changes nothing the second time. Must run with the engine stopped: it writes
 * to the database.
 *
 * merge (default)  a decision is only placed on a file that has none of its own:
 *                  the database's own, being newer, wins (reported as a conflict).
 *                  For a fresh or rebuilt database.
 * exact            the export is the truth - the database was restored from a
 *                  backup OLDER than the export. Choices are set exactly as
 *                  exported, and a choice the export does not have is removed
 *                  (within the export's roots; never on a file an ambiguous
 *                  entry might mean). Roots get the exported role and state.
 */
export async function importIntent(db: Db, x: IntentFile, scan: (rootId: number) => Promise<unknown>, opts: { exact?: boolean } = {}): Promise<ImportReport> {
  const exactMode = opts.exact === true;
  const report: ImportReport = {
    roots: { added: [], present: [], updated: [], skipped: [] },
    files: { byPath: 0, byFileId: 0, bySha: 0, already: 0, conflicts: [], ambiguous: [], unmatched: [], cleared: 0 },
  };
  const rootByPath = db.q("SELECT id, role, enabled FROM roots WHERE path = ?");

  // Roots first, and scanned, so their files exist to attach decisions to.
  for (const r of x.roots) {
    const have = rootByPath.get(r.path) as { id: number; role: string; enabled: number } | undefined;
    if (have) {
      report.roots.present.push(r.path);
      if (exactMode && (have.role !== r.role || (have.enabled === 1) !== r.enabled)) {
        db.durable(() => {
          db.run("UPDATE roots SET role = ?, enabled = ? WHERE id = ?", r.role, r.enabled ? 1 : 0, have.id);
          if (have.role !== r.role) db.run(`UPDATE files SET state = ${S.IDENT} WHERE root = ? AND state = ${S.DONE}`, have.id);
        });
        report.roots.updated.push(r.path);
      }
      continue;
    }
    try {
      const id = db.durable(() => {
        const id = addRoot(db, r.path, r.role);
        if (!r.enabled) db.run("UPDATE roots SET enabled = 0 WHERE id = ?", id);
        return id;
      });
      report.roots.added.push(r.path);
      await scan(id);
    } catch (e) {
      report.roots.skipped.push({ path: r.path, reason: (e as Error).message });
    }
  }

  const exact = db.q(`SELECT f.id, f.pin, f.pinname FROM files f JOIN roots r ON r.id = f.root WHERE r.path = ? AND f.path = ? AND f.state <> ${S.MISSING}`);
  const exactMissing = db.q(`SELECT f.id, f.pin, f.pinname FROM files f JOIN roots r ON r.id = f.root WHERE r.path = ? AND f.path = ? AND f.state = ${S.MISSING}`);
  const byFid = db.q(`SELECT id, pin, pinname FROM files WHERE fid = ? AND state <> ${S.MISSING}`);
  const bySha = db.q(`SELECT f.id, f.pin, f.pinname FROM files f JOIN contents c ON c.id = f.content WHERE c.sha = ? AND f.state <> ${S.MISSING}`);
  const set = db.q(
    `UPDATE files SET pin = coalesce(pin, ?), pinname = coalesce(pinname, ?),
       state = CASE WHEN state = ${S.DONE} THEN ${S.IDENT} ELSE state END WHERE id = ?`);
  const setExact = db.q(
    `UPDATE files SET pin = ?, pinname = ?, state = CASE WHEN state = ${S.DONE} THEN ${S.IDENT} ELSE state END WHERE id = ?`);
  type Target = { id: number; pin: string | null; pinname: string | null };
  const matched = new Set<number>();   // rows the export speaks about
  const unsure = new Set<number>();    // rows an ambiguous entry might mean: never cleared

  db.durable(() => {
    for (const e of x.files) {
      const label = `${e.root} › ${e.path}`;
      let targets = exact.all(e.root, e.path) as unknown as Target[];
      let how: "byPath" | "byFileId" | "bySha" = "byPath";
      // A file ID names one physical file; several rows are its hard-linked names.
      if (!targets.length && e.fid) { targets = byFid.all(e.fid) as unknown as Target[]; how = "byFileId"; }
      if (!targets.length && e.sha) {
        // The same bytes are not the same document: only a single match is trusted.
        const same = bySha.all(Buffer.from(e.sha, "hex")) as unknown as Target[];
        if (same.length > 1) {
          report.files.ambiguous.push(`${label} (${same.length} files have these exact bytes)`);
          for (const t of same) unsure.add(t.id);
          continue;
        }
        targets = same;
        how = "bySha";
      }
      // Last: the same path, with the file missing right now. It may come back, and a
      // scan carries the choice to it if it turns up elsewhere (scanner adoptKnown).
      if (!targets.length) { targets = exactMissing.all(e.root, e.path) as unknown as Target[]; how = "byPath"; }
      if (!targets.length) { report.files.unmatched.push(label); continue; }
      let attached = false;
      for (const t of targets) matched.add(t.id);
      if (exactMode) {
        for (const t of targets) {
          if (t.pin === e.pin && t.pinname === e.pinname) continue;
          setExact.run(e.pin, e.pinname, t.id);
          attached = true;
        }
        if (attached) report.files[how]++;
        else report.files.already++;
        continue;
      }
      for (const t of targets) {
        const clash = (e.pin && t.pin && t.pin !== e.pin) || (e.pinname && t.pinname && t.pinname !== e.pinname);
        if (clash) report.files.conflicts.push({ entry: label, kept: `${t.pin ?? ""}/${t.pinname ?? ""}` });
        const adds = (e.pin && !t.pin) || (e.pinname && !t.pinname);
        if (adds) { set.run(e.pin, e.pinname, t.id); attached = true; }
      }
      if (attached) report.files[how]++;
      else report.files.already++;
    }
    if (exactMode) {
      // A choice the export does not have was made before the backup and undone after it.
      const roots = x.roots.map((r) => r.path);
      const holders = db.all<{ id: number }>(
        `SELECT f.id FROM files f JOIN roots r ON r.id = f.root
         WHERE (f.pin IS NOT NULL OR f.pinname IS NOT NULL) AND r.path IN (SELECT value FROM json_each(?))`, JSON.stringify(roots));
      for (const h of holders) {
        if (matched.has(h.id) || unsure.has(h.id)) continue;
        setExact.run(null, null, h.id);
        report.files.cleared++;
      }
    }
  });
  return report;
}
