// Database checks and backups, on their own thread and their own READ-ONLY
// connection (src/db/maintenance.ts). A check of a large database takes seconds;
// on the main thread that would stall the engine, the web pages and the service's
// liveness signal. A read-only connection cannot change the database, whatever
// happens here.
//
//   { op: "check", file, full }   quick_check (or integrity_check when full)
//   { op: "backup", file, out }   quick_check the source, VACUUM INTO `out` (a
//                                 consistent snapshot, taken while Atlas keeps
//                                 writing), then integrity_check the copy
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

interface Job { op: "check" | "backup"; file: string; full?: boolean; out?: string }
const job = workerData as Job;

/** Run an integrity pragma; "ok" is the single row of a clean database, anything else lists problems. */
function verify(db: DatabaseSync, pragma: "quick_check" | "integrity_check"): { ok: boolean; detail: string[] } {
  const rows = db.prepare(`PRAGMA ${pragma}(20)`).all() as Record<string, string>[];
  const lines = rows.map((r) => String(Object.values(r)[0]));
  return { ok: lines.length === 1 && lines[0] === "ok", detail: lines[0] === "ok" ? [] : lines };
}

function open(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
/** Which database an error is about: the live one (untrustworthy) or the copy being made (a failed backup). */
let step: "source" | "vacuum" | "verify" = "source";
// The reply is sent only once every connection is CLOSED: the caller renames the copy
// next, and Windows refuses to rename a file something still has open.
let reply: Record<string, unknown>;
try {
  if (job.op === "check") {
    const db = open(job.file);
    try {
      reply = { ...verify(db, job.full ? "integrity_check" : "quick_check") };
    } finally { db.close(); }
  } else {
    const src = open(job.file);
    let source: { ok: boolean; detail: string[] };
    try {
      // A copy of a damaged database is a damaged backup that looks like a good one.
      source = verify(src, "quick_check");
      step = "vacuum";
      if (source.ok) src.exec(`VACUUM INTO '${job.out!.replaceAll("'", "''")}'`);
    } finally { src.close(); }
    if (!source.ok) {
      reply = { ok: false, stage: "source", detail: source.detail };
    } else {
      // The backup must be proven readable and whole before it may replace an older one.
      step = "verify";
      const copy = open(job.out!);
      try {
        const r = verify(copy, "integrity_check");
        const schema = copy.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined;
        reply = { ok: r.ok, stage: "copy", detail: r.detail, schema: schema ? Number(schema.value) : null };
      } finally { copy.close(); }
    }
  }
} catch (e) {
  // Opening or checking the live database failed: it is not trustworthy. While copying,
  // only damage (SQLITE_CORRUPT 11, SQLITE_NOTADB 26) is about the source; anything else
  // (a full disk, a permission) is a failed backup and says nothing about the database.
  // Trouble reading the finished copy is always the copy's.
  const code = (e as { errcode?: number }).errcode;
  const stage = step === "source" || (step === "vacuum" && (code === 11 || code === 26)) ? "source" : "copy";
  reply = { ok: false, stage, detail: [(e as Error).message] };
}
parentPort!.postMessage({ ...reply, ms: ms() });
