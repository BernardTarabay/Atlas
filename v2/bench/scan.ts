// Scan throughput: walker + database, first scan vs unchanged rescan.
// Usage: node bench/scan.ts <folder> [--node]   (metadata only; nothing is read)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/db/db.ts";
import { scanRoot } from "../src/scan/scanner.ts";
import { config } from "../src/config.ts";

const target = path.resolve(process.argv[2] ?? ".");
if (process.argv.includes("--node")) (config as { walkerExe: string }).walkerExe = "__disabled__";
const dbFile = path.join(os.tmpdir(), `atlas-scanbench-${process.pid}.db`);
const db = new Db(dbFile);
db.run("INSERT INTO roots(path, created) VALUES(?, ?)", target, Date.now());

for (const label of ["first scan", "rescan (unchanged)"]) {
  const t = performance.now();
  const s = await scanRoot(db, 1);
  const ms = performance.now() - t;
  console.log(`${label.padEnd(20)} files=${s.files} dirs=${s.dirs} errors=${s.errors} ${ms.toFixed(0)} ms -> ${Math.round(s.files / (ms / 1000))} files/s`);
}
const size = fs.statSync(dbFile).size + (fs.existsSync(dbFile + "-wal") ? fs.statSync(dbFile + "-wal").size : 0);
console.log(`db size ${(size / 1e6).toFixed(1)} MB (${Math.round(size / Math.max(1, (db.get<{ n: number }>("SELECT count(*) n FROM files")!.n)))} bytes/file)`);
db.close();
for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
