// The virtual library: the organized tree, read straight from files.plan.
// Nothing here writes to disk; this is the "preview" mode, and what the remote
// UI browses.
import type { Db } from "./db/db.ts";

const MAX = "\u{10FFFF}"; // sorts after every UTF-8 string, so prefix + MAX bounds a subtree

export interface Entry { id: number; name: string; size: number; mtime: number; kind: string | null; ddate: number | null }
export interface Listing { path: string; folders: { name: string; count: number }[]; files: Entry[]; more: boolean }

/**
 * Children of a library folder. Walks the plan index in order: files directly in
 * the folder are collected in pages; the first entry of a subfolder records the
 * subfolder and jumps the cursor past its entire subtree (one seek per subfolder).
 */
export function listFolder(db: Db, folder: string, fileLimit = 2000): Listing {
  const prefix = folder ? folder.replace(/\/+$/, "") + "/" : "";
  const page = db.q(
    `SELECT f.id, f.plan, f.size, f.mtime, c.kind, c.ddate FROM files f LEFT JOIN contents c ON c.id = f.content
     WHERE f.plan > ? AND f.plan < ? ORDER BY f.plan LIMIT 200`);
  const count = db.q("SELECT count(*) AS n FROM files WHERE plan > ? AND plan < ?");
  const folders: { name: string; count: number }[] = [];
  const files: Entry[] = [];
  let cursor = prefix;
  const end = prefix + MAX;
  let more = false;
  outer: for (;;) {
    const rows = page.all(cursor, end) as { id: number; plan: string; size: number; mtime: number; kind: string | null; ddate: number | null }[];
    if (!rows.length) break;
    for (const r of rows) {
      const rest = r.plan.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        const name = rest.slice(0, slash);
        const sub = prefix + name + "/";
        folders.push({ name, count: (count.get(sub, sub + MAX) as { n: number }).n });
        cursor = sub + MAX;
        continue outer;
      }
      if (files.length >= fileLimit) { more = true; break outer; }
      files.push({ id: r.id, name: rest, size: r.size, mtime: r.mtime, kind: r.kind, ddate: r.ddate });
      cursor = r.plan;
    }
  }
  return { path: folder, folders, files, more };
}

export function fileDetail(db: Db, id: number) {
  const f = db.get<Record<string, unknown> & { content: number | null; root: number }>(
    `SELECT f.id, f.root, f.path, f.size, f.mtime, f.ctime, f.attrs, f.state, f.plan, f.rule, f.err, f.content,
            r.path AS rootPath, r.role, r.online
     FROM files f JOIN roots r ON r.id = f.root WHERE f.id = ?`, id);
  if (!f) return null;
  const c = f.content != null
    ? db.get<Record<string, unknown>>(
      `SELECT hex(sha) AS sha, kind, mime, quality, lang, dtype, title, ddate, dsrc, width, height, pages, meta, tlen, ocr
       FROM contents WHERE id = ?`, f.content)
    : null;
  if (c?.meta) c.meta = JSON.parse(c.meta as string);
  const copies = f.content != null
    ? db.all(`SELECT f.id, f.path, f.plan, f.rule, r.path AS rootPath, r.role FROM files f JOIN roots r ON r.id = f.root
              WHERE f.content = ? AND f.id <> ? AND f.state = 50 ORDER BY f.id LIMIT 50`, f.content, id)
    : [];
  const text = f.content != null
    ? db.get<{ body: string }>("SELECT substr(body, 1, 4000) AS body FROM texts WHERE content = ? AND src = 'x'", f.content)?.body ?? null
    : null;
  const ocrText = f.content != null
    ? db.get<{ body: string }>("SELECT substr(body, 1, 4000) AS body FROM texts WHERE content = ? AND src = 'o'", f.content)?.body ?? null
    : null;
  return { file: f, content: c, copies, text, ocrText };
}

export function counts(db: Db) {
  const states = db.all<{ state: number; n: number; bytes: number }>("SELECT state, count(*) AS n, sum(size) AS bytes FROM files GROUP BY state");
  const dups = db.get<{ groups: number; copies: number; bytes: number }>(
    `SELECT count(*) AS groups, coalesce(sum(n - 1), 0) AS copies, coalesce(sum((n - 1) * size), 0) AS bytes
     FROM (SELECT content, count(DISTINCT coalesce(fid, id)) AS n, max(size) AS size FROM files
           WHERE content IS NOT NULL AND state = 50 GROUP BY content HAVING n > 1)`)!;
  const ocr = db.get<{ pending: number }>("SELECT count(*) AS pending FROM contents WHERE ocr = 1")!;
  return { states, duplicates: dups, ocrPending: ocr.pending };
}
