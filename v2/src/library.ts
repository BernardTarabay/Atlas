// The virtual library: the organized tree, read straight from files.plan.
// Nothing here writes to disk; this is the "preview" mode, and what the remote
// UI browses.
import type { Db } from "./db/db.ts";

const MAX = "\u{10FFFF}"; // sorts after every UTF-8 string, so prefix + MAX bounds a subtree

export interface Entry {
  id: number; name: string; size: number; mtime: number; ctime: number;
  kind: string | null; dtype: string | null; title: string | null; lang: string | null;
  ddate: number | null; pages: number | null; width: number | null; height: number | null;
}
export interface Folder { name: string; count: number; bytes: number; subs: number }
export interface Listing { path: string; folders: Folder[]; files: Entry[]; more: boolean }

interface Row {
  id: number; plan: string; size: number; mtime: number; ctime: number;
  kind: string | null; dtype: string | null; title: string | null; lang: string | null;
  ddate: number | null; pages: number | null; width: number | null; height: number | null;
}

/**
 * Children of a library folder. Walks the plan index in order: files directly in
 * the folder are collected in pages; the first entry of a subfolder records the
 * subfolder and jumps the cursor past its entire subtree (one seek per subfolder).
 *
 * `foldersOnly` skips the files entirely, which is what the sidebar tree wants:
 * expanding a node should cost one seek per child, not a page of file rows.
 */
