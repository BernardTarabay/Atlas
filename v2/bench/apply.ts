// How fast Apply moves files, on throwaway folders it makes itself.
//
//   npm run bench:apply -- [--files 5000] [--kb 4]
//
// Per file, a move costs two durable commits (STARTED, then the index and DONE
// together) and, across disks, a copy that is flushed and read back. This measures
// that cost, which is the price of being able to say afterwards what happened.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k: string, d: number) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
const FILES = opt("files", 5000);
const KB = opt("kb", 4);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-applybench-home-"));
process.env.ATLAS_HOME = home;
process.env.ATLAS_LOG_LEVEL ??= "error";
process.env.ATLAS_SETTLE_S ??= "0";
const { Db } = await import("../src/db/db.ts");
const { Engine } = await import("../src/pipeline/engine.ts");
const { planApply, runBatch, planUndo } = await import("../src/apply/apply.ts");
const { nativeFsOps } = await import("../src/apply/fsops.ts");
const { S } = await import("../src/pipeline/states.ts");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-applybench-"));
const src = path.join(base, "Inbox"), lib = path.join(base, "Library");
fs.mkdirSync(src); fs.mkdirSync(lib);
const body = (i: number) => `file ${i}\n` + crypto.randomBytes(Math.max(1, KB * 512)).toString("hex");
process.stdout.write(`writing ${FILES} files of ~${KB} KB... `);
for (let i = 0; i < FILES; i++) {
  const d = path.join(src, `folder ${i % 20}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `note ${i}.txt`), body(i));
}
console.log("done");

const db = new Db(path.join(home, "atlas.db"));
db.run("INSERT INTO roots(path, role, created) VALUES (?, 'source', ?)", src, Date.now());
db.run("INSERT INTO roots(path, role, created) VALUES (?, 'library', ?)", lib, Date.now());
const eng = new Engine(db);
eng.start();
eng.requestScan();
process.stdout.write("reading and planning them... ");
for (let i = 0; i < 20000; i++) {
  await new Promise((r) => setTimeout(r, 25));
  const pending = db.get<{ n: number }>(`SELECT count(*) AS n FROM files WHERE state < ${S.DONE}`)!.n;
  if (i > 4 && !pending && eng.pool.busy === 0 && eng.scanState.scanning == null && !eng.scanState.queued.length) break;
}
await eng.stop();
console.log("done\n");

const fx = nativeFsOps();
const rows: [string, number, number][] = [];
const time = async <T>(label: string, n: number, f: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  const r = await f();
  rows.push([label, performance.now() - t0, n]);
  return r;
};

const p1 = await time("plan (one disk)", FILES, () => planApply(db, 2));
const r1 = await time("move, same disk", p1.ops, () => runBatch(db, p1.batch!, fx));
const u = planUndo(db, p1.batch!);
const r2 = await time("put them back", u.ops, () => runBatch(db, u.batch, fx));
const p3 = await planApply(db, 2, { mode: "copy" });
const r3 = await time("copy protocol", p3.ops, () => runBatch(db, p3.batch!, fx));
fx.close();

console.log("step".padEnd(18) + "files".padEnd(8) + "total".padEnd(10) + "per file".padEnd(11) + "rate");
for (const [label, ms, n] of rows) {
  console.log(label.padEnd(18) + String(n).padEnd(8) + `${(ms / 1000).toFixed(1)}s`.padEnd(10)
    + `${(ms / n).toFixed(2)} ms`.padEnd(11) + `${(n / (ms / 1000)).toFixed(0)} files/s`);
}
const bad = r1.failed + r1.review + r2.failed + r2.review + r3.failed + r3.review;
console.log(`\n${r1.done} moved, ${r2.done} put back, ${r3.done} copied across; ${bad} failed or for review.`);
db.close();
fs.rmSync(base, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
