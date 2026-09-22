// Apply: move files to where the plan puts them (src/apply/apply.ts).
//
//   npm run apply -- list                              batches and their states
//   npm run apply -- preview --to <root id> [--limit N] what a batch would do (writes nothing)
//   npm run apply -- plan --to <root id> [--limit N]    write a batch to the journal (no file moves)
//   npm run apply -- run <batch> --yes                  move the files of a batch
//   npm run apply -- undo <batch> --yes                 put a batch's files back
//   npm run apply -- cancel <batch>                     drop what has not run (nothing on disk)
//   npm run apply -- show <batch>                       every operation of a batch, with its outcome
//
// Everything here writes to the database, and `run`/`undo` move real files, so it
// runs with Atlas stopped (the lock in src/lock.ts enforces it) and moving anything
// needs --yes. The destination must be a folder registered with the role "library".
import path from "node:path";
import { config } from "../src/config.ts";
import { Db } from "../src/db/db.ts";
import { acquireLock } from "../src/lock.ts";
import { planApply, runBatch, planUndo, cancelBatch, listBatches, ApplyError } from "../src/apply/apply.ts";
import { nativeFsOps } from "../src/apply/fsops.ts";
import { OP } from "../src/pipeline/states.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cmd = args[0];
const num = (s: string | undefined) => (s != null && /^\d+$/.test(s) ? Number(s) : null);
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const STATE: Record<number, string> = { [OP.PLANNED]: "planned", [OP.STARTED]: "INTERRUPTED", [OP.DONE]: "done", [OP.FAILED]: "failed", [OP.UNDONE]: "undone", [OP.REVIEW]: "REVIEW" };

if (!cmd || !["list", "preview", "plan", "run", "undo", "cancel", "show"].includes(cmd)) {
  console.log("usage: npm run apply -- list | preview --to <root> | plan --to <root> | run <batch> --yes | undo <batch> --yes | cancel <batch> | show <batch>");
  process.exit(cmd ? 1 : 0);
}
const lock = acquireLock(`apply ${cmd}`);
if (!lock) { console.error("Another Atlas process is using the database. Stop Atlas first: Apply writes to its database and moves files."); process.exit(1); }
const db = new Db(path.join(config.home, "atlas.db"));
let code = 0;
try {
  if (cmd === "list") {
    const all = listBatches(db);
    if (!all.length) console.log("No batches yet.");
    for (const b of all) {
      console.log(`batch ${b.batch}${b.undo ? " (undo)" : ""}: ${b.ops} op(s) - ${b.done} done, ${b.failed} failed, ${b.planned} planned, ${b.undone} undone`
        + (b.started ? `, ${b.started} INTERRUPTED` : "") + (b.review ? `, ${b.review} FOR REVIEW` : ""));
    }
  } else if (cmd === "preview" || cmd === "plan") {
    const to = num(value("--to"));
    if (to == null) throw new ApplyError("Say which library folder: --to <root id> (see the Folders page).");
    const p = await planApply(db, to, { limit: num(value("--limit")) ?? undefined, dryRun: cmd === "preview" });
    console.log(`${p.ops} file(s) to move: ${p.renames} renamed on the same disk, ${p.copies} copied across disks (${mb(p.bytes)}). ${p.inPlace} already in place.`);
    for (const s of p.skipped) {
      console.log(`  not moved - ${s.reason}: ${s.count}`);
      for (const x of s.samples.slice(0, 3)) console.log(`      ${x}`);
    }
    if (p.batch != null) console.log(`\nWritten as batch ${p.batch}. Nothing has moved yet. To move them: npm run apply -- run ${p.batch} --yes`);
    else if (cmd === "plan") console.log("Nothing to do.");
  } else if (cmd === "run" || cmd === "undo") {
    let batch = num(args[1]);
    if (batch == null) throw new ApplyError(`Which batch? npm run apply -- ${cmd} <batch> --yes`);
    if (!flag("--yes")) throw new ApplyError(`This moves real files. Add --yes to go ahead: npm run apply -- ${cmd} ${batch} --yes`);
    if (cmd === "undo") {
      const u = planUndo(db, batch);
      console.log(`Undo of batch ${batch} written as batch ${u.batch}: ${u.ops} file(s) to put back.`);
      for (const s of u.skipped.slice(0, 10)) console.log(`  not put back (moved since): ${s}`);
      batch = u.batch;
    }
    const fx = nativeFsOps();
    let stop = false;
    process.on("SIGINT", () => { stop = true; console.log("\nStopping after the current file..."); });
    try {
      const r = await runBatch(db, batch, fx, { stop: () => stop });
      console.log(`batch ${batch}: ${r.done} done, ${r.failed} failed (nothing changed), ${r.review} for review.`);
      for (const n of r.notes) console.log(`  ${n}`);
      if (r.failed || r.review) console.log(`Details: npm run apply -- show ${batch}`);
      if (r.review) code = 2;
    } finally {
      fx.close();
    }
  } else if (cmd === "cancel") {
    const batch = num(args[1]);
    if (batch == null) throw new ApplyError("Which batch? npm run apply -- cancel <batch>");
    console.log(`${cancelBatch(db, batch)} planned operation(s) cancelled. Nothing on disk was involved.`);
  } else if (cmd === "show") {
    const batch = num(args[1]);
    if (batch == null) throw new ApplyError("Which batch? npm run apply -- show <batch>");
    for (const o of db.all<{ id: number; state: number; mode: string; src: string; dst: string; step: string | null; err: string | null }>(
      "SELECT id, state, mode, src, dst, step, err FROM ops WHERE batch = ? ORDER BY id", batch)) {
      console.log(`#${o.id} ${STATE[o.state]} (${o.mode}${o.step ? `, last step: ${o.step}` : ""})\n    ${o.src}\n -> ${o.dst}${o.err ? `\n    ${o.err}` : ""}`);
    }
  }
} catch (e) {
  if (e instanceof ApplyError) { console.error(e.message); code = 1; } else throw e;
} finally {
  db.close();
  lock.release();
}
process.exit(code);
