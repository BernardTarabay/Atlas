// The sanity check (src/db/sanity.ts), on its own thread with a READ-ONLY
// connection: it can look at everything and change nothing. Every check is a
// question with one right answer; a finding is the database, the disk and the
// rules of this codebase disagreeing.
//
//   error  a contradiction: a row pointing at nothing, a state that cannot happen,
//          a file whose bytes are not the ones on record. A bug in Atlas, or damage.
//   warn   needs a person: a folder offline for long, a stale backup, an export out
//          of date, names that would collide on disk.
//   info   housekeeping: space held by content nothing uses any more, leftovers.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { S, OCR, PLACEHOLDER_ATTRS } from "../pipeline/states.ts";
import { collectIntent, readIntent } from "../intent.ts";
import type { Db } from "./db.ts";

export type Level = "error" | "warn" | "info";
export interface Finding { id: string; level: Level; title: string; count: number; samples: string[]; fix: string }
export interface SanityResult {
  findings: Finding[];
  checked: string[];
  rehash: { sampled: number; verified: number; skipped: number; mb: number };
  ms: number;
}
interface Job { file: string; sampleFiles: number; sampleBytes: number; home: string; backupDir: string }

const job = workerData as Job;
const t0 = performance.now();
const db = new DatabaseSync(job.file, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");
const all = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).all(...a) as T[];
const one = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T;
const findings: Finding[] = [];
const checked: string[] = [];
const MAX_SAMPLES = 10;

/** A counted check: `sql` returns the count; `sampleSql` (optional) a few lines to show. */
function check(id: string, level: Level, title: string, fix: string, count: number, samples: () => string[] = () => []) {
  checked.push(id);
  if (count > 0) findings.push({ id, level, title, count, samples: samples().slice(0, MAX_SAMPLES), fix });
}
const n = (sql: string, ...a: (string | number)[]) => one<{ n: number }>(sql, ...a).n;
const paths = (sql: string, ...a: (string | number)[]) => all<{ p: string }>(sql, ...a).map((r) => r.p);
const where = `(SELECT path FROM roots WHERE id = f.root) || ' › ' || f.path`;
const BUG = "This should not happen. Nothing is lost: it is derived data. Keep this report and tell whoever maintains Atlas.";

// ---- the database itself -------------------------------------------------------
{
  const rows = all<Record<string, string>>("PRAGMA quick_check(10)").map((r) => String(Object.values(r)[0]));
  const ok = rows.length === 1 && rows[0] === "ok";
  check("integrity", "error", "The database failed its quick check", "Stop Atlas and run: npm run db -- restore", ok ? 0 : rows.length, () => rows);
}

// ---- rows that point at nothing ------------------------------------------------
check("orphan-files", "error", "Files belonging to a folder that is no longer registered", BUG,
  n("SELECT count(*) AS n FROM files WHERE root NOT IN (SELECT id FROM roots)"),
  () => paths("SELECT root || ' › ' || path AS p FROM files WHERE root NOT IN (SELECT id FROM roots) LIMIT 10"));
check("dangling-content", "error", "Files linked to content that does not exist", BUG,
  n("SELECT count(*) AS n FROM files WHERE content IS NOT NULL AND content NOT IN (SELECT id FROM contents)"),
  () => paths(`SELECT ${where} AS p FROM files f WHERE content IS NOT NULL AND content NOT IN (SELECT id FROM contents) LIMIT 10`));
check("text-orphans", "warn", "Extracted text kept for content that no longer exists",
  "Harmless to search results; space only. Nothing to do now.",
  n("SELECT count(*) AS n FROM texts WHERE content NOT IN (SELECT id FROM contents)"));
check("fts-text-orphans", "warn", "Search index entries for content that no longer exists",
  "Search can show nothing for them (hits are matched to files), but the index is larger than it should be.",
  n("SELECT count(*) AS n FROM (SELECT rowid FROM fts_text) WHERE rowid NOT IN (SELECT id FROM contents)"));
