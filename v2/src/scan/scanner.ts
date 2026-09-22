// One scan of one root: stream the walk into batched upserts, then reconcile.
//
// No per-file SELECT: the UPSERT decides new / changed / unchanged / returned in
// SQL. Unchanged files are only touched to bump `seen`.
//
// Nothing is listed from the wrong disk: the walker reports the volume serial
// before any file, and a different disk at the root's path stops the scan
// (roots.seen_volume) until someone says it is the same folder.
//
// Gone is decided slowly. After a COMPLETE walk, a row not seen becomes SUSPECT
// (files.missed = now); only a LATER complete scan, at least CONFIRM_MISSING_MS on,
// that still does not see it makes it MISSING. Never under directories that failed
// to list, never when the root itself is gone (an unplugged drive is offline, not
// deleted), never from an incomplete or stalled walk.
//
// Moves are followed. New rows that are really moved/renamed files (same NTFS
// file ID, size and mtime as a known row) adopt the known content instead of being
// re-read, and what a person decided about the file (a folder or name chosen by
// hand) goes with it. Where there is no file ID (another drive, FAT, a share),
// carryByContent() moves a decision to the one copy that appeared when the
// original vanished - only when that is unambiguous.
import type { Db } from "../db/db.ts";
import { log } from "../log.ts";
import { S, PLACEHOLDER_ATTRS, CONFIRM_MISSING_MS } from "../pipeline/states.ts";
import { walk, type Entry } from "./walker.ts";
import { releaseName } from "../plan/planner.ts";
import { config } from "../config.ts";

export interface ScanStats {
  root: number;
  files: number;
  dirs: number;
  errors: number;
  /** Not seen by this complete scan for the first time: SUSPECT, not yet MISSING. */
  suspect: number;
  missing: number;
  adopted: number;
  /** Rows that received a moved file's folder/name chosen by hand. */
  carried: number;
  ms: number;
  complete: boolean;
  offline: boolean;
  /** A different disk is at the root's path: nothing was listed. */
  otherDisk: boolean;
}

