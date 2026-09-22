// Apply: make the disk look like the plan. The first code in Atlas that moves a
// person's files, so every step is written down first and proven after.
//
// planApply()  turns the plan into a batch of journal rows (ops, PLANNED). It
//              writes the journal only; no file is touched. Each row records what
//              must be true for the move to happen (the file's ID, size, date and
//              SHA-256) and what to restore on a copy (its creation time).
// runBatch()   performs a batch, one file at a time:
//                1. STARTED, durably, before the file is touched
//                2. the source is still exactly the file on record; the destination is
//                   free - on disk and in the index. Otherwise FAILED, nothing done
//                3a same volume: a rename that NEVER replaces (native MoveFileExW);
//                   then the destination must be that same file (its ID)
//                3b another volume: copy to a temporary name beside the destination
//                   (never replacing), flush it to disk, hash it - it must be the
//                   recorded SHA-256 - give it the original's creation time, rename it
//                   into place (never replacing); only then, and only if the source is
//                   still exactly the file that was copied, delete the source
//                4. the index row follows the file, and the op is DONE: one durable
//                   transaction
//              A failure before anything changed is FAILED (retryable, nothing to
//              undo). Anything unexpected after the disk changed is REVIEW: a person
//              looks; nothing is guessed. A move blocked by a file of the same batch
//              that has yet to move away waits for a later pass.
// planUndo()   the reverse of a batch, as a new batch run the same way.
//
// Never: overwrite a file, delete a file that has not been copied and verified, or
// touch a duplicate (only a content's representative is moved; its copies stay
// where they are - the same bytes are not the same document).
import path from "node:path";
import type { Db } from "../db/db.ts";
import { S, OP, PLACEHOLDER_ATTRS } from "../pipeline/states.ts";
import { planKey } from "../plan/key.ts";
import { nameText } from "../search/text.ts";
import { volumeAt } from "../scan/volumes.ts";
import type { FsOps, FileFacts } from "./fsops.ts";

export class ApplyError extends Error {}

export interface Skip { reason: string; count: number; samples: string[] }
export interface ApplyPlan {
  batch: number | null; ops: number; renames: number; copies: number; bytes: number; inPlace: number; skipped: Skip[];
}

export interface Op {
  id: number; batch: number; file: number; src: string; dst: string; fid: string | null; size: number; mtime: number;
  sha: Uint8Array; birth: number | null; mode: "rename" | "copy"; tmp: string | null;
  sroot: number; spath: string; droot: number; dpath: string; undoes: number | null;
}

const abs = (root: string, rel: string) => path.join(root, ...rel.split("/"));
const stableFs = (fs: string | null) => fs === "NTFS" || fs === "ReFS";

/**
 * Step 4 of a move, shared with recovery (apply/recover.ts): the file's row, its name
 * in the index, and the op marked DONE - one durable transaction, so the database
 * never says a move happened without the row that proves where the file now is.
 *
 * `placed` is what is actually at the destination now. A file ID is kept only where
 * the file system has stable ones; elsewhere the next scan identifies the file.
 */
export function commitMove(db: Db, op: Op, placed: FileFacts, note: string | null): void {
  const destFs = db.get<{ fs: string | null }>("SELECT fs FROM roots WHERE id = ?", op.droot)?.fs ?? null;
  const fid = stableFs(destFs) ? placed.fid : null;
  db.durable(() => {
    const moved = db.run(
      "UPDATE files SET root = ?, path = ?, fid = ?, missed = NULL, seenat = NULL WHERE id = ? AND root = ? AND path = ?",
      op.droot, op.dpath, fid, op.file, op.sroot, op.spath).changes;
    if (moved) {
      db.run("DELETE FROM fts_name WHERE rowid = ?", op.file);
      db.run("INSERT INTO fts_name(rowid, name) VALUES (?, ?)", op.file, nameText(op.dpath.replaceAll("/", " ")));
    }
    db.run(`UPDATE ops SET state = ${OP.DONE}, step = 'done', err = ?, t1 = ? WHERE id = ?`,
      note ?? (moved ? null : "The index had changed meanwhile; the next scan reconciles it."), Date.now(), op.id);
    if (op.undoes) db.run(`UPDATE ops SET state = ${OP.UNDONE} WHERE id = ? AND state = ${OP.DONE}`, op.undoes);
  });
}