check("fts-name-orphans", "warn", "File-name index entries for files that no longer exist",
  "Search skips them (hits are matched to files), but the index is larger than it should be.",
  n("SELECT count(*) AS n FROM (SELECT rowid FROM fts_name) WHERE rowid NOT IN (SELECT id FROM files)"));

// ---- states that cannot happen ------------------------------------------------
check("missing-with-plan", "error", "Files marked missing that still hold a place in the library", BUG,
  n(`SELECT count(*) AS n FROM files WHERE state = ${S.MISSING} AND plan IS NOT NULL`),
  () => paths(`SELECT ${where} || ' → ' || plan AS p FROM files f WHERE state = ${S.MISSING} AND plan IS NOT NULL LIMIT 10`));
check("filed-unread", "error", "Files filed in the library without ever being read", BUG,
  n(`SELECT count(*) AS n FROM files WHERE state IN (${S.IDENT}, ${S.DONE}) AND content IS NULL AND (attrs & ${PLACEHOLDER_ATTRS}) = 0`),
  () => paths(`SELECT ${where} AS p FROM files f WHERE state IN (${S.IDENT}, ${S.DONE}) AND content IS NULL AND (attrs & ${PLACEHOLDER_ATTRS}) = 0 LIMIT 10`));
check("done-without-place", "error", "Planned files with no place and no reason (not a duplicate or alias)", BUG,
  n(`SELECT count(*) AS n FROM files WHERE state = ${S.DONE} AND plan IS NULL AND coalesce(rule, '') NOT IN ('duplicate', 'alias')`),
  () => paths(`SELECT ${where} AS p FROM files f WHERE state = ${S.DONE} AND plan IS NULL AND coalesce(rule, '') NOT IN ('duplicate', 'alias') LIMIT 10`));
check("plan-collision", "error", "Two files planned to the same place in the library", BUG,
  n("SELECT count(*) AS n FROM (SELECT plan FROM files WHERE plan IS NOT NULL GROUP BY plan HAVING count(*) > 1)"),
  () => paths("SELECT plan || ' (' || count(*) || ' files)' AS p FROM files WHERE plan IS NOT NULL GROUP BY plan HAVING count(*) > 1 LIMIT 10"));
check("representatives", "error", "Identical files with no copy, or more than one copy, in the library", BUG,
  n(`SELECT count(*) AS n FROM (SELECT content FROM files WHERE content IS NOT NULL AND state IN (${S.IDENT}, ${S.DONE})
      GROUP BY content HAVING sum(state <> ${S.DONE}) = 0 AND sum(plan IS NOT NULL) <> 1)`));
check("failed-unclassified", "warn", "Failed files without a kind of failure (content or access)",
  "They will not be retried automatically. Press \"Try again now\" on the Status page.",
  n(`SELECT count(*) AS n FROM files WHERE state = ${S.FAILED} AND fclass IS NULL`));
check("ops-open", "error", "File operations that were interrupted (Apply stopped mid-file)",
  "Do not move those files by hand. Stop Atlas and look: npm run apply -- list. They are reconciled before anything else is moved.",
  n("SELECT count(*) AS n FROM ops WHERE state = 1"),
  () => paths("SELECT src || ' → ' || dst AS p FROM ops WHERE state = 1 LIMIT 10"));
check("ops-review", "warn", "File operations waiting for a person (something changed on disk while they ran)",
  "See npm run apply -- show <batch>: each says what happened and where the files are. Nothing was deleted.",
  n("SELECT count(*) AS n FROM ops WHERE state = 5"),
  () => paths("SELECT 'batch ' || batch || ': ' || src || ' → ' || dst || coalesce(' (' || err || ')', '') AS p FROM ops WHERE state = 5 LIMIT 10"));

