import "./_env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/db/db.ts";
import { removeRoot } from "../src/roots.ts";

// Forgetting a folder must forget what only that folder contributed - and
// nothing that another folder still has a copy of.
test("removing a folder removes its orphaned contents, texts and index rows, and keeps shared ones", () => {
  const db = new Db(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "atlas-roots-")), "atlas.db"));
  const now = Date.now();
  db.run("INSERT INTO roots(id, path, created) VALUES (1, 'C:\\\\A', ?), (2, 'C:\\\\B', ?)", now, now);
  const content = (id: number, text: string) => {
    db.run("INSERT INTO contents(id, sha, size, kind, state) VALUES (?, randomblob(32), 10, 'text', 10)", id);
    db.run("INSERT INTO texts(content, src, body) VALUES (?, 'x', ?)", id, text);
    db.run("INSERT INTO fts_text(rowid, body) VALUES (?, ?)", id, text);
  };
  content(10, "only in folder A");
  content(20, "in both folders");
  const file = (id: number, root: number, p: string, c: number) =>
    db.run("INSERT INTO files(id, root, path, size, mtime, seen, state, content) VALUES (?, ?, ?, 10, 0, 1, 50, ?)", id, root, p, c);
  file(1, 1, "only.txt", 10);
  file(2, 1, "shared.txt", 20);
  file(3, 2, "shared copy.txt", 20);

  removeRoot(db, 1);

  const n = (sql: string, ...a: number[]) => db.get<{ n: number }>(sql, ...a)!.n;
  assert.equal(n("SELECT count(*) AS n FROM files WHERE root = 1"), 0);
  assert.equal(n("SELECT count(*) AS n FROM contents WHERE id = 10"), 0, "content only folder A had is gone");
  assert.equal(n("SELECT count(*) AS n FROM texts WHERE content = 10"), 0, "and so is its text");
  assert.equal(n("SELECT count(*) AS n FROM fts_text WHERE fts_text MATCH 'only'"), 0, "and its search entry");
  assert.equal(n("SELECT count(*) AS n FROM contents WHERE id = 20"), 1, "content folder B still has survives");
  assert.equal(n("SELECT count(*) AS n FROM fts_text WHERE fts_text MATCH 'both'"), 1, "and is still searchable");
});
