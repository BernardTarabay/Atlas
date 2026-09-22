// Recovery: operations a crash, power cut or kill left in flight (ops rows STARTED).
// The matrix this implements is docs/18 §8b.
//
// Apply writes down what must be true BEFORE it touches a file, so afterwards the disk
// itself answers what happened - recovery never guesses. Each interrupted operation is
// read from its two ends (and, for a copy, its own temporary file) and gets one verdict:
//
//   planned  nothing happened: back to PLANNED, it simply runs again
//   failed   nothing happened, and it can no longer run as planned (the file changed)
//   finish   the move happened: the index and the journal are completed
//   review   anything else: a person looks, and nothing on disk is touched
//   check    only reachable when looking without reading the destination (the engine)
//
// Looking has no side effects: `inspect` stats, and hashes only when asked. `recover`
// is the only part that changes anything, and only these three things: it removes a
// temporary file of that operation's own name, deletes an original that is provably
// still the file that was copied, and writes the journal and index rows.
import type { Db } from "../db/db.ts";
import { OP } from "../pipeline/states.ts";
import { commitMove, type Op } from "./apply.ts";
import type { FsOps, FileFacts } from "./fsops.ts";

export type Verdict = "planned" | "failed" | "finish" | "review" | "check";

export interface Finding {
  op: number; batch: number; file: number; mode: "rename" | "copy"; src: string; dst: string;
  verdict: Verdict;
  /** Plain words: what the disk says, and therefore what will happen. */
  why: string;
  /** Actions `recover` would take for this one. */
  removeTmp: boolean;
  removeSource: boolean;
}

/** What is at each end of an operation right now. `dstSha` is undefined when unread. */
export interface OpFacts { src: FileFacts | null; dst: FileFacts | null; tmp: FileFacts | null; dstSha?: string | null }

const hex = (sha: Uint8Array) => Buffer.from(sha).toString("hex");

/**
 * One interrupted operation, decided from the facts alone. Pure: no disk, no database,
 * so every case in the matrix is a test (test/recover.test.ts).
 */
export function classify(op: Op, f: OpFacts): Finding {
  const base = { op: op.id, batch: op.batch, file: op.file, mode: op.mode, src: op.src, dst: op.dst };
  const say = (verdict: Verdict, why: string, acts: { removeTmp?: boolean; removeSource?: boolean } = {}): Finding =>
    ({ ...base, verdict, why, removeTmp: acts.removeTmp ?? false, removeSource: acts.removeSource ?? false });
  // "Still the file this operation was written for": the same size, date and, where the
  // disk gives one, the same file ID.
  const asRecorded = (x: FileFacts | null) => x != null && x.size === op.size && x.mtime === op.mtime && (!op.fid || x.fid === op.fid);
  const tmp = f.tmp != null;

  if (op.mode === "rename") {
    // A same-disk move is atomic: the file is at one end or the other, never both.
    if (f.dst && op.fid && f.dst.fid === op.fid) return say("finish", "the file is at its destination (the same file ID it had): the move happened");
    if (f.dst && !op.fid && !f.src && f.dst.size === op.size && f.dst.mtime === op.mtime) {
      return say("finish", "the file is at its destination with the size and date recorded, and gone from its source (this disk has no file IDs)");
    }
    if (f.dst) return say("review", "something that is not this file is at the destination; it is never touched");
    if (asRecorded(f.src)) return say("planned", "the file is still at its source, unchanged: the move had not happened");
    if (f.src) return say("failed", "the file is still at its source but has changed since it was planned; nothing was moved. Plan again");
    return say("review", "the file is neither at its source nor at its destination");
  }

  // A copy has three places to look, and the destination must be READ to be trusted.
  if (f.dst) {
    if (f.dstSha === undefined) return say("check", "a file is at the destination; Apply must read it to tell whether it is this file's copy", { removeTmp: tmp });
    if (f.dstSha === null) return say("review", "a file is at the destination and could not be read, so it cannot be told from this file's copy; it is never touched");
    if (f.dstSha !== hex(op.sha)) return say("review", "a file is at the destination and it is not this file's content; it is never touched");
    if (!f.src) return say("finish", "the copy is at the destination and proven, and the original is gone: the move happened", { removeTmp: tmp });
    if (asRecorded(f.src)) {
      return say("finish", "the copy is at the destination and proven; the original is unchanged, so it is deleted last, as the move would have", { removeTmp: tmp, removeSource: true });
    }
    return say("review", "the copy is at the destination, but the original changed after it was copied: both are kept for a person to compare");
  }
  if (asRecorded(f.src)) return say("planned", `the original is untouched and nothing is at the destination${tmp ? "; a half-written copy is removed" : ""}`, { removeTmp: tmp });
  if (f.src) return say("failed", "the original changed before the copy was placed; nothing is at the destination. Plan again", { removeTmp: tmp });
  return say("review", "the original is gone and nothing is at the destination");
}

