// Numbering a crowd (Phase 9 of docs/18-v2-reliability-audit.md).
//
// Real archives are full of files that all want to be called the same thing: hundreds of
// invoices scanned on one day, "Scan 001", "IMG_0001". The planner numbers them apart,
// and what it must not do is ask the database once per attempt - that is quadratic in
// the size of the group, and it is what made a 200,000-file run crawl.
//
// This counts queries rather than seconds, so it says the same thing on any machine.
import "./_env.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { Db } from "../src/db/db.ts";
import { planBatch } from "../src/plan/planner.ts";
import { S } from "../src/pipeline/states.ts";

const cleanup: (() => void)[] = [];
after(() => { for (const f of cleanup.reverse()) try { f(); } catch { /* best effort */ } });

/** A library of `n` files whose content and dates make the rules give them ONE name. */
function crowd(name: string, n: number): { db: Db; queries: () => number } {
  const db = new Db(path.join(process.env.ATLAS_HOME!, `${name}.db`));
  cleanup.push(() => db.close());
  db.run("INSERT INTO roots(path, created) VALUES ('C:\\\\Crowd', ?)", Date.now());
  const when = Date.UTC(2024, 4, 17, 9, 0, 0);
  db.tx(() => {
    for (let i = 0; i < n; i++) {
      const sha = crypto.randomBytes(32);
      const cid = Number(db.run(
        "INSERT INTO contents(sha, size, kind, state, dtype, ddate, dsrc, quality) VALUES (?, 2048, 'pdf', 10, 'invoice', ?, 'text', 'ok')",
        sha, when).lastInsertRowid);
      db.run(`INSERT INTO files(root, path, size, mtime, ctime, seen, state, content) VALUES (1, ?, 2048, ?, ?, 1, ${S.IDENT}, ?)`,
        `scans/scan${String(i).padStart(4, "0")}.pdf`, when, when, cid);
    }
  });
  // Count every statement the planner runs, by wrapping the connection it prepares from.
  let queries = 0;
  const raw = db as unknown as { q: (sql: string) => { get: unknown; all: unknown; run: unknown } };
  const realQ = raw.q.bind(db);
  raw.q = (sql: string) => {
    const st = realQ(sql) as Record<string, (...a: unknown[]) => unknown>;
    return new Proxy(st, { get: (t, k) => (["get", "all", "run"].includes(String(k))
      ? (...a: unknown[]) => { queries++; return (t[String(k)] as (...x: unknown[]) => unknown)(...a); }
      : t[String(k)]) }) as unknown as { get: unknown; all: unknown; run: unknown };
  };
  return { db, queries: () => queries };
}

test("hundreds of files wanting one name are numbered without asking once per attempt", () => {
  const SMALL = 50, BIG = 400;
  const a = crowd("crowd-small", SMALL);
  planBatch(a.db, 10_000, new Set());
  const perFileSmall = a.queries() / SMALL;

  const b = crowd("crowd-big", BIG);
  planBatch(b.db, 10_000, new Set());
  const perFileBig = b.queries() / BIG;

  // Quadratic would make the cost per file grow with the crowd (8x here). It must not.
  assert.ok(perFileBig < perFileSmall * 2,
    `queries per file: ${perFileSmall.toFixed(1)} for ${SMALL} files, ${perFileBig.toFixed(1)} for ${BIG} - it grows with the crowd`);

  // ...and the answer is still right: every file placed, each with its own name,
  // numbered from 1 with no gaps.
  const plans = b.db.all<{ plan: string }>("SELECT plan FROM files WHERE plan IS NOT NULL ORDER BY plan").map((r) => r.plan);
  assert.equal(plans.length, BIG, "every file got a place");
  assert.equal(new Set(plans).size, BIG, "and no two share one");
  const numbers = plans.map((p) => Number(/ \((\d+)\)\.pdf$/.exec(p)?.[1] ?? 1)).sort((x, y) => x - y);
  assert.deepEqual(numbers, Array.from({ length: BIG }, (_, i) => i + 1), "numbered 1..n, compactly");
  assert.ok(plans.every((p) => p.startsWith("Documents/Invoices/2024/2024-05-17 Invoice")), "all the same name, differing only by number");
});

test("the crowd is numbered the same way however many times it is planned", () => {
  const { db } = crowd("crowd-again", 120);
  planBatch(db, 10_000, new Set());
  const first = db.all<{ id: number; plan: string }>("SELECT id, plan FROM files ORDER BY id").map((r) => `${r.id}:${r.plan}`);
  db.run(`UPDATE files SET state = ${S.IDENT}`);
  planBatch(db, 10_000, new Set());
  const again = db.all<{ id: number; plan: string }>("SELECT id, plan FROM files ORDER BY id").map((r) => `${r.id}:${r.plan}`);
  assert.deepEqual(again, first, "planning again gives every file the same place");
});