const UPSERT = `
INSERT INTO files(root, path, size, mtime, ctime, attrs, fid, seen, state, born)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(root, path) DO UPDATE SET
  seen  = excluded.seen,
  missed = NULL,
  seenat = NULL,
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

interface Known { id: number; size: number; mtime: number; attrs: number; fid: string | null; state: number; missed: number | null }

export async function scanRoot(db: Db, rootId: number): Promise<ScanStats> {
  const root = db.get<{ path: string; gen: number; volume: string | null; scan_at: number | null }>(
    "SELECT path, gen, volume, scan_at FROM roots WHERE id = ?", rootId);
  if (!root) throw new Error(`root ${rootId} not found`);
  const gen = root.gen + 1;
  const t0 = performance.now();
  const born = Date.now();
  const upsert = db.q(UPSERT);
  const lookup = db.q("SELECT id, size, mtime, attrs, fid, state, missed FROM files WHERE root = ? AND path = ?");
  const present = db.q("UPDATE files SET missed = NULL, seenat = NULL WHERE id = ?");
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
          if (k.missed != null) present.run(k.id); // suspected gone last time; it is here
          continue;
        }
        // A cloud placeholder is never read (that would download it); it goes straight to planning.
        const state = e.attrs & PLACEHOLDER_ATTRS ? S.IDENT : S.NEW;
        upsert.run(rootId, e.path, e.size, e.mtime, e.ctime, e.attrs, e.fid, gen, state, born);
      }
    });
  };

  const w = await walk(root.path, onBatch, 2000, {
    stallMs: config.scanStallMs,
    // A drive letter is a place, not a disk. Another disk mounted where this root's
    // disk was is not this root: nothing may be listed, added or concluded from it.
    onVolume: (v) => !(root.volume && v && v !== root.volume),
  });
  const stats: ScanStats = {
    root: rootId, files: w.files, dirs: w.dirs, errors: w.errors.length, suspect: 0, missing: 0, adopted: 0, carried: 0,
    ms: 0, complete: w.complete && !w.rootMissing, offline: w.rootMissing || !!w.refused, otherDisk: !!w.refused,
  };

  if (w.refused) {
    db.run("UPDATE roots SET online = 0, seen_volume = ?, scan_error = ? WHERE id = ?", w.volume,
      `A different disk is at this path (volume ${w.volume}; this folder was on ${root.volume}). Nothing was scanned.`, rootId);
    log.warn("a different disk is at a root's path; not scanned", { root: root.path, found: w.volume, expected: root.volume });
    stats.ms = Math.round(performance.now() - t0);
    return stats;
  }
  if (w.rootMissing) {
    db.run("UPDATE roots SET online = 0, scan_error = ? WHERE id = ?", "root folder is not reachable", rootId);
    log.warn("root offline; nothing marked missing", { root: root.path });
    stats.ms = Math.round(performance.now() - t0);
    return stats;
  }

  db.tx(() => {
    if (stats.complete) ({ suspect: stats.suspect, missing: stats.missing } = markMissing(db, rootId, gen, seen, w.errors.map((e) => e.dir), root.scan_at));
    ({ adopted: stats.adopted, carried: stats.carried } = adoptKnown(db, rootId, gen));
    stats.carried += carryByContent(db).carried;
    stats.ms = Math.round(performance.now() - t0);
    db.run(
      `UPDATE roots SET gen = ?, online = 1, seen_volume = NULL, volume = ?, fs = ?, scan_at = ?, scan_ms = ?, scan_files = ?, scan_error = ?
       WHERE id = ?`,
      gen, w.volume, w.fs, Date.now(), stats.ms, w.files,
      w.stalled ? `the listing stopped responding after ${w.files} files; nothing was concluded from it`
        : w.errors.length ? `${w.errors.length} folder(s) could not be read` : null, rootId,
    );
  });
  if (w.errors.length) log.warn("folders could not be listed", { root: root.path, errors: w.errors.slice(0, 20) });
  log.info("scan complete", { ...stats, path: root.path });
  return stats;
}

function markMissing(db: Db, rootId: number, gen: number, seen: Set<number>, errorDirs: string[], lastScan: number | null):
    { suspect: number; missing: number } {
  // Too many unreadable folders means the listing is not trustworthy enough to conclude anything from.
  if (errorDirs.length > 100 || errorDirs.includes("")) return { suspect: 0, missing: 0 };
  const prefixes = errorDirs.map((d) => d + "/");
  const now = Date.now();
  const gone: { id: number; content: number | null; plan: string | null }[] = [];
  const suspect = db.q("UPDATE files SET missed = ?, seenat = ? WHERE id = ?");
  let suspected = 0;
  // Rows written this scan carry seen = gen; unchanged rows are in `seen`. Everything else was not found.
  for (const r of db.all<{ id: number; path: string; seen: number; content: number | null; plan: string | null; missed: number | null }>(
    `SELECT id, path, seen, content, plan, missed FROM files WHERE root = ? AND state <> ${S.MISSING}`, rootId)) {
    if (r.seen === gen || seen.has(r.id)) continue;
    if (prefixes.some((p) => r.path.startsWith(p))) continue;
    if (r.missed == null) {
      // First time: SUSPECT. It keeps its state and its place until a later scan agrees.
      // `seenat`: it was there at the previous scan (unknown: now, which trusts nothing as newer).
      suspect.run(now, lastScan ?? now, r.id);
      suspected++;
    } else if (now - r.missed >= CONFIRM_MISSING_MS) {
      gone.push({ id: r.id, content: r.content, plan: r.plan });
    } else {
      suspected++;
    }
  }
  if (!gone.length) return { suspect: suspected, missing: 0 };
  const setMissing = db.q(`UPDATE files SET state = ${S.MISSING}, plan = NULL, plankey = NULL WHERE id = ?`);
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
  return { suspect: suspected, missing: gone.length };
}

/**
 * Forget rows whose file is now known to be elsewhere, tidily: its planned name is
 * given back (numbered neighbours compact), its name leaves the search index, and
 * its duplicate group is re-planned in case it was the group's representative.
 */
function forget(db: Db, rows: { id: number; plan: string | null; content: number | null }[]) {
  const del = db.q("DELETE FROM files WHERE id = ?");
  const delName = db.q("DELETE FROM fts_name WHERE rowid = ?");
  const replan = db.q(`UPDATE files SET state = ${S.IDENT} WHERE content = ? AND state = ${S.DONE}`);
  const groups = new Set<number>();
  for (const r of rows) {
    del.run(r.id);
    delName.run(r.id);
    if (r.plan) releaseName(db, r.plan);
    if (r.content != null) groups.add(r.content);
  }
  for (const c of groups) replan.run(c);
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
  //
  // The old row may be MISSING, or only SUSPECT (not seen by this scan): a file ID that
  // is live elsewhere settles it at once - the same file cannot be in both places, and
  // a hard-linked name that still existed would have been seen.
  const live = `x.fid = m.fid AND x.id <> m.id AND x.state <> ${S.MISSING} AND x.missed IS NULL`;
  let carried = 0;
  const intent = db.all<{ fid: string; pin: string | null; pinname: string | null }>(
    `SELECT fid, pin, pinname FROM files m
     WHERE (state = ${S.MISSING} OR missed IS NOT NULL) AND fid IS NOT NULL AND (pin IS NOT NULL OR pinname IS NOT NULL)
       AND EXISTS (SELECT 1 FROM files x WHERE ${live})
     ORDER BY id DESC`);
  const carry = db.q(
    `UPDATE files SET pin = coalesce(pin, ?), pinname = coalesce(pinname, ?),
       state = CASE WHEN state = ${S.DONE} THEN ${S.IDENT} ELSE state END
     WHERE fid = ? AND state <> ${S.MISSING} AND missed IS NULL
       AND ((pin IS NULL AND ? IS NOT NULL) OR (pinname IS NULL AND ? IS NOT NULL))`);
  for (const m of intent) carried += Number(carry.run(m.pin, m.pinname, m.fid, m.pin, m.pinname).changes);
  // The old row of a moved file is now just history.
  forget(db, db.all<{ id: number; plan: string | null; content: number | null }>(
    `SELECT id, plan, content FROM files m
     WHERE (state = ${S.MISSING} OR missed IS NOT NULL) AND fid IS NOT NULL
       AND EXISTS (SELECT 1 FROM files x WHERE ${live})`));
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

/**
 * A decision moves with a file that has no file ID to follow: moved to another
 * drive (copy + delete), or living on FAT/exFAT or a share. The file's MISSING row
 * (confirmed gone, with a folder or name chosen by hand) hands its decision to a
 * live row with the SAME BYTES that first appeared after the missing one was last
 * seen - and only when that pairing is one-to-one. SHA-256 proves the bytes are
 * equal, not that it is the same document: a copy that was always there is never
 * a candidate (born before), and two candidates, or two claimants, is ambiguous and
 * left for a person (`unresolved`).
 */
export function carryByContent(db: Db): { carried: number; unresolved: number } {
  const orphans = db.all<{ id: number; content: number; pin: string | null; pinname: string | null; seenat: number }>(
    `SELECT id, content, pin, pinname, seenat FROM files
     WHERE state = ${S.MISSING} AND (pin IS NOT NULL OR pinname IS NOT NULL) AND content IS NOT NULL AND seenat IS NOT NULL`);
  if (!orphans.length) return { carried: 0, unresolved: 0 };
  const candidates = db.q(
    `SELECT id FROM files WHERE content = ? AND state <> ${S.MISSING} AND missed IS NULL
       AND pin IS NULL AND pinname IS NULL AND born IS NOT NULL AND born > ?`);
  const wants = new Map<number, number[]>();   // missing row -> candidate live rows
  const claims = new Map<number, number[]>();  // live row -> missing rows wanting it
  for (const m of orphans) {
    const ids = (candidates.all(m.content, m.seenat) as { id: number }[]).map((r) => r.id);
    wants.set(m.id, ids);
    for (const l of ids) claims.set(l, [...(claims.get(l) ?? []), m.id]);
  }
  const give = db.q(`UPDATE files SET pin = ?, pinname = ?, state = CASE WHEN state = ${S.DONE} THEN ${S.IDENT} ELSE state END WHERE id = ?`);
  const handOver = db.q("UPDATE files SET pin = NULL, pinname = NULL WHERE id = ?");
  let carried = 0;
  let unresolved = 0;
  for (const m of orphans) {
    const ids = wants.get(m.id)!;
    if (!ids.length) continue; // not found anywhere (yet): nothing to decide
    if (ids.length === 1 && claims.get(ids[0])!.length === 1) {
      give.run(m.pin, m.pinname, ids[0]);
      handOver.run(m.id);
      carried++;
    } else unresolved++;
  }
  if (carried) log.info("choices followed moved files by content", { carried });
  return { carried, unresolved };
}
