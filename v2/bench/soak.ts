// Endurance: the real engine, running against a folder that will not hold still.
//
//   npm run bench:soak -- [--minutes 20] [--files 20000] [--churn 400]
//
// A child process runs src/main.ts exactly as the service does (ATLAS_HOSTED=1, stopped
// by writing "shutdown" to its stdin). Meanwhile this process keeps changing the folder
// underneath it: new files, files saved over, files renamed, files deleted, a folder
// moved wholesale. Every few seconds it records what the engine has done and how much
// memory it is holding.
//
// At the end it asks the three questions this phase is about:
//   does it keep up          - files read per second, and whether the queue drains
//   does it stay honest      - the sanity checker, on the database it has been writing
//   does it stay still       - resident memory at the end against the start, and whether
//                              the engine was answering (@@alive) the whole way through
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k: string, d: number) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
const MINUTES = opt("minutes", 20);
const START_FILES = opt("files", 20000);
const CHURN = opt("churn", 400);        // file operations per round
const ROUND_MS = 5000;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-soak-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-soak-root-"));
process.env.ATLAS_HOME = home;
process.env.ATLAS_LOG_LEVEL ??= "warn";
const { Db } = await import("../src/db/db.ts");
const { runSanity } = await import("../src/db/sanity.ts");
const { S } = await import("../src/pipeline/states.ts");

const words = "report invoice client payment account meeting project budget contract delivery summary office team manager total amount due date".split(" ");
let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const text = (n: number) => Array.from({ length: n }, () => pick(words)).join(" ");
const EXT = ["txt", "md", "csv", "log", "json"];

let made = 0;
function newFile(dir: string): string {
  const name = `${pick(words)}-${made++}.${pick(EXT)}`;
  const p = path.join(dir, name);
  fs.writeFileSync(p, `${text(40)}\n${crypto.randomBytes(16).toString("hex")}\n${text(200)}`);
  return p;
}
const dirs: string[] = [];
for (let i = 0; i < 40; i++) { const d = path.join(root, `folder ${i}`); fs.mkdirSync(d, { recursive: true }); dirs.push(d); }
process.stdout.write(`filling ${root} with ${START_FILES} files... `);
for (let i = 0; i < START_FILES; i++) newFile(dirs[i % dirs.length]);
console.log("done");

const db0 = new Db(path.join(home, "atlas.db"));
db0.run("INSERT INTO roots(path, created) VALUES (?, ?)", root, Date.now());
db0.close();

const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(import.meta.dirname, "..", "src", "main.ts")], {
  // A minute between rescans, not an hour: without a watcher, a new file is noticed by
  // the next scan, and this test is about what happens when they keep arriving.
  env: { ...process.env, ATLAS_HOME: home, ATLAS_PORT: "7788", ATLAS_HOSTED: "1", ATLAS_LOG_LEVEL: "warn", ATLAS_RESCAN_MINUTES: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
let alive = 0, lastAlive = Date.now(), longestSilence = 0, errors = 0;
child.stdout.on("data", (d: Buffer) => {
  for (const line of d.toString().split("\n")) {
    if (line.startsWith("@@alive")) { alive++; longestSilence = Math.max(longestSilence, Date.now() - lastAlive); lastAlive = Date.now(); }
  }
});
child.stderr.on("data", (d: Buffer) => { if (/\berror\b/i.test(d.toString())) errors++; });

interface Sample { t: number; files: number; done: number; failed: number; pending: number; ocrPending: number; rssMb: number; dbMb: number; walMb: number }
const samples: Sample[] = [];
const mb = (n: number) => +(n / 1048576).toFixed(1);
const sizeOf = (f: string) => { try { return fs.statSync(f).size; } catch { return 0; } };
const rssOf = async (pid: number): Promise<number> => {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], (e, out) => {
      const m = /"([\d,]+) K"\s*$/.exec((out ?? "").trim());
      resolve(m ? Number(m[1].replaceAll(",", "")) * 1024 : 0);
    });
  });
};

/** One round of a person using their computer: saving, renaming, deleting, tidying up. */
function churn(round: number): void {
  const live = () => { const d = pick(dirs); const fs2 = fs.readdirSync(d); return fs2.length ? path.join(d, pick(fs2)) : null; };
  for (let i = 0; i < CHURN / 4; i++) newFile(pick(dirs));                       // new files
  for (let i = 0; i < CHURN / 4; i++) { const f = live(); if (f) try { fs.appendFileSync(f, `\n${text(30)}`); } catch { /* raced */ } }
  for (let i = 0; i < CHURN / 4; i++) {                                          // renamed (same bytes, new name)
    const f = live(); if (!f) continue;
    try { fs.renameSync(f, path.join(path.dirname(f), `renamed-${round}-${i}-${path.basename(f)}`)); } catch { /* raced */ }
  }
  for (let i = 0; i < CHURN / 4; i++) { const f = live(); if (f) try { fs.rmSync(f); } catch { /* raced */ } }
  if (round % 6 === 5) { // a whole folder moved, the way a person tidies up
    const from = pick(dirs), to = path.join(root, `moved-${round}`);
    try { fs.renameSync(from, to); dirs[dirs.indexOf(from)] = to; } catch { /* raced */ }
  }
}