// ---- names that would collide on disk (Windows ignores case) -------------------
check("plan-case-collision", "warn", "Planned names that differ only in capitals: the same name on Windows",
  "The planner numbers such names now, and these are planned again as Atlas runs; Apply never puts two files in one place. If this stays, rename one of them in the library.",
  n("SELECT count(*) AS n FROM (SELECT plankey FROM files WHERE plankey IS NOT NULL GROUP BY plankey HAVING count(*) > 1)"),
  () => paths("SELECT group_concat(plan, '  |  ') AS p FROM files WHERE plankey IS NOT NULL GROUP BY plankey HAVING count(*) > 1 LIMIT 10"));
check("plan-key-missing", "error", "Planned files without the key that name collisions are decided on", BUG,
  n("SELECT count(*) AS n FROM files WHERE plan IS NOT NULL AND plankey IS NULL"));

// ---- folders and scans -------------------------------------------------------
check("roots-offline", "warn", "Folders that are not reachable", "Plug the drive in, or reconnect the share. Nothing in them is marked missing meanwhile.",
  n("SELECT count(*) AS n FROM roots WHERE enabled = 1 AND online = 0 AND seen_volume IS NULL"),
  () => paths("SELECT path || coalesce(': ' || scan_error, '') AS p FROM roots WHERE enabled = 1 AND online = 0 AND seen_volume IS NULL"));
check("roots-other-disk", "warn", "Folders where a different disk was found", "If it is the same data (a new disk), press \"Use this disk\" on the Folders page.",
  n("SELECT count(*) AS n FROM roots WHERE seen_volume IS NOT NULL"),
  () => paths("SELECT path || ' (found volume ' || seen_volume || ', expected ' || coalesce(volume, '?') || ')' AS p FROM roots WHERE seen_volume IS NOT NULL"));
check("roots-not-scanned", "warn", "Folders not scanned for a long time", "Is Atlas running? A scan that keeps failing is logged; press Rescan on the Folders page.",
  n("SELECT count(*) AS n FROM roots WHERE enabled = 1 AND online = 1 AND (scan_at IS NULL OR scan_at < ?)", Date.now() - 3 * config.rescanMinutes * 60_000),
  () => paths("SELECT path AS p FROM roots WHERE enabled = 1 AND online = 1 AND (scan_at IS NULL OR scan_at < ?)", Date.now() - 3 * config.rescanMinutes * 60_000));
check("suspect-stale", "warn", "Files not seen for over a day, never confirmed gone",
  "Their folder's scans keep failing to list part of it (see the Folders page): nothing can be concluded until a scan completes.",
  n(`SELECT count(*) AS n FROM files WHERE missed IS NOT NULL AND state <> ${S.MISSING} AND missed < ?`, Date.now() - 86_400_000),
  () => paths(`SELECT ${where} AS p FROM files f WHERE missed IS NOT NULL AND state <> ${S.MISSING} AND missed < ? LIMIT 10`, Date.now() - 86_400_000));

// ---- decisions -----------------------------------------------------------------
check("choices-on-missing", "info", "Folders or names chosen by hand for files that are missing",
  "Kept, and exported: if the file comes back, or turns up elsewhere unambiguously, the choice follows it.",
  n(`SELECT count(*) AS n FROM files WHERE state = ${S.MISSING} AND (pin IS NOT NULL OR pinname IS NOT NULL)`),
  () => paths(`SELECT ${where} || ' → ' || coalesce(pin, '') || coalesce('/' || pinname, '') AS p FROM files f
     WHERE state = ${S.MISSING} AND (pin IS NOT NULL OR pinname IS NOT NULL) LIMIT 10`));
{
  // The export must say what the database says (it is rewritten 2 s after any change).
  const latest = path.join(job.home, "intent", "latest.json");
  const shim = { all: (sql: string, ...a: (string | number)[]) => all(sql, ...a) } as unknown as Db;
  const now = collectIntent(shim);
  const x = readIntent(latest);
  const differs = now.roots.length > 0 && (!x || JSON.stringify({ roots: x.roots, files: x.files }) !== JSON.stringify({ roots: now.roots, files: now.files }));
  check("intent-export", "warn", "The export of your decisions is missing or out of date",
    "Run: npm run intent -- export (or make any change in Atlas). If it keeps happening, the export is failing: see the log.",
    differs ? 1 : 0, () => [x ? `exported ${x.written}: ${x.files.length} choices; the database has ${now.files.length}` : `no export at ${latest}`]);
}

