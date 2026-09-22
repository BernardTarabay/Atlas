// One scan of one root: stream the walk into batched upserts, then reconcile.
//
// No per-file SELECT: the UPSERT decides new / changed / unchanged / returned in
// SQL. Unchanged files are only touched to bump `seen`. After a COMPLETE walk,
// rows not seen are marked MISSING -- except under directories that failed to
// list, and never when the root itself is gone (an unplugged drive is offline,
// not deleted). Finally, new rows that are really moved/renamed files (same
// NTFS file ID, size and mtime as a known row) adopt the known content instead
// of being re-read. What a person decided about such a file (a folder or name
// chosen by hand) goes with it.
import type { Db } from "../db/db.ts";
import { log } from "../log.ts";
import { S, PLACEHOLDER_ATTRS } from "../pipeline/states.ts";
import { walk, type Entry } from "./walker.ts";
import { releaseName } from "../plan/planner.ts";

export interface ScanStats {
  root: number;
  files: number;
  dirs: number;
  errors: number;
  missing: number;
  adopted: number;
  /** Rows that received a moved file's folder/name chosen by hand. */
  carried: number;
  ms: number;
  complete: boolean;
  offline: boolean;
}

const UPSERT = `
INSERT INTO files(root, path, size, mtime, ctime, attrs, fid, seen, state)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(root, path) DO UPDATE SET
  seen  = excluded.seen,
  attrs = excluded.attrs,
  fid   = excluded.fid,
  ctime = excluded.ctime,
  state = CASE
    WHEN files.size <> excluded.size OR files.mtime <> excluded.mtime
      OR (files.attrs & ${PLACEHOLDER_ATTRS}) <> (excluded.attrs & ${PLACEHOLDER_ATTRS}) THEN excluded.state
    WHEN files.state = ${S.MISSING} THEN CASE WHEN files.content IS NOT NULL OR excluded.state = ${S.IDENT} THEN ${S.IDENT} ELSE ${S.NEW} END
    -- A failed file stays failed while it is the same file. Another physical file
    -- under the same name (a new file ID) is a new chance.
    WHEN files.state = ${S.FAILED} AND files.fid IS NOT excluded.fid THEN ${S.NEW}
    ELSE files.state END,
  content = CASE WHEN files.size <> excluded.size OR files.mtime <> excluded.mtime THEN NULL ELSE files.content END,
  tries   = CASE WHEN files.size <> excluded.size OR files.mtime <> excluded.mtime
                   OR (files.state = ${S.FAILED} AND files.fid IS NOT excluded.fid) THEN 0 ELSE files.tries END,
  frounds = CASE WHEN files.size <> excluded.size OR files.mtime <> excluded.mtime
                   OR (files.state = ${S.FAILED} AND files.fid IS NOT excluded.fid) THEN 0 ELSE files.frounds END,
  size  = excluded.size,
  mtime = excluded.mtime`;

interface Known { id: number; size: number; mtime: number; attrs: number; fid: string | null; state: number }

export async function scanRoot(db: Db, rootId: number): Promise<ScanStats> {
  const root = db.get<{ path: string; gen: number }>("SELECT path, gen FROM roots WHERE id = ?", rootId);
  if (!root) throw new Error(`root ${rootId} not found`);
  const gen = root.gen + 1;
  const t0 = performance.now();
  const upsert = db.q(UPSERT);
  const lookup = db.q("SELECT id, size, mtime, attrs, fid, state FROM files WHERE root = ? AND path = ?");
  // Unchanged files are recorded here instead of being rewritten: a rescan of an
  // unchanged tree performs reads only, no page writes and no WAL growth.
  const seen = new Set<number>();
  const firstScan = root.gen === 0;

  const onBatch = (entries: Entry[]) => {
    db.tx(() => {
      for (const e of entries) {
        const k = firstScan ? undefined : (lookup.get(rootId, e.path) as Known | undefined);
        // Unchanged includes FAILED: a failure is not retried just because a scan came by.
        if (k && k.size === e.size && k.mtime === e.mtime && k.attrs === e.attrs && k.fid === e.fid
            && k.state !== S.MISSING) {
          seen.add(k.id);
          continue;
        }
        // A cloud placeholder is never read (that would download it); it goes straight to planning.
        const state = e.attrs & PLACEHOLDER_ATTRS ? S.IDENT : S.NEW;
        upsert.run(rootId, e.path, e.size, e.mtime, e.ctime, e.attrs, e.fid, gen, state);
      }
    });
  };

  const w = await walk(root.path, onBatch);
  const stats: ScanStats = {
    root: rootId, files: w.files, dirs: w.dirs, errors: w.errors.length, missing: 0, adopted: 0, carried: 0,
    ms: 0, complete: w.complete && !w.rootMissing, offline: w.rootMissing,
  };

  if (w.rootMissing) {
    db.run("UPDATE roots SET online = 0, scan_error = ? WHERE id = ?", "root folder is not reachable", rootId);
    log.warn("root offline; nothing marked missing", { root: root.path });
    stats.ms = Math.round(performance.now() - t0);
    return stats;
  }

  db.tx(() => {
    if (stats.complete) stats.missing = markMissing(db, rootId, gen, seen, w.errors.map((e) => e.dir));
    ({ adopted: stats.adopted, carried: stats.carried } = adoptKnown(db, rootId, gen));
    stats.ms = Math.round(performance.now() - t0);
    db.run(
      `UPDATE roots SET gen = ?, online = 1, volume = ?, fs = ?, scan_at = ?, scan_ms = ?, scan_files = ?, scan_error = ?
       WHERE id = ?`,
      gen, w.volume, w.fs, Date.now(), stats.ms, w.files,
      w.errors.length ? `${w.errors.length} folder(s) could not be read` : null, rootId,
    );
  });
  if (w.errors.length) log.warn("folders could not be listed", { root: root.path, errors: w.errors.slice(0, 20) });
  log.info("scan complete", { ...stats, path: root.path });
  return stats;
}