/** Read-only. `hash` reads a copy's destination, which only Apply does. */
export async function inspect(db: Db, fx: Pick<FsOps, "stat"> & Partial<Pick<FsOps, "hash">>, opts: { hash?: boolean } = {}): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const op of db.all<Op>(`SELECT * FROM ops WHERE state = ${OP.STARTED} ORDER BY id`)) {
    const facts: OpFacts = { src: await fx.stat(op.src), dst: await fx.stat(op.dst), tmp: op.tmp ? await fx.stat(op.tmp) : null };
    if (opts.hash && fx.hash && facts.dst && op.mode === "copy") {
      try { facts.dstSha = await fx.hash(op.dst); } catch { facts.dstSha = null; }
    }
    out.push(classify(op, facts));
  }
  return out;
}

export interface RecoverReport { planned: number; failed: number; finished: number; review: number; notes: string[]; findings: Finding[] }

/**
 * Settle every interrupted operation. Apply holds the lock while this runs, so nothing
 * else is touching the database or the files.
 */
export async function recover(db: Db, fx: FsOps): Promise<RecoverReport> {
  const findings = await inspect(db, fx, { hash: true });
  const report: RecoverReport = { planned: 0, failed: 0, finished: 0, review: 0, notes: [], findings };
  const ops = new Map(db.all<Op>(`SELECT * FROM ops WHERE state = ${OP.STARTED}`).map((o) => [o.id, o]));
  const end = (id: number, state: number, err: string | null) =>
    db.durable(() => db.run("UPDATE ops SET state = ?, err = ?, t1 = ? WHERE id = ? AND state = ?", state, err, Date.now(), id, OP.STARTED));

  for (const f of findings) {
    const op = ops.get(f.op);
    if (!op) continue;
    let verdict = f.verdict;
    let why = f.why;
    // Only this operation's own temporary name is ever removed, and never in a case a
    // person still has to look at.
    if (f.removeTmp && verdict !== "review" && op.tmp) {
      try { if (await fx.stat(op.tmp)) await fx.remove(op.tmp); }
      catch (e) { report.notes.push(`A half-written copy could not be removed (${(e as { code?: string }).code ?? "error"}): ${op.tmp}`); }
    }
    if (verdict === "finish") {
      // Read the ends again: the decision was made a moment ago, and deleting an
      // original is the one step that cannot be taken back.
      const dst = await fx.stat(op.dst);
      if (!dst) { end(op.id, OP.REVIEW, "The destination was there a moment ago and is gone now; nothing else was done."); report.review++; continue; }
      if (f.removeSource) {
        const src = await fx.stat(op.src);
        const same = src && src.size === op.size && src.mtime === op.mtime && (!op.fid || src.fid === op.fid);
        if (src && !same) {
          end(op.id, OP.REVIEW, "The copy is in the library, but the original changed while this was being settled: both are kept.");
          report.review++;
          continue;
        }
        if (src) {
          try { await fx.remove(op.src); }
          catch (e) {
            why += `. The original could not be deleted (${(e as { code?: string }).code ?? "error"}); it is still at ${op.src}`;
            report.notes.push(`The original is still at ${op.src}: it could not be deleted.`);
          }
        }
      }
      commitMove(db, op, dst, `Completed after an interruption: ${why}.`);
      report.finished++;
      continue;
    }
    if (verdict === "check") { verdict = "review"; why = "it could not be read to decide"; } // only the engine looks without reading
    if (verdict === "planned") { db.durable(() => db.run(`UPDATE ops SET state = ${OP.PLANNED}, t0 = NULL, step = NULL, err = NULL WHERE id = ? AND state = ${OP.STARTED}`, op.id)); report.planned++; continue; }
    if (verdict === "failed") { end(op.id, OP.FAILED, `Interrupted, and ${why}.`); report.failed++; continue; }
    end(op.id, OP.REVIEW, `Interrupted, and ${why}.`);
    report.review++;
  }
  return report;
}

/** Mark a REVIEW operation settled once a person has looked. Touches no file. */
export function settle(db: Db, opId: number, note: string): number {
  return Number(db.durable(() => db.run(
    `UPDATE ops SET state = ${OP.FAILED}, err = ?, t1 = ? WHERE id = ? AND state = ${OP.REVIEW}`,
    `Settled by hand: ${note}. The next scan puts the index right.`, Date.now(), opId).changes));
}
