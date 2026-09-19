// The one SQLite connection. The engine is the only writer, by design, so there
// is no pool and no lock management: WAL lets the HTTP handlers read while the
// pipeline writes, and every write goes through short transactions.
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./schema.ts";

export type Row = Record<string, SQLInputValue>;

export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file, { enableForeignKeyConstraints: false, allowExtension: false });
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -65536;
      PRAGMA mmap_size = 268435456;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
  }

  /** A cached prepared statement. Every hot-path query goes through here. */
  q(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.q(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.q(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.q(sql).run(...params);
  }

  /** Run `fn` in one transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const r = fn();
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  /**
   * A transaction that is on disk before this returns, even across power loss.
   * WAL + synchronous=NORMAL (the default above) survives a process crash but can
   * lose the last commits on power loss; the file-operation journal cannot, because
   * its whole job is to say what was about to happen to a real file.
   */
  durable<T>(fn: () => T): T {
    this.raw.exec("PRAGMA synchronous = FULL");
    try {
      return this.tx(fn);
    } finally {
      this.raw.exec("PRAGMA synchronous = NORMAL");
    }
  }

  meta(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  }

  setMeta(key: string, value: string) {
    this.run("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  close() {
    this.cache.clear();
    try { this.raw.exec("PRAGMA optimize"); } catch { /* best effort */ }
    this.raw.close();
  }

  private migrate() {
    this.raw.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
    const current = Number(this.meta("schema") ?? 0);
    for (let v = current + 1; v <= MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v - 1]);
        this.setMeta("schema", String(v));
      });
    }
  }
}