// ---- backups -------------------------------------------------------------------
{
  const names = (() => { try { return fs.readdirSync(job.backupDir); } catch { return []; } })().filter((f) => /^atlas-\d{8}-\d{6}Z\.db$/.test(f)).sort();
  const newest = names.length ? fs.statSync(path.join(job.backupDir, names[names.length - 1])).mtimeMs : 0;
  const oldestRoot = one<{ t: number | null }>("SELECT min(created) AS t FROM roots").t ?? Date.now();
  const due = 2 * config.backupHours * 3_600_000;
  const stale = Date.now() - oldestRoot > due && Date.now() - newest > due;
  check("backup-stale", "warn", "No recent verified backup", "Run: npm run db -- backup (and check the log for why the daily one failed).",
    stale ? 1 : 0, () => [names.length ? `newest: ${names[names.length - 1]}` : `none in ${job.backupDir}`]);
}

// ---- housekeeping --------------------------------------------------------------
check("unused-contents", "info", "Content that no file uses any more (old versions of edited files)",
  "Space only: its text and index entries stay until they are pruned. Nothing is wrong.",
  n("SELECT count(*) AS n FROM contents WHERE id NOT IN (SELECT content FROM files WHERE content IS NOT NULL)"));
check("never-analysed", "info", "Files whose content was hashed but never analysed",
  "They are filed from their name and dates only. Reading them again (edit, or a newer Atlas) analyses them.",
  n(`SELECT count(*) AS n FROM files f JOIN contents c ON c.id = f.content WHERE c.state = 0 AND f.state = ${S.DONE}`));
check("ocr-unreachable", "info", "Scans waiting for OCR with no readable copy",
  "Their copies are missing or on a folder that is offline; OCR resumes when one is back.",
  n(`SELECT count(*) AS n FROM contents c WHERE c.ocr = ${OCR.PENDING} AND NOT EXISTS (
      SELECT 1 FROM files f JOIN roots r ON r.id = f.root WHERE f.content = c.id AND f.state IN (${S.IDENT}, ${S.DONE}) AND r.online = 1)
      AND EXISTS (SELECT 1 FROM files f WHERE f.content = c.id)`));
{
  const litter: string[] = [];
  const look = (dir: string, re: RegExp, depth = 1) => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 1) look(p, re, depth - 1);
      else if (e.isFile() && re.test(e.name)) litter.push(p);
    }
  };
  look(path.join(job.home, "thumbs"), /\.tmp$/, 2);
  look(path.join(job.home, "intent"), /\.tmp$/);
  look(job.home, /\.(restoring|tmp)$/);
  check("litter", "info", "Temporary files left behind by an interrupted operation", "Safe to delete.", litter.length, () => litter);
  const kept = (() => { try { return fs.readdirSync(job.home).filter((d) => /^replaced-/.test(d)); } catch { return []; } })();
  check("replaced-kept", "info", "Databases kept aside by a restore", "Delete them once you are satisfied with the restored database.",
    kept.length, () => kept.map((d) => path.join(job.home, d)));
  // Thumbnails are served as immutable: a broken one would be shown forever.
  let bad = 0;
  const badOnes: string[] = [];
  const thumbs = path.join(job.home, "thumbs");
  let buckets: string[] = [];
  try { buckets = fs.readdirSync(thumbs); } catch { /* none yet */ }
  let seen = 0;
  for (const b of buckets) {
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(thumbs, b)).filter((f) => f.endsWith(".img")); } catch { continue; }
    for (const f of files) {
      if (++seen > 20_000) break;
      const p = path.join(thumbs, b, f);
      try {
        const fd = fs.openSync(p, "r");
        const head = Buffer.alloc(4);
        const got = fs.readSync(fd, head, 0, 4, 0);
        fs.closeSync(fd);
        const jpeg = head[0] === 0xff && head[1] === 0xd8;
        const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
        if (got < 4 || (!jpeg && !png)) { bad++; badOnes.push(p); }
      } catch { /* vanished meanwhile */ }
    }
  }
  check("thumbs-broken", "info", "Thumbnails that are not a picture (a crash while one was written)", "Safe to delete: they are made again when next shown.",
    bad, () => badOnes);
}

