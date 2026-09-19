// Search = several cheap, exact signals fused by rank, not one opaque score:
//   content  FTS5 over normalized + lightly stemmed text (EN/AR/FR)
//   names    trigram FTS over normalized paths (substrings, invoice numbers)
// Semantic vectors join this fusion when local embeddings land.
// Reciprocal Rank Fusion: score = sum over signals of 1 / (60 + rank).
import type { Db } from "../db/db.ts";
import { ftsQuery, nameQuery, normalize, tokens, stem } from "./text.ts";

export interface Hit {
  id: number; path: string; plan: string | null; size: number; mtime: number; kind: string | null;
  title: string | null; ddate: number | null; root: number; score: number; why: string[]; snippet: string | null;
}

const K = 60;

export function search(db: Db, q: string, opts: { kind?: string; limit?: number } = {}): { hits: Hit[]; ms: number } {
  const t0 = performance.now();
  const limit = Math.min(opts.limit ?? 50, 200);
  const scores = new Map<number, { score: number; why: Set<string> }>();
  const add = (fileId: number, rank: number, why: string) => {
    const s = scores.get(fileId) ?? { score: 0, why: new Set<string>() };
    s.score += 1 / (K + rank);
    s.why.add(why);
    scores.set(fileId, s);
  };

  const tq = ftsQuery(q);
  if (tq) {
    const rows = db.all<{ cid: number }>("SELECT rowid AS cid FROM fts_text WHERE fts_text MATCH ? ORDER BY bm25(fts_text) LIMIT 300", tq);
    if (rows.length) {
      // Each content is shown once, as its representative (the copy with a plan).
      const reps = db.all<{ id: number; content: number }>(
        "SELECT id, content FROM files WHERE content IN (SELECT value FROM json_each(?)) AND plan IS NOT NULL",
        JSON.stringify(rows.map((r) => r.cid)));
      const byContent = new Map(reps.map((r) => [r.content, r.id]));
      rows.forEach((r, i) => { const id = byContent.get(r.cid); if (id != null) add(id, i, "content"); });
    }
  }
  const nq = nameQuery(q);
  if (nq) {
    const rows = db.all<{ id: number; content: number | null; plan: string | null }>(
      `SELECT f.id, f.content, f.plan FROM fts_name n JOIN files f ON f.id = n.rowid
       WHERE fts_name MATCH ? ORDER BY bm25(fts_name) LIMIT 300`, nq);
    const repOf = db.q("SELECT id FROM files WHERE content = ? AND plan IS NOT NULL LIMIT 1");
    rows.forEach((r, i) => {
      // A duplicate's name still finds the file; the hit is its representative.
      const id = r.plan != null || r.content == null ? r.id : ((repOf.get(r.content) as { id: number } | undefined)?.id ?? r.id);
      add(id, i, "name");
    });
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const detail = db.q(
    `SELECT f.id, f.path, f.plan, f.size, f.mtime, f.root, f.content, c.kind, c.title, c.ddate
     FROM files f LEFT JOIN contents c ON c.id = f.content WHERE f.id = ?`);
  const terms = [...new Set(tokens(q).map(stem))].filter((t) => t.length >= 2);
  const hits: Hit[] = [];
  for (const [id, s] of ranked) {
    const r = detail.get(id) as (Omit<Hit, "score" | "why" | "snippet"> & { content: number | null }) | undefined;
    if (!r) continue;
    if (opts.kind && r.kind !== opts.kind) continue;
    hits.push({ ...r, score: +s.score.toFixed(5), why: [...s.why], snippet: s.why.has("content") && r.content ? snippet(db, r.content, terms) : null });
    if (hits.length >= limit) break;
  }
  return { hits, ms: Math.round(performance.now() - t0) };
}

/** The first line of the original text (text layer first, then OCR) whose normalized form contains a query term. */
function snippet(db: Db, contentId: number, terms: string[]): string | null {
  const row = db.get<{ body: string }>(
    "SELECT group_concat(substr(body, 1, 50000), char(10)) AS body FROM (SELECT body FROM texts WHERE content = ? ORDER BY src DESC)", contentId);
  if (!row?.body) return null;
  for (const line of row.body.split(/\r?\n/)) {
    if (line.length < 3) continue;
    const words = new Set(normalize(line).split(" ").map(stem));
    if (terms.some((t) => [...words].some((w) => w.startsWith(t)))) return line.length > 240 ? line.slice(0, 240) + "…" : line;
  }
  return row.body.slice(0, 200);
}