export function listFolder(db: Db, folder: string, fileLimit = 2000, foldersOnly = false): Listing {
  const prefix = folder ? folder.replace(/\/+$/, "") + "/" : "";
  const page = db.q(
    `SELECT f.id, f.plan, f.size, f.mtime, f.ctime, c.kind, c.dtype, c.title, c.lang, c.ddate, c.pages, c.width, c.height
     FROM files f LEFT JOIN contents c ON c.id = f.content
     WHERE f.plan > ? AND f.plan < ? ORDER BY f.plan LIMIT 200`);
  // One row per subfolder: how much is in it, and whether it has folders of its own
  // (the tree needs to know before you expand it, so an empty chevron never appears).
  const summary = db.q(
    `SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes,
            sum(instr(substr(plan, ?), '/') > 0) AS deeper
     FROM files WHERE plan > ? AND plan < ?`);
  const folders: Folder[] = [];
  const files: Entry[] = [];
  let cursor = prefix;
  const end = prefix + MAX;
  let more = false;
  outer: for (;;) {
    const rows = page.all(cursor, end) as unknown as Row[];
    if (!rows.length) break;
    for (const r of rows) {
      const rest = r.plan.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        const name = rest.slice(0, slash);
        const sub = prefix + name + "/";
        const s = summary.get(sub.length + 1, sub, sub + MAX) as { n: number; bytes: number; deeper: number | null };
        folders.push({ name, count: s.n, bytes: s.bytes, subs: s.deeper ?? 0 });
        cursor = sub + MAX;
        continue outer;
      }
      if (foldersOnly) { cursor = r.plan; continue; }
      if (files.length >= fileLimit) { more = true; break outer; }
      files.push({
        id: r.id, name: rest, size: r.size, mtime: r.mtime, ctime: r.ctime, kind: r.kind, dtype: r.dtype,
        title: r.title, lang: r.lang, ddate: r.ddate, pages: r.pages, width: r.width, height: r.height,
      });
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

/**
 * Every image in the library, newest first.
 *
 * A photograph is identified by looking at it: a filename and a text layer say
 * almost nothing about a picture of a receipt that arrived as IMG_4821.jpg. So
 * this returns a flat list across the whole library rather than a folder at a
 * time, with the OCR state on each row - which is the one fact that decides
 * whether the picture is findable by its words yet.
 */
export function photos(db: Db, opts: { status?: string; limit?: number; offset?: number } = {}) {
  const limit = Math.min(opts.limit ?? 200, 1000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const OCR_STATE: Record<string, number> = { pending: 1, read: 2, failed: 3, noengine: 4, none: 0 };
  const wanted = opts.status && opts.status in OCR_STATE ? OCR_STATE[opts.status] : null;
  const where = `f.plan IS NOT NULL AND c.kind = 'image'${wanted == null ? "" : " AND c.ocr = ?"}`;
  const args: (string | number)[] = wanted == null ? [] : [wanted];
  const files = db.all<Entry & { plan: string; ocr: number }>(
    `SELECT f.id, f.plan, f.size, f.mtime, f.ctime, c.kind, c.dtype, c.title, c.lang, c.ddate,
            c.pages, c.width, c.height, c.ocr
     FROM files f JOIN contents c ON c.id = f.content
     WHERE ${where}
     ORDER BY coalesce(c.ddate, f.mtime) DESC, f.id LIMIT ? OFFSET ?`, ...args, limit, offset);
  const total = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM files f JOIN contents c ON c.id = f.content WHERE ${where}`, ...args)!.n;
  const byState = db.all<{ ocr: number; n: number }>(
    `SELECT c.ocr, count(*) AS n FROM files f JOIN contents c ON c.id = f.content
     WHERE f.plan IS NOT NULL AND c.kind = 'image' GROUP BY c.ocr`);
  const counts: Record<string, number> = { all: 0 };
  for (const r of byState) {
    counts.all += r.n;
    const name = Object.keys(OCR_STATE).find((k) => OCR_STATE[k] === r.ocr) ?? "none";
    counts[name] = (counts[name] ?? 0) + r.n;
  }
  return { files: files.map((f) => ({ ...f, name: f.plan.slice(f.plan.lastIndexOf("/") + 1) })), total, counts };
}

/**
 * Files by criteria rather than by words: "every PDF", "anything filed after
 * March", "the Arabic invoices". The structured counterpart to search, and what
 * the assistant reaches for when the request is a property rather than a phrase.
 */
export interface Criteria {
  ext?: string; kind?: string; dtype?: string; lang?: string; folder?: string;
  nameContains?: string; after?: number; before?: number; minSize?: number; maxSize?: number;
  limit?: number;
}

export function find(db: Db, c: Criteria) {
  const where: string[] = ["f.plan IS NOT NULL"];
  const args: (string | number)[] = [];
  if (c.folder) { where.push("f.plan LIKE ?"); args.push(`${c.folder.replace(/\/+$/, "")}/%`); }
  if (c.kind) { where.push("c.kind = ?"); args.push(c.kind); }
  if (c.dtype) { where.push("c.dtype = ?"); args.push(c.dtype); }
  if (c.lang) { where.push("c.lang = ?"); args.push(c.lang); }
  if (c.nameContains) { where.push("lower(f.plan) LIKE ?"); args.push(`%${c.nameContains.toLowerCase()}%`); }
  if (c.ext) {
    const exts = c.ext.split(",").map((e) => e.trim().replace(/^\./, "").toLowerCase()).filter(Boolean);
    if (exts.length) {
      where.push(`(${exts.map(() => "lower(f.plan) LIKE ?").join(" OR ")})`);
      for (const e of exts) args.push(`%.${e}`);
    }
  }
  // Dates mean the document's own date when it has one, the file's otherwise -
  // the same date the library shows and sorts by.
  if (c.after != null) { where.push("coalesce(c.ddate, f.mtime) >= ?"); args.push(c.after); }
  if (c.before != null) { where.push("coalesce(c.ddate, f.mtime) <= ?"); args.push(c.before); }
  if (c.minSize != null) { where.push("f.size >= ?"); args.push(c.minSize); }
  if (c.maxSize != null) { where.push("f.size <= ?"); args.push(c.maxSize); }
  const limit = Math.min(c.limit ?? 500, 2000);
  const sql = `FROM files f LEFT JOIN contents c ON c.id = f.content WHERE ${where.join(" AND ")}`;
  const files = db.all<Entry & { plan: string }>(
    `SELECT f.id, f.plan, f.size, f.mtime, f.ctime, c.kind, c.dtype, c.title, c.lang, c.ddate, c.pages, c.width, c.height
     ${sql} ORDER BY coalesce(c.ddate, f.mtime) DESC, f.id LIMIT ?`, ...args, limit);
  const total = db.get<{ n: number }>(`SELECT count(*) AS n ${sql}`, ...args)!.n;
  return { files: files.map((f) => ({ ...f, name: f.plan.slice(f.plan.lastIndexOf("/") + 1) })), total };
}

/**
 * Everything the status page's headline cards need, from aggregates.
 *
 * V1's first dashboard counted a paged list and reported "200 files" on a
 * 9,398-file library. Every number here is a GROUP BY, true at any size.
 */
export function dashboard(db: Db) {
  const one = <T>(sql: string, ...a: (string | number)[]) => db.get<T>(sql, ...a)!;
  const all = one<{ n: number; bytes: number }>("SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM files WHERE state <> 70");
  const placed = one<{ n: number; bytes: number }>("SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM files WHERE plan IS NOT NULL");
  const waiting = one<{ n: number }>("SELECT count(*) AS n FROM files WHERE state < 50").n;
  const failed = one<{ n: number }>("SELECT count(*) AS n FROM files WHERE state = 90").n;
  // Of those: set aside until the file changes (content), or tried again later (access).
  const failedAccess = one<{ n: number }>("SELECT count(*) AS n FROM files WHERE state = 90 AND fclass = 'access'").n;
  const missing = one<{ n: number }>("SELECT count(*) AS n FROM files WHERE state = 70").n;
  // Not seen by the last complete scan, and not yet confirmed gone (pipeline/states.ts).
  const suspect = one<{ n: number }>("SELECT count(*) AS n FROM files WHERE missed IS NOT NULL AND state <> 70").n;
  const photos = one<{ n: number; bytes: number }>(
    `SELECT count(*) AS n, coalesce(sum(f.size), 0) AS bytes FROM files f JOIN contents c ON c.id = f.content
     WHERE f.plan IS NOT NULL AND c.kind = 'image'`);
  const ocr = db.all<{ ocr: number; n: number }>("SELECT ocr, count(*) AS n FROM contents GROUP BY ocr");
  const ocrBy = (v: number) => ocr.find((r) => r.ocr === v)?.n ?? 0;
  // Readings that failed for a passing reason wait out a backoff: not "queued" in the meantime.
  const ocrDeferred = one<{ n: number }>("SELECT count(*) AS n FROM contents WHERE ocr = 1 AND onext > ?", Date.now()).n;
  // A duplicate is a second file with the same bytes. It is RESOLVED when the
  // plan places only one of them - which is every group, by construction. Nothing
  // has been deleted: the bytes are what would be reclaimed if they were.
  const dups = one<{ groups: number; copies: number; bytes: number }>(
    `SELECT count(*) AS groups, coalesce(sum(n - 1), 0) AS copies, coalesce(sum((n - 1) * size), 0) AS bytes
     FROM (SELECT content, count(DISTINCT coalesce(fid, id)) AS n, max(size) AS size FROM files
           WHERE content IS NOT NULL AND state = 50 GROUP BY content HAVING n > 1)`);
  const aliases = one<{ n: number }>("SELECT count(*) AS n FROM files WHERE rule = 'alias'").n;
  const manual = one<{ n: number }>("SELECT count(*) AS n FROM files WHERE pin IS NOT NULL OR pinname IS NOT NULL").n;
  const unique = one<{ n: number; bytes: number }>("SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM contents");
  const byKind = db.all<{ kind: string; n: number; bytes: number }>(
    `SELECT coalesce(nullif(c.kind, ''), 'other') AS kind, count(*) AS n, coalesce(sum(f.size), 0) AS bytes
     FROM files f LEFT JOIN contents c ON c.id = f.content WHERE f.plan IS NOT NULL GROUP BY 1 ORDER BY n DESC`);
  const roots = db.all("SELECT id, path, role, enabled, online, scan_at, scan_ms, scan_files, scan_error FROM roots ORDER BY id");
  return {
    files: all.n, bytes: all.bytes, placed: placed.n, placedBytes: placed.bytes,
    unique: unique.n, uniqueBytes: unique.bytes,
    waiting, failed, failedAccess, missing, suspect, manual,
    photos: photos.n, photoBytes: photos.bytes,
    ocr: { pending: ocrBy(1) - ocrDeferred, deferred: ocrDeferred, read: ocrBy(2), failed: ocrBy(3), noEngine: ocrBy(4) },
    duplicates: { ...dups, aliases },
    byKind, roots,
  };
}

/**
 * One breakdown, described by data rather than code: count or bytes, split by
 * one property, optionally narrowed. This is what a custom card IS - so a card
 * the assistant designs costs one model call to describe, and nothing ever again
 * to keep up to date.
 */
export interface StatsQuery {
  by: "kind" | "ext" | "dtype" | "lang" | "year" | "month" | "folder" | "rule" | "state";
  metric?: "count" | "bytes";
  kind?: string; ext?: string; dtype?: string; lang?: string; folder?: string;
  limit?: number;
}

const BY_SQL: Record<string, string> = {
  kind: "coalesce(nullif(c.kind, ''), 'other')",
  dtype: "coalesce(c.dtype, 'unclassified')",
  lang: "coalesce(c.lang, 'unknown')",
  year: "strftime('%Y', coalesce(c.ddate, f.mtime) / 1000, 'unixepoch')",
  month: "strftime('%Y-%m', coalesce(c.ddate, f.mtime) / 1000, 'unixepoch')",
  folder: "substr(f.plan, 1, instr(f.plan, '/') - 1)",
  rule: "coalesce(f.rule, 'none')",
  state: "CASE f.state WHEN 0 THEN 'new' WHEN 20 THEN 'identified' WHEN 50 THEN 'done' WHEN 70 THEN 'missing' WHEN 90 THEN 'failed' END",
};

export function stats(db: Db, q: StatsQuery) {
  const metric = q.metric === "bytes" ? "bytes" : "count";
  const where: string[] = [q.by === "state" ? "1" : "f.plan IS NOT NULL"];
  const args: (string | number)[] = [];
  if (q.kind) { where.push("c.kind = ?"); args.push(q.kind); }
  if (q.dtype) { where.push("c.dtype = ?"); args.push(q.dtype); }
  if (q.lang) { where.push("c.lang = ?"); args.push(q.lang); }
  if (q.folder) { where.push("f.plan LIKE ?"); args.push(`${q.folder.replace(/[/]+$/, "")}/%`); }
  if (q.ext) { where.push("lower(f.plan) LIKE ?"); args.push(`%.${q.ext.replace(/^[.]/, "").toLowerCase()}`); }
  const limit = Math.min(q.limit ?? 12, 60);
  const from = `FROM files f LEFT JOIN contents c ON c.id = f.content WHERE ${where.join(" AND ")}`;
  let rows: { key: string; n: number; bytes: number }[];
  if (q.by === "ext") {
    // SQLite has no "last index of", so the extension is taken in JS - still one
    // pass, and only the two columns it needs.
    const m = new Map<string, { n: number; bytes: number }>();
    for (const r of db.all<{ p: string; size: number }>(`SELECT coalesce(f.plan, f.path) AS p, f.size ${from}`, ...args)) {
      const name = r.p.slice(r.p.lastIndexOf("/") + 1);
      const dot = name.lastIndexOf(".");
      const key = dot > 0 ? name.slice(dot + 1).toLowerCase() : "(none)";
      const e = m.get(key) ?? { n: 0, bytes: 0 };
      e.n++; e.bytes += r.size;
      m.set(key, e);
    }
    rows = [...m.entries()].map(([key, v]) => ({ key, ...v }));
  } else {
    const col = BY_SQL[q.by];
    if (!col) throw new Error("unknown breakdown");
    rows = db.all(`SELECT ${col} AS key, count(*) AS n, coalesce(sum(f.size), 0) AS bytes ${from} GROUP BY 1`, ...args);
  }
  const sortKey = metric === "bytes" ? "bytes" : "n";
  rows.sort((a, b) => (q.by === "year" || q.by === "month" ? String(a.key).localeCompare(String(b.key)) : b[sortKey] - a[sortKey]));
  const total = rows.reduce((t, r) => ({ n: t.n + r.n, bytes: t.bytes + r.bytes }), { n: 0, bytes: 0 });
  return { by: q.by, metric, rows: q.by === "year" || q.by === "month" ? rows.slice(-limit) : rows.slice(0, limit), total };
}

/** The duplicate groups worth seeing first: the ones that would free the most space. */
export function duplicateGroups(db: Db, limit = 8) {
  return db.all<{ content: number; copies: number; size: number; wasted: number; name: string; kind: string | null }>(
    `SELECT g.content, g.n - 1 AS copies, g.size, (g.n - 1) * g.size AS wasted,
            (SELECT coalesce(f.plan, f.path) FROM files f WHERE f.content = g.content AND f.plan IS NOT NULL LIMIT 1) AS name,
            c.kind
     FROM (SELECT content, count(DISTINCT coalesce(fid, id)) AS n, max(size) AS size FROM files
           WHERE content IS NOT NULL AND state = 50 GROUP BY content HAVING n > 1) g
     JOIN contents c ON c.id = g.content
     ORDER BY wasted DESC LIMIT ?`, Math.min(limit, 50))
    .map((r) => ({ ...r, name: (r.name ?? "").slice((r.name ?? "").lastIndexOf("/") + 1) }));
}

/** Files that could not be read, newest first, with the reason and when (if ever) they are tried again. */
export function failedFiles(db: Db, limit = 10) {
  return db.all<{ id: number; path: string; err: string | null; tries: number; root: string; fclass: string | null; fnext: number | null }>(
    `SELECT f.id, f.path, f.err, f.tries, f.fclass, f.fnext, r.path AS root FROM files f JOIN roots r ON r.id = f.root
     WHERE f.state = 90 ORDER BY f.id DESC LIMIT ?`, Math.min(limit, 100));
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