// ---- the files themselves: a sample, read again --------------------------------
// Size and date are how Atlas notices a change without reading every file. A file
// whose bytes changed while both stayed the same (some restore and sync tools do
// that), or a disk returning different bytes, is invisible to it. A sample is read
// and hashed again: bounded in count and bytes, so it costs a few seconds.
const rehash = { sampled: 0, verified: 0, skipped: 0, mb: 0 };
{
  const rows = all<{ id: number; root: string; path: string; size: number; mtime: number; sha: Uint8Array }>(
    `SELECT f.id, r.path AS root, f.path, f.size, f.mtime, c.sha FROM files f JOIN roots r ON r.id = f.root JOIN contents c ON c.id = f.content
     WHERE f.state = ${S.DONE} AND f.missed IS NULL AND r.online = 1 AND r.enabled = 1 AND (f.attrs & ${PLACEHOLDER_ATTRS}) = 0 AND f.size <= ?
     ORDER BY random() LIMIT ?`, job.sampleBytes, job.sampleFiles * 3);
  const gone: string[] = [];
  const differ: string[] = [];
  let bytes = 0;
  const chunk = Buffer.allocUnsafe(4 << 20);
  for (const r of rows) {
    if (rehash.sampled >= job.sampleFiles || bytes + r.size > job.sampleBytes) break;
    const abs = path.join(r.root, ...r.path.split("/"));
    let fd: number;
    try { fd = fs.openSync(abs, "r"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") gone.push(abs);
      rehash.skipped++;
      continue;
    }
    try {
      const st = fs.fstatSync(fd);
      // Changed in the usual way: the next scan sees it. Only unchanged-looking files are evidence.
      if (st.size !== r.size || Math.floor(st.mtimeMs) !== r.mtime) { rehash.skipped++; continue; }
      rehash.sampled++;
      const h = crypto.createHash("sha256");
      for (;;) {
        const k = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (!k) break;
        h.update(k === chunk.length ? chunk : chunk.subarray(0, k));
      }
      bytes += r.size;
      const after = fs.fstatSync(fd);
      if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) { rehash.skipped++; continue; }
      if (Buffer.compare(h.digest(), Buffer.from(r.sha)) === 0) rehash.verified++;
      else differ.push(abs);
    } catch {
      rehash.skipped++;
    } finally {
      fs.closeSync(fd);
    }
  }
  rehash.mb = Math.round(bytes / 1048576);
  check("rehash-differs", "error", "Files whose bytes changed while their size and date did not",
    "Atlas describes an older version of these files. A rescan will not notice (it trusts size and date): press Rescan after touching them, or report it - it can also mean a failing disk.",
    differ.length, () => differ);
  check("sample-gone", "info", "Sampled files no longer on disk", "Normal between scans: the next scan will notice (suspect, then missing).",
    gone.length, () => gone);
}

db.close();
parentPort!.postMessage({ findings, checked, rehash, ms: Math.round(performance.now() - t0) } satisfies SanityResult);