/** Is a batch still open (anything planned, in flight, or waiting for a person)? */
function openBatch(db: Db): { batch: number; planned: number; started: number; review: number } | undefined {
  return db.get(
    `SELECT batch, sum(state = ${OP.PLANNED}) AS planned, sum(state = ${OP.STARTED}) AS started, sum(state = ${OP.REVIEW}) AS review
     FROM ops WHERE state IN (${OP.PLANNED}, ${OP.STARTED}, ${OP.REVIEW}) GROUP BY batch ORDER BY batch LIMIT 1`);
}

/**
 * Plan a batch: every planned file that is not where the plan puts it, moved into
 * the library root `destRootId`. `dryRun` counts without writing anything.
 * `mode: "copy"` forces the copy protocol even on one volume (tests, diagnostics).
 */
export async function planApply(db: Db, destRootId: number, opts: { limit?: number; dryRun?: boolean; mode?: "auto" | "copy" } = {}): Promise<ApplyPlan> {
  const dest = db.get<{ id: number; path: string; role: string; enabled: number; online: number; volume: string | null; fs: string | null }>(
    "SELECT id, path, role, enabled, online, volume, fs FROM roots WHERE id = ?", destRootId);
  if (!dest) throw new ApplyError(`No folder with id ${destRootId}.`);
  if (dest.role !== "library") throw new ApplyError(`"${dest.path}" is not a library folder. Apply only moves files into a folder with the role "library".`);
  if (!dest.enabled || !dest.online) throw new ApplyError(`"${dest.path}" is disabled or offline.`);
  const v = await volumeAt(dest.path);
  if (!v) throw new ApplyError(`"${dest.path}" cannot be reached.`);
  if (dest.volume && v !== dest.volume) throw new ApplyError(`A different disk is at "${dest.path}" (volume ${v}, expected ${dest.volume}).`);
  const open = openBatch(db);
  if (open) {
    throw new ApplyError(`Batch ${open.batch} is not finished (${open.planned} planned, ${open.started} interrupted, ${open.review} for review).`
      + ` Run it (run ${open.batch} --yes), drop what has not run (cancel ${open.batch})`
      + `${open.started ? ", settle what was interrupted (recover)" : ""}${open.review ? ", or look at what is waiting (show + settle <op> --yes)" : ""}.`);
  }

  const skipped = new Map<string, Skip>();
  const skip = (reason: string, what: string) => {
    const s = skipped.get(reason) ?? { reason, count: 0, samples: [] };
    s.count++;
    if (s.samples.length < 10) s.samples.push(what);
    skipped.set(reason, s);
  };
  const cloud = db.get<{ n: number }>(`SELECT count(*) AS n FROM files WHERE state = ${S.DONE} AND plan IS NOT NULL AND content IS NULL`)!.n;
  if (cloud) skipped.set("cloud-only files (not on this computer)", { reason: "cloud-only files (not on this computer)", count: cloud, samples: [] });

  const rows = db.all<{
    id: number; root: number; path: string; plan: string; size: number; mtime: number; ctime: number; fid: string | null; attrs: number;
    missed: number | null; sha: Uint8Array; rootPath: string; online: number; enabled: number; volume: string | null;
  }>(`SELECT f.id, f.root, f.path, f.plan, f.size, f.mtime, f.ctime, f.fid, f.attrs, f.missed, c.sha,
          r.path AS rootPath, r.online, r.enabled, r.volume
     FROM files f JOIN roots r ON r.id = f.root JOIN contents c ON c.id = f.content
     WHERE f.state = ${S.DONE} AND f.plan IS NOT NULL ORDER BY f.plankey`);
  // Who is in the library root already, by place (as the disk compares names): a place
  // taken by a file that is not moving away is never planned into.
  const atDest = new Map<string, number>();
  for (const r of db.all<{ id: number; path: string }>("SELECT id, path FROM files WHERE root = ?", dest.id)) atDest.set(planKey(r.path), r.id);

  const movers: typeof rows = [];
  let inPlace = 0;
  for (const f of rows) {
    const where = `${f.rootPath} › ${f.path}`;
    if (f.root === dest.id && f.path === f.plan) { inPlace++; continue; }
    if (f.attrs & PLACEHOLDER_ATTRS) { skip("cloud-only files (not on this computer)", where); continue; }
    if (f.missed != null) { skip("not seen by the last scan", where); continue; }
    if (!f.online || !f.enabled) { skip("their folder is offline or disabled", where); continue; }
    movers.push(f);
  }
  const moving = new Set(movers.map((f) => f.id));
  const chosen: typeof rows = [];
  const dsts = new Set<string>();
  for (const f of movers) {
    const where = `${f.rootPath} › ${f.path}`;
    const holder = atDest.get(planKey(f.plan));
    if (holder != null && holder !== f.id && !moving.has(holder)) { skip("another file is at that place in the library", where); continue; }
    const key = planKey(f.plan);
    if (dsts.has(key)) { skip("two files are planned to one place", where); continue; }
    dsts.add(key);
    chosen.push(f);
    if (opts.limit && chosen.length >= opts.limit) break;
  }

  let renames = 0, copies = 0, bytes = 0;
  const modeOf = (f: { volume: string | null }) =>
    opts.mode !== "copy" && f.volume != null && f.volume === dest.volume ? "rename" : "copy";
  for (const f of chosen) { if (modeOf(f) === "rename") renames++; else { copies++; bytes += f.size; } }
  const plan: ApplyPlan = { batch: null, ops: chosen.length, renames, copies, bytes, inPlace, skipped: [...skipped.values()] };
  if (opts.dryRun || !chosen.length) return plan;

  const batch = (db.get<{ b: number | null }>("SELECT max(batch) AS b FROM ops")!.b ?? 0) + 1;
  const insert = db.q(
    `INSERT INTO ops(batch, kind, file, src, dst, fid, size, mtime, sha, birth, mode, tmp, sroot, spath, droot, dpath, state)
     VALUES (?, 'move', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${OP.PLANNED})`);
  db.durable(() => {
    for (const f of chosen) {
      const mode = modeOf(f);
      const src = abs(f.rootPath, f.path);
      const dst = abs(dest.path, f.plan);
      insert.run(batch, f.id, src, dst, f.fid, f.size, f.mtime, f.sha, f.ctime > 0 ? f.ctime : null, mode,
        mode === "copy" ? `${dst}.atlas-${batch}-${f.id}.tmp` : null, f.root, f.path, dest.id, f.plan);
    }
  });
  plan.batch = batch;
  return plan;
}

