// Crash-recovery test: hard-kill the real engine process at random moments
// (including mid-scan), restart it, and prove the end state equals a clean run.
//
// Usage: node bench/crash.ts [corpus dir] [--kills 7]
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/db/db.ts";

const args = process.argv.slice(2);
const ki = args.indexOf("--kills");
const KILLS = ki >= 0 ? Number(args[ki + 1]) : 7;
const positional = args.filter((a, i) => !a.startsWith("--") && !(ki >= 0 && i === ki + 1));
const corpus = path.resolve(positional[0] ?? path.join(os.homedir(), "AtlasBench", "corpus-small"));
const main = path.join(import.meta.dirname, "..", "src", "main.ts");

function fresh(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-crash-"));
  const db = new Db(path.join(home, "atlas.db"));
  db.run("INSERT INTO roots(path, created) VALUES (?, ?)", corpus, Date.now());
  db.close();
  return home;
}

function startEngine(home: string, port: number): ChildProcess {
  return spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main], {
    env: { ...process.env, ATLAS_HOME: home, ATLAS_PORT: String(port), ATLAS_LOG_LEVEL: "warn" }, stdio: "ignore", windowsHide: true,
  });
}

function peek(home: string) {
  const db = new Db(path.join(home, "atlas.db"));
  try {
    const r = db.get<{ total: number; done: number; scanned: number; ocr: number }>(
      `SELECT count(*) AS total, sum(state = 50) AS done, (SELECT count(*) FROM roots WHERE gen > 0) AS scanned,
              (SELECT count(*) FROM contents WHERE ocr = 1) AS ocr FROM files`)!;
    return { total: r.total, done: r.done ?? 0, scanned: r.scanned, ocrPending: r.ocr };
  } finally { db.close(); }
}

async function runToCompletion(home: string, port: number, kills: number[]) {
  const t0 = performance.now();
  let restarts = 0;
  const recovery: number[] = [];
  for (const at of kills) {
    const child = startEngine(home, port);
    await new Promise((r) => setTimeout(r, at));
    const before = peek(home);
    child.kill("SIGKILL"); // TerminateProcess on Windows: no cleanup, no flush, no graceful anything
    await new Promise((r) => child.once("exit", r));
    restarts++;
    console.log(`  killed after ${at} ms: ${before.done}/${before.total} done, scanned=${before.scanned > 0}`);
  }
  // Final run: must finish from wherever the kills left it.
  const child = startEngine(home, port);
  const tRestart = performance.now();
  let firstProgress = 0;
  const start = peek(home).done;
  // Finished means at rest: every file planned AND no OCR still to come - an OCR result
  // sends its files back to be planned again, so "all planned" alone can be a passing
  // moment (a kill right then left one file unplanned). Seen three times in a row.
  for (let atRest = 0; atRest < 3; ) {
    await new Promise((r) => setTimeout(r, 100));
    const p = peek(home);
    if (!firstProgress && p.done > start) firstProgress = performance.now() - tRestart;
    atRest = p.scanned && p.total > 0 && p.done === p.total && p.ocrPending === 0 ? atRest + 1 : 0;
  }
  recovery.push(firstProgress);
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  return { seconds: +((performance.now() - t0) / 1000).toFixed(2), restarts, msToFirstProgressAfterRestart: Math.round(firstProgress) };
}

function snapshot(home: string) {
  const db = new Db(path.join(home, "atlas.db"));
  try {
    const q = <T>(sql: string) => db.get<T>(sql)!;
    return {
      files: q<{ n: number }>("SELECT count(*) AS n FROM files").n,
      notDone: q<{ n: number }>("SELECT count(*) AS n FROM files WHERE state <> 50").n,
      notDoneRows: db.all<{ path: string; state: number; err: string | null; ocr: number | null }>(
        "SELECT f.path, f.state, f.err, c.ocr FROM files f LEFT JOIN contents c ON c.id = f.content WHERE f.state <> 50 LIMIT 5"),
      contents: q<{ n: number }>("SELECT count(*) AS n FROM contents").n,
      orphanContents: q<{ n: number }>("SELECT count(*) AS n FROM contents c WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.content = c.id)").n,
      unanalyzed: q<{ n: number }>("SELECT count(*) AS n FROM contents WHERE state <> 10").n,
      groupsWithoutRep: q<{ n: number }>("SELECT count(*) AS n FROM (SELECT content FROM files WHERE content IS NOT NULL GROUP BY content HAVING sum(plan IS NOT NULL) <> 1)").n,
      duplicatePlans: q<{ n: number }>("SELECT count(*) AS n FROM (SELECT plan FROM files WHERE plan IS NOT NULL GROUP BY plan HAVING count(*) > 1)").n,
      ftsText: q<{ n: number }>("SELECT count(*) AS n FROM fts_text").n,
      ftsName: q<{ n: number }>("SELECT count(*) AS n FROM fts_name").n,
      byRule: JSON.stringify(db.all("SELECT rule, count(*) AS n FROM files GROUP BY rule ORDER BY rule")),
      planned: new Map(db.all<{ path: string; plan: string | null }>("SELECT path, plan FROM files").map((r) => [r.path, r.plan])),
    };
  } finally { db.close(); }
}

console.log(`corpus: ${corpus}`);
console.log("clean run:");
const cleanHome = fresh();
const clean = await runToCompletion(cleanHome, 7801, []);
const a = snapshot(cleanHome);
console.log(`  ${clean.seconds}s`);

const kills = Array.from({ length: KILLS }, (_, i) => (i === 0 ? 150 : 250 + Math.floor(Math.random() * 1200)));
console.log(`crash run (${KILLS} hard kills):`);
const crashHome = fresh();
const crashed = await runToCompletion(crashHome, 7802, kills);
const b = snapshot(crashHome);
console.log(`  ${crashed.seconds}s, first progress ${crashed.msToFirstProgressAfterRestart} ms after the final restart`);

let samePlans = 0, diffPlans = 0;
const diffs: string[] = [];
for (const [p, plan] of a.planned) {
  if (b.planned.get(p) === plan) samePlans++;
  else { diffPlans++; if (diffs.length < 6) diffs.push(`  ${p}\n     clean: ${plan}\n     crash: ${b.planned.get(p)}`); }
}
if (diffs.length) console.log("differences:\n" + diffs.join("\n"));
const checks: [string, boolean, string][] = [
  ["every file processed", b.notDone === 0, `${b.notDone} not done: ${JSON.stringify(b.notDoneRows)}`],
  ["same file count as clean run", a.files === b.files, `${a.files} vs ${b.files}`],
  ["same unique contents", a.contents === b.contents, `${a.contents} vs ${b.contents}`],
  ["every content analyzed", b.unanalyzed === 0, `${b.unanalyzed} unanalyzed`],
  ["no orphan content rows", b.orphanContents === 0, `${b.orphanContents}`],
  ["exactly one representative per content", b.groupsWithoutRep === 0, `${b.groupsWithoutRep} groups wrong`],
  ["no two files share a library path", b.duplicatePlans === 0, `${b.duplicatePlans}`],
  ["text index complete", a.ftsText === b.ftsText, `${a.ftsText} vs ${b.ftsText}`],
  ["name index complete", a.ftsName === b.ftsName, `${a.ftsName} vs ${b.ftsName}`],
  ["same rule outcomes", a.byRule === b.byRule, ""],
  ["same library path per file", diffPlans === 0, `${samePlans} same, ${diffPlans} different`],
];
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
  if (!ok) failed++;
}
for (const h of [cleanHome, crashHome]) fs.rmSync(h, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
