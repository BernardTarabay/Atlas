// Fault injection for Apply (Phase 8 of docs/18-v2-reliability-audit.md): kill a real
// Apply process at every point of the protocol, on throwaway folders, and prove the
// same things every time.
//
//   npm run bench:apply-crash [-- --files 8]
//
// For each kill point, in both protocols: build a small library, plan it, run it in a
// child process that is killed at that point, then `recover`, then finish the batch.
// After each round:
//
//   nothing is lost        every file's content is somewhere, and the bytes still hash
//                          to what was recorded
//   nothing is overwritten a file that was already in the library is untouched
//   nothing is left over   no temporary file anywhere, no operation still in flight
//   the index is true      every row points at a file that is really there
//   it ends where a clean run ends: every file in the library, the source folder empty
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
process.env.ATLAS_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), "atlas-applycrash-"));
process.env.ATLAS_LOG_LEVEL ??= "error";
process.env.ATLAS_SETTLE_S ??= "0";
const { Db } = await import("../src/db/db.ts");
const { library } = await import("../test/_library.ts");
const { planApply, runBatch } = await import("../src/apply/apply.ts");
const { nativeFsOps } = await import("../src/apply/fsops.ts");
const { recover } = await import("../src/apply/recover.ts");
const { OP } = await import("../src/pipeline/states.ts");

const args = process.argv.slice(2);
const fi = args.indexOf("--files");
const FILES = fi >= 0 ? Number(args[fi + 1]) : 8;
const POINTS = ["before-move", "after-move", "after-copy", "after-verify", "after-place", "after-source"] as const;
const CANARY = "A FILE THAT WAS ALREADY IN THE LIBRARY";
const run = promisify(execFile);
const fx = nativeFsOps();
const cleanup: (() => void)[] = [];
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function findLitter(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.includes(".atlas-")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

interface Round { point: string; mode: string; killed: boolean; interrupted: number; verdicts: string; failures: string[] }

async function round(point: string, mode: "auto" | "copy", n: number): Promise<Round> {
  const name = `crash-${point}-${mode}-${n}`;
  const files: Record<string, string> = {};
  for (let i = 0; i < FILES; i++) files[`file ${i}.txt`] = `the content of file ${i}, ${crypto.randomBytes(8).toString("hex")}`;
  const { src, lib, db } = await library(name, files, cleanup);
  // A file already in the library, in nobody's way: it must still be here at the end.
  const canary = path.join(lib, "already-here.txt");
  fs.writeFileSync(canary, CANARY);
  const wanted = new Map(db.all<{ id: number; plan: string }>("SELECT id, plan FROM files WHERE plan IS NOT NULL").map((r) => [r.id, r.plan]));
  const before = new Map([...wanted.keys()].map((id) => {
    const row = db.get<{ path: string; root: number }>("SELECT path, root FROM files WHERE id = ?", id)!;
    return [id, sha(path.join(src, row.path))];
  }));

  const p = await planApply(db, 2, { mode });
  const dbFile = db.get<{ file: string }>("PRAGMA database_list")!.file;
  db.close();
  const out = await run(process.execPath, ["--disable-warning=ExperimentalWarning",
    path.join(import.meta.dirname, "..", "test", "_apply-kill.ts"), dbFile, String(p.batch), point])
    .catch((e: { stdout?: string }) => e);
  const killed = !(out.stdout ?? "").includes("finished without being killed");

  const db2 = new Db(dbFile);
  cleanup.push(() => db2.close());
  const interrupted = db2.all(`SELECT id FROM ops WHERE state = ${OP.STARTED}`).length;
  const r = await recover(db2, fx);
  const verdicts = r.findings.map((f) => f.verdict).sort().join(",") || "-";
  await runBatch(db2, p.batch!, fx);

  const failures: string[] = [];
  const check = (ok: boolean, what: string) => { if (!ok) failures.push(what); };
  // Nothing lost, and the bytes are still the bytes.
  for (const [id, want] of before) {
    const row = db2.get<{ root: number; path: string }>("SELECT root, path FROM files WHERE id = ?", id)!;
    const where = path.join(row.root === 2 ? lib : src, ...row.path.split("/"));
    if (!fs.existsSync(where)) { failures.push(`lost: file ${id} is not at ${where}`); continue; }
    check(sha(where) === want, `changed: file ${id} at ${where}`);
  }
  check(fs.existsSync(canary) && fs.readFileSync(canary, "utf8") === CANARY, "the file that was already in the library was touched");
  check(findLitter(lib).length === 0, `temporary files left: ${findLitter(lib).join(", ")}`);
  check(db2.all(`SELECT id FROM ops WHERE batch = ? AND state IN (${OP.PLANNED}, ${OP.STARTED})`, p.batch!).length === 0, "operations still open");
  const review = db2.all(`SELECT id FROM ops WHERE batch = ? AND state = ${OP.REVIEW}`, p.batch!).length;
  check(review === 0, `${review} operation(s) need a person, which no kill point should cause`);
  // Where a clean run would have ended.
  const home = db2.all<{ root: number; path: string }>("SELECT root, path FROM files");
  check(home.every((f) => f.root === 2), "not every file reached the library");
  check(fs.readdirSync(src).length === 0, `${fs.readdirSync(src).length} file(s) left in the source folder`);
  return { point, mode, killed, interrupted, verdicts, failures };
}

const rounds: Round[] = [];
let n = 0;
for (const point of POINTS) {
  for (const mode of ["auto", "copy"] as const) {
    // A same-disk rename never reaches the copy protocol's points, and the other way round.
    if (mode === "auto" && ["after-copy", "after-verify", "after-place", "after-source"].includes(point)) continue;
    if (mode === "copy" && point === "after-move") continue;
    rounds.push(await round(point, mode, n++));
  }
}
fx.close();

console.log(`\nApply, killed at every point of the protocol (${FILES} files per round):\n`);
console.log("kill point".padEnd(14) + "protocol".padEnd(10) + "killed".padEnd(8) + "in flight".padEnd(11) + "recovery".padEnd(12) + "result");
let bad = 0;
for (const r of rounds) {
  const ok = r.failures.length === 0 && r.killed;
  if (!ok) bad++;
  console.log(r.point.padEnd(14) + (r.mode === "auto" ? "rename" : "copy").padEnd(10) + (r.killed ? "yes" : "NO").padEnd(8)
    + String(r.interrupted).padEnd(11) + r.verdicts.padEnd(12) + (ok ? "ok" : `FAILED: ${r.failures.join("; ")}`));
}
console.log(`\n${rounds.length - bad}/${rounds.length} rounds ended exactly where an uninterrupted run would have.`);
for (const f of cleanup.reverse()) try { f(); } catch { /* best effort */ }
fs.rmSync(process.env.ATLAS_HOME!, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