export interface RunReport { batch: number; done: number; failed: number; review: number; notes: string[] }

/**
 * Perform a batch (see the top of this file). Resumable: only PLANNED ops are run,
 * so a batch stopped half-way continues where it stopped. Refuses to start while an
 * op is STARTED (a crash left a file possibly half-way: that is reconciled first).
 */
export async function runBatch(db: Db, batch: number, fx: FsOps, opts: { stop?: () => boolean } = {}): Promise<RunReport> {
  const stuck = db.get<{ n: number }>(`SELECT count(*) AS n FROM ops WHERE state = ${OP.STARTED}`)!.n;
  if (stuck) throw new ApplyError(`${stuck} operation(s) were interrupted and are settled first: npm run apply -- recover`);
  const report: RunReport = { batch, done: 0, failed: 0, review: 0, notes: [] };
  let pending = db.all<Op>(`SELECT * FROM ops WHERE batch = ? AND state = ${OP.PLANNED} ORDER BY id`, batch);
  // Sources of ops still to run: a destination held by one of them is not a conflict,
  // only a matter of order.
  const leaving = new Set(pending.map((o) => planKey(o.src)));

  const setStep = db.q("UPDATE ops SET step = ? WHERE id = ?");
  const end = (op: Op, state: number, err: string | null) =>
    db.durable(() => db.run("UPDATE ops SET state = ?, err = ?, t1 = ? WHERE id = ?", state, err, Date.now(), op.id));

  const runOne = async (op: Op): Promise<"done" | "failed" | "review" | "deferred"> => {
    // 1. Written down before anything is touched.
    const started = db.durable(() =>
      db.run(`UPDATE ops SET state = ${OP.STARTED}, t0 = ?, step = NULL, err = NULL WHERE id = ? AND state = ${OP.PLANNED}`, Date.now(), op.id).changes);
    if (!started) return "failed";
    let touched = false; // has anything on disk changed for this op?
    const fail = (err: string) => { end(op, touched ? OP.REVIEW : OP.FAILED, err); return touched ? "review" as const : "failed" as const; };
    const later = () => {
      db.durable(() => db.run(`UPDATE ops SET state = ${OP.PLANNED}, t0 = NULL WHERE id = ?`, op.id));
      return "deferred" as const;
    };
    const sameFile = (s: FileFacts | null) => s != null && s.size === op.size && s.mtime === op.mtime && (!op.fid || s.fid === op.fid);
    const dropTmp = async () => {
      try { if (op.tmp && await fx.stat(op.tmp)) await fx.remove(op.tmp); }
      catch { touched = true; report.notes.push(`A temporary copy could not be removed: ${op.tmp}`); }
    };
    try {
      // 2. The source is still exactly the file on record; the destination is free.
      const s = await fx.stat(op.src);
      if (!s) return fail("The file is no longer where it was when the batch was planned.");
      if (!sameFile(s)) return fail("The file changed since the batch was planned. Plan again.");
      const d = await fx.stat(op.dst);
      if (d && !(op.fid && d.fid === op.fid)) { // (the same file under another case is a rename of case)
        if (leaving.has(planKey(op.dst))) return later();
        return fail("Something is already at the destination. It is never overwritten.");
      }
      const held = db.get<{ id: number }>("SELECT id FROM files WHERE root = ? AND path = ? AND id <> ?", op.droot, op.dpath, op.file);
      if (held) return fail("Atlas still remembers another file at the destination (missing now). Resolve that first.");
      await fx.mkdirp(path.dirname(op.dst));

      let placed: FileFacts | null;
      const notes: string[] = [];
      if (op.mode === "rename") {
        // 3a. One volume: an atomic rename that never replaces.
        try { await fx.move(op.src, op.dst); } catch (e) {
          const c = (e as { code?: string }).code;
          if (c === "EXIST") return leaving.has(planKey(op.dst)) ? later() : fail("Something appeared at the destination. It is never overwritten.");
          if (c === "BUSY") return fail("The file is open in another program. Try again later.");
          if (c === "NOENT") return fail("The file is no longer where it was when the batch was planned.");
          if (c === "XDEV") return fail("The file is not on the same disk as the library. Plan again.");
          return fail(`Could not move it: ${(e as Error).message}`);
        }
        touched = true;
        setStep.run("moved", op.id);
        placed = await fx.stat(op.dst);
        if (!placed || placed.size !== op.size || (op.fid && placed.fid !== op.fid)) return fail("Moved, but what is at the destination is not the file expected.");
      } else {
        // 3b. Another volume: copy, prove, place; only then delete the original.
        const tmp = op.tmp!;
        await dropTmp(); // left by an earlier attempt of this same op (the name is this op's own)
        try { await fx.copy(op.src, tmp); } catch (e) {
          await dropTmp();
          const c = (e as { code?: string }).code;
          if (c === "BUSY") return fail("The file is open in another program. Try again later.");
          if (c === "NOENT") return fail("The file is no longer where it was when the batch was planned.");
          return fail(`Could not copy it: ${(e as Error).message}`);
        }
        setStep.run("copied", op.id);
        try {
          await fx.flush(tmp);
        } catch (e) {
          await dropTmp();
          return fail(`The copy could not be flushed to the disk: ${(e as Error).message}`);
        }
        let sha: string;
        try {
          sha = await fx.hash(tmp);
        } catch (e) {
          await dropTmp();
          return fail(`The copy could not be read back to prove it: ${(e as Error).message}`);
        }
        if (sha !== Buffer.from(op.sha).toString("hex")) {
          await dropTmp();
          return fail("The copy is not the file's recorded content (did it change?). The original is untouched.");
        }
        setStep.run("verified", op.id);
        // The creation time the original has NOW (the index's may be older than a restore
        // tool's touch-up); the one recorded at planning only if the disk gave none.
        const born = s.birth > 0 ? s.birth : op.birth;
        if (born) {
          // A date is not worth refusing a proven copy over: keep it where it can be kept,
          // and say so where it cannot.
          try { await fx.setCreated(tmp, born); }
          catch (e) { notes.push(`The creation date could not be restored (${(e as { code?: string }).code ?? "error"}).`); }
        }
        try { await fx.move(tmp, op.dst); } catch (e) {
          await dropTmp();
          const c = (e as { code?: string }).code;
          if (c === "EXIST") return leaving.has(planKey(op.dst)) ? later() : fail("Something appeared at the destination. It is never overwritten.");
          return fail(`Could not put the copy in place: ${(e as Error).message}`);
        }
        touched = true;
        setStep.run("placed", op.id);
        placed = await fx.stat(op.dst);
        if (!placed || placed.size !== op.size) return fail("Copied, but what is at the destination is not the file expected.");
        // The original goes only if it is still exactly what was copied.
        if (!sameFile(await fx.stat(op.src))) {
          return fail("Copied into the library, but the original changed meanwhile: both are kept. Check which one is right.");
        }
        try {
          await fx.remove(op.src);
          setStep.run("source-removed", op.id);
        } catch (e) {
          const said = `The original could not be deleted (${(e as { code?: string }).code ?? "error"}); it is still at ${op.src}.`;
          notes.push(said);
          report.notes.push(said);
        }
      }

      // 4. The index follows the file, in the same durable transaction that says DONE.
      commitMove(db, op, placed, notes.join(" ") || null);
      return "done";
    } catch (e) {
      return fail(`Unexpected: ${(e as Error).message}`);
    }
  };

  // Passes: an op waiting for another file of the batch to move away runs again after
  // it. A pass that makes no progress means a cycle: those fail, with nothing done.
  for (;;) {
    const waiting: Op[] = [];
    let progress = false;
    for (const op of pending) {
      if (opts.stop?.()) { report.notes.push("Stopped on request; the rest of the batch is still planned."); return report; }
      const r = await runOne(op);
      if (r === "deferred") { waiting.push(op); continue; }
      progress = true;
      leaving.delete(planKey(op.src));
      if (r === "done") report.done++;
      else if (r === "review") report.review++;
      else report.failed++;
    }
    if (!waiting.length) break;
    if (!progress) {
      for (const op of waiting) {
        db.durable(() => db.run(`UPDATE ops SET state = ${OP.FAILED}, err = ?, t1 = ? WHERE id = ? AND state = ${OP.PLANNED}`,
          "Its destination is held by another file of this batch that could not move first (a cycle). Nothing was changed.", Date.now(), op.id));
        report.failed++;
      }
      break;
    }
    pending = waiting;
  }
  return report;
}

