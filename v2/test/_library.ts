// A processed library on throwaway folders, for the Apply and recovery tests: a source
// folder with real files, an empty library folder, everything read and planned.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/db/db.ts";
import { Engine } from "../src/pipeline/engine.ts";
import { S } from "../src/pipeline/states.ts";

const OLD = new Date("2021-03-04T05:06:07Z");

export interface Library { base: string; src: string; lib: string; db: Db }

export async function library(name: string, files: Record<string, string>, cleanup: (() => void)[]): Promise<Library> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `atlas-${name}-`));
  cleanup.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const src = path.join(base, "Inbox");
  const lib = path.join(base, "Library");
  fs.mkdirSync(src);
  fs.mkdirSync(lib);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(src, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    fs.utimesSync(p, OLD, OLD);
  }
  const db = new Db(path.join(process.env.ATLAS_HOME!, `${name}.db`));
  cleanup.push(() => db.close());
  db.run("INSERT INTO roots(path, role, created) VALUES (?, 'source', ?)", src, Date.now());
  db.run("INSERT INTO roots(path, role, created) VALUES (?, 'library', ?)", lib, Date.now());
  const eng = new Engine(db);
  eng.start();
  eng.requestScan();
  for (let i = 0; i < 800; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const pending = db.get<{ n: number }>(`SELECT count(*) AS n FROM files WHERE state < ${S.DONE}`)!.n;
    if (i > 4 && !pending && eng.pool.busy === 0 && eng.scanState.scanning == null && !eng.scanState.queued.length) break;
  }
  await eng.stop();
  return { base, src, lib, db };
}