const t0 = Date.now();
const until = t0 + MINUTES * 60_000;
let round = 0;
console.log(`soaking for ${MINUTES} min: ${START_FILES} files to start, ~${CHURN} changes every ${ROUND_MS / 1000}s\n`);
console.log("  mins  files    done   failed  pending  ocr    rss MB  db MB  wal MB");
while (Date.now() < until) {
  await new Promise((r) => setTimeout(r, ROUND_MS));
  churn(round++);
  const db = new Db(path.join(home, "atlas.db"));
  const f = db.get<{ n: number; done: number; failed: number }>(
    `SELECT count(*) AS n, sum(state = ${S.DONE}) AS done, sum(state = ${S.FAILED}) AS failed FROM files`)!;
  const o = db.get<{ n: number }>("SELECT count(*) AS n FROM contents WHERE ocr = 1")!;
  db.close();
  const s: Sample = {
    t: Date.now() - t0, files: f.n, done: f.done ?? 0, failed: f.failed ?? 0, pending: f.n - (f.done ?? 0) - (f.failed ?? 0),
    ocrPending: o.n, rssMb: mb(await rssOf(child.pid!)), dbMb: mb(sizeOf(path.join(home, "atlas.db"))), walMb: mb(sizeOf(path.join(home, "atlas.db-wal"))),
  };
  samples.push(s);
  console.log(`  ${((s.t / 60000)).toFixed(1).padStart(4)}  ${String(s.files).padStart(6)}  ${String(s.done).padStart(6)}  ${String(s.failed).padStart(6)}  ${String(s.pending).padStart(7)}  ${String(s.ocrPending).padStart(4)}  ${String(s.rssMb).padStart(7)}  ${String(s.dbMb).padStart(5)}  ${String(s.walMb).padStart(6)}`);
}

// Let it catch up with the last round of changes, then stop it the way the service does.
console.log("\nchurn stopped; letting it settle...");
const settleStart = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const db = new Db(path.join(home, "atlas.db"));
  const left = db.get<{ n: number }>(`SELECT count(*) AS n FROM files WHERE state < ${S.DONE}`)!.n;
  db.close();
  // A file saved over moments ago waits out its settle window, and a file that was
  // busy waits out its backoff (15 s, 30 s, 1 min ...): give the queue real time.
  if (!left || Date.now() - settleStart > 300_000) { console.log(`settled in ${Math.round((Date.now() - settleStart) / 1000)}s (${left} still to read)`); break; }
}
child.stdin!.write("shutdown\n");
const stoppedBy = Date.now();
await new Promise<void>((r) => { child.once("exit", () => r()); setTimeout(() => { child.kill("SIGKILL"); r(); }, 30_000); });
const stopMs = Date.now() - stoppedBy;

const db = new Db(path.join(home, "atlas.db"));
// A file the churn deleted is MISSING, and that is the right answer, not unfinished work.
const final = db.get<{ files: number; done: number; failed: number; missing: number; waiting: number; contents: number }>(
  `SELECT count(*) AS files, sum(state = ${S.DONE}) AS done, sum(state = ${S.FAILED}) AS failed,
          sum(state = ${S.MISSING}) AS missing, sum(state < ${S.DONE}) AS waiting,
          (SELECT count(*) FROM contents) AS contents FROM files`)!;
const ops = db.all("SELECT id FROM ops").length;
db.close();
const sanity = await runSanity(path.join(home, "atlas.db"));

const quarter = Math.max(1, Math.floor(samples.length / 4));
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const rssFirst = avg(samples.slice(0, quarter).map((s) => s.rssMb));
const rssLast = avg(samples.slice(-quarter).map((s) => s.rssMb));
// What it got through: every unique content it read, over the whole run. Files are read
// again when they change, so this is work done, not rows counted at the end.
const readPerS = final.contents / ((Date.now() - t0) / 1000);

console.log(`\n--- after ${MINUTES} minutes ---`);
console.log(`files now              ${final.files}: ${final.done} filed, ${final.missing} gone (deleted by the churn), ${final.failed} failed, ${final.waiting} still waiting`);
console.log(`work done              ${final.contents} unique contents read, ~${readPerS.toFixed(0)}/s over the run, ${samples.length} rounds of changes`);
console.log(`memory                 ${rssFirst.toFixed(0)} MB early, ${rssLast.toFixed(0)} MB late, peak ${Math.max(...samples.map((s) => s.rssMb))} MB`);
console.log(`database               ${samples[samples.length - 1]?.dbMb} MB, WAL ${samples[samples.length - 1]?.walMb} MB`);
console.log(`still answering        ${alive} heartbeats, longest silence ${(longestSilence / 1000).toFixed(1)}s`);
console.log(`shutdown               ${(stopMs / 1000).toFixed(1)}s`);
console.log(`file operations        ${ops} (this engine never moves files: expected 0)`);
console.log(`sanity check           ${sanity.errors} error(s), ${sanity.warnings} warning(s), ${sanity.infos} note(s)`);
for (const f of sanity.findings.filter((x) => x.level !== "info")) console.log(`   ${f.level}: ${f.id} - ${f.count}`);

const problems: string[] = [];
if (sanity.errors) problems.push(`${sanity.errors} sanity error(s)`);
if (ops) problems.push(`${ops} file operation(s) on an engine that never moves files`);
if (final.waiting > final.files / 20) problems.push(`${final.waiting} file(s) never finished`);
if (longestSilence > 60_000) problems.push(`the engine went quiet for ${(longestSilence / 1000).toFixed(0)}s`);
if (rssLast > rssFirst * 1.5 + 50) problems.push(`memory grew from ${rssFirst.toFixed(0)} to ${rssLast.toFixed(0)} MB`);
if (errors) problems.push(`${errors} error line(s) on stderr`);
console.log(problems.length ? `\nPROBLEMS: ${problems.join("; ")}` : "\nNo problems: it kept up, stayed honest, and stayed still.");

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