/** The reverse of a batch's DONE ops, as a new batch (run it with runBatch). */
export function planUndo(db: Db, batch: number): { batch: number; ops: number; skipped: string[] } {
  const open = openBatch(db);
  if (open) throw new ApplyError(`Batch ${open.batch} is not finished (${open.planned} planned, ${open.started} interrupted, ${open.review} for review). Finish it before undoing anything.`);
  const done = db.all<Op>(`SELECT * FROM ops WHERE batch = ? AND state = ${OP.DONE} ORDER BY id DESC`, batch);
  const skipped: string[] = [];
  const next = (db.get<{ b: number | null }>("SELECT max(batch) AS b FROM ops")!.b ?? 0) + 1;
  const insert = db.q(
    `INSERT INTO ops(batch, kind, file, src, dst, fid, size, mtime, sha, birth, mode, tmp, sroot, spath, droot, dpath, state, undoes)
     VALUES (?, 'move', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${OP.PLANNED}, ?)`);
  let n = 0;
  db.durable(() => {
    for (const op of done) {
      const f = db.get<{ root: number; path: string; fid: string | null; size: number; mtime: number }>(
        "SELECT root, path, fid, size, mtime FROM files WHERE id = ?", op.file);
      // Only a file still where the batch put it can be put back.
      if (!f || f.root !== op.droot || f.path !== op.dpath) { skipped.push(op.dst); continue; }
      insert.run(next, op.file, op.dst, op.src, f.fid, f.size, f.mtime, op.sha, op.birth, op.mode,
        op.mode === "copy" ? `${op.src}.atlas-${next}-${op.file}.tmp` : null, op.droot, op.dpath, op.sroot, op.spath, op.id);
      n++;
    }
  });
  return { batch: next, ops: n, skipped };
}

/** Drop what has not run yet from a batch. Nothing on disk is involved. */
export function cancelBatch(db: Db, batch: number): number {
  return Number(db.durable(() =>
    db.run(`UPDATE ops SET state = ${OP.FAILED}, err = 'cancelled before it ran', t1 = ? WHERE batch = ? AND state = ${OP.PLANNED}`, Date.now(), batch).changes));
}

export function listBatches(db: Db) {
  return db.all<{ batch: number; ops: number; planned: number; started: number; done: number; failed: number; undone: number; review: number; undo: number; t0: number | null; t1: number | null }>(
    `SELECT batch, count(*) AS ops, sum(state = ${OP.PLANNED}) AS planned, sum(state = ${OP.STARTED}) AS started, sum(state = ${OP.DONE}) AS done,
            sum(state = ${OP.FAILED}) AS failed, sum(state = ${OP.UNDONE}) AS undone, sum(state = ${OP.REVIEW}) AS review,
            max(undoes IS NOT NULL) AS undo, min(t0) AS t0, max(t1) AS t1
     FROM ops GROUP BY batch ORDER BY batch DESC`);
}
