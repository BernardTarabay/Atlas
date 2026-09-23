// End-to-end pipeline benchmark: fresh database, one root, scan -> hash ->
// analyze -> plan until nothing is pending. Reports where the time went.
//
// Usage: node bench/run.ts <corpus dir> [--workers N] [--keep]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const wi = args.indexOf("--workers");
const positional = args.filter((a, i) => !a.startsWith("--") && !(wi >= 0 && i === wi + 1));
const corpus = path.resolve(positional[0] ?? path.join(os.homedir(), "AtlasBench", "corpus-small"));
if (wi >= 0) process.env.ATLAS_WORKERS = args[wi + 1];
const home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bench-"));
process.env.ATLAS_HOME = home;
process.env.ATLAS_LOG_LEVEL ??= "warn";

const { Db } = await import("../src/db/db.ts");
const { Engine } = await import("../src/pipeline/engine.ts");
const { config } = await import("../src/config.ts");

const db = new Db(path.join(home, "atlas.db"));
db.run("INSERT INTO roots(path, created) VALUES (?, ?)", corpus, Date.now());
const engine = new Engine(db);
const cpu0 = process.cpuUsage();
const t0 = performance.now();
let peakRss = 0;
const marks: Record<string, number> = {};
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 200);

engine.start();
engine.requestScan(1);

// Asking "how many are left?" counts rows, and at 200,000 files that count costs ~15 ms
// on the same thread the engine writes from - ten times a second, it measures itself
// slowing down (docs/18 Phase 9). Quarter-second polls, and the second count only until
// the reading is done.
const pending = () => db.get<{ n: number }>("SELECT count(*) n FROM files WHERE state < 50")!.n;
await new Promise<void>((resolve) => {
  const check = setInterval(() => {
    const ms = performance.now() - t0;
    if (!marks.scan && engine.lastScans.has(1)) marks.scan = ms;
    const p = pending();
    if (!marks.hashed && marks.scan && engine.pool.busy === 0
      && db.get<{ n: number }>("SELECT count(*) n FROM files WHERE state = 0 AND state < 50")!.n === 0) marks.hashed = ms;
    if (marks.scan && p === 0 && engine.pool.busy === 0) { clearInterval(check); resolve(); }
  }, 250);
});
const total = performance.now() - t0;
clearInterval(sampler);
await engine.stop();
const cpu = process.cpuUsage(cpu0);

const q = <T>(sql: string) => db.get<T>(sql)!;
const files = q<{ n: number; bytes: number }>("SELECT count(*) n, sum(size) bytes FROM files");
const contents = q<{ n: number; analyzed: number; text: number }>("SELECT count(*) n, sum(state = 10) analyzed, sum(tlen > 0) text FROM contents");
const dups = q<{ groups: number; extra: number; bytes: number }>(
  `SELECT count(*) groups, sum(n - 1) extra, sum((n - 1) * size) bytes FROM (SELECT content, count(*) n, max(size) size FROM files WHERE content IS NOT NULL AND state = 50 GROUP BY content HAVING n > 1)`);
const byState = db.all<{ state: number; n: number }>("SELECT state, count(*) n FROM files GROUP BY state");
const rules = db.all<{ rule: string; n: number }>("SELECT rule, count(*) n FROM files GROUP BY rule ORDER BY n DESC LIMIT 12");
const dbBytes = ["atlas.db", "atlas.db-wal"].reduce((s, f) => s + (fs.existsSync(path.join(home, f)) ? fs.statSync(path.join(home, f)).size : 0), 0);
db.close();

const r = {
  corpus, workers: config.analyzeWorkers, cpus: os.availableParallelism(),
  files: files.n, gb: +(files.bytes / 1e9).toFixed(2),
  seconds: { scan: +(marks.scan / 1000).toFixed(2), hashedAll: +((marks.hashed ?? total) / 1000).toFixed(2), total: +(total / 1000).toFixed(2) },
  filesPerSec: Math.round(files.n / (total / 1000)),
  mbPerSec: Math.round(files.bytes / 1e6 / (total / 1000)),
  uniqueContents: contents.n, analyzed: contents.analyzed, withText: contents.text,
  duplicateCopies: dups.extra ?? 0, duplicateGroups: dups.groups ?? 0, reclaimableMB: Math.round((dups.bytes ?? 0) / 1e6),
  counters: engine.counters, states: byState, rules,
  peakRssMB: Math.round(peakRss / 1e6), cpuSeconds: +((cpu.user + cpu.system) / 1e6).toFixed(1),
  cpuUtilization: +(((cpu.user + cpu.system) / 1e3) / total / os.availableParallelism()).toFixed(2),
  dbMB: +(dbBytes / 1e6).toFixed(1), dbBytesPerFile: Math.round(dbBytes / files.n),
};
console.log(JSON.stringify(r, null, 2));
const resDir = path.join(import.meta.dirname, "results");
fs.mkdirSync(resDir, { recursive: true });
fs.writeFileSync(path.join(resDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(r, null, 2));
if (!args.includes("--keep")) fs.rmSync(home, { recursive: true, force: true });
else console.log("kept:", home);