function markMissing(db: Db, rootId: number, gen: number, seen: Set<number>, errorDirs: string[]): number {
  // Too many unreadable folders means the listing is not trustworthy enough to delete anything from the index.
  if (errorDirs.length > 100 || errorDirs.includes("")) return 0;
  const prefixes = errorDirs.map((d) => d + "/");
  const gone: { id: number; content: number | null; plan: string | null }[] = [];
  // Rows written this scan carry seen = gen; unchanged rows are in `seen`. Everything else was not found.
  for (const r of db.all<{ id: number; path: string; seen: number; content: number | null; plan: string | null }>(
    `SELECT id, path, seen, content, plan FROM files WHERE root = ? AND state <> ${S.MISSING}`, rootId)) {
    if (r.seen === gen || seen.has(r.id)) continue;
    if (prefixes.some((p) => r.path.startsWith(p))) continue;
    gone.push({ id: r.id, content: r.content, plan: r.plan });
  }
  if (!gone.length) return 0;
  const setMissing = db.q(`UPDATE files SET state = ${S.MISSING}, plan = NULL WHERE id = ?`);
  for (const g of gone) {
    setMissing.run(g.id);
    if (g.plan) releaseName(db, g.plan);
  }
  const delName = db.q("DELETE FROM fts_name WHERE rowid = ?");
  const replan = db.q(`UPDATE files SET state = ${S.IDENT} WHERE content = ? AND state = ${S.DONE}`);
  const groups = new Set<number>();
  for (const g of gone) {
    delName.run(g.id);
    if (g.content != null) groups.add(g.content);
  }
  // A missing file may have been the representative of its duplicate group: re-plan the group.
  for (const c of groups) replan.run(c);
  return gone.length;
}

function adoptKnown(db: Db, rootId: number, gen: number): { adopted: number; carried: number } {
  // Same NTFS file ID + size + mtime as a known row = the same physical file, seen
  // at a new path (moved/renamed) or through a hard link. That is identity of the
  // file, not an inference about content, so its analysis carries over.
  const adopted = db.run(
    `UPDATE files AS n SET content = o.content, state = ${S.IDENT}
     FROM files AS o
     WHERE n.root = ? AND n.seen = ? AND n.state = ${S.NEW} AND n.content IS NULL AND n.fid IS NOT NULL
       AND o.fid = n.fid AND o.id <> n.id AND o.content IS NOT NULL AND o.size = n.size AND o.mtime = n.mtime`,
    rootId, gen,
  ).changes as number;
  // What a person decided belongs to the FILE, not to the path it had. The old row of
  // a moved or renamed file is about to be deleted as history; first its folder and
  // name chosen by hand go to the live row(s) of the same physical file - where they
  // have none of their own, newest decision first. A file ID is identity of the file
  // itself (NTFS/ReFS), so this is not a guess from content; other filesystems get
  // no file ID and are handled elsewhere. Every live name of the file gets it: one
  // file, one decision, whichever name ends up representing it.
  let carried = 0;
  const intent = db.all<{ fid: string; pin: string | null; pinname: string | null }>(
    `SELECT fid, pin, pinname FROM files m
     WHERE state = ${S.MISSING} AND fid IS NOT NULL AND (pin IS NOT NULL OR pinname IS NOT NULL)
       AND EXISTS (SELECT 1 FROM files x WHERE x.fid = m.fid AND x.state <> ${S.MISSING})
     ORDER BY id DESC`);
  const carry = db.q(
    `UPDATE files SET pin = coalesce(pin, ?), pinname = coalesce(pinname, ?),
       state = CASE WHEN state = ${S.DONE} THEN ${S.IDENT} ELSE state END
     WHERE fid = ? AND state <> ${S.MISSING}
       AND ((pin IS NULL AND ? IS NOT NULL) OR (pinname IS NULL AND ? IS NOT NULL))`);
  for (const m of intent) carried += Number(carry.run(m.pin, m.pinname, m.fid, m.pin, m.pinname).changes);
  // The old row of a moved file is now just history.
  db.run(
    `DELETE FROM files WHERE state = ${S.MISSING} AND fid IS NOT NULL
       AND EXISTS (SELECT 1 FROM files x WHERE x.fid = files.fid AND x.state <> ${S.MISSING})`,
  );
  // Hard links: a file changed through one name changed under all of them, but NTFS
  // updates only the directory entry of the name it was written through, so the other
  // names look unchanged in a listing. Re-read every name of a physical file that changed.
  db.run(
    `UPDATE files SET state = ${S.NEW}, content = NULL
     WHERE state IN (${S.IDENT}, ${S.DONE}) AND fid IN (
       SELECT fid FROM files WHERE root = ? AND seen = ? AND state = ${S.NEW} AND fid IS NOT NULL)`,
    rootId, gen,
  );
  return { adopted, carried };
}
