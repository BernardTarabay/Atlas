// Registering a root is the one act that grants Atlas a folder. Every path the
// API ever touches must resolve inside a registered root, so the checks here are
// the boundary of what Atlas can see.
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db/db.ts";
import { config } from "./config.ts";

export type Role = "source" | "library" | "backup";
export class RootError extends Error {}

const WIN = process.platform === "win32";
const norm = (p: string) => { const r = path.resolve(p).replace(/[\\/]+$/, ""); return WIN ? r.toLowerCase() : r; };
const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

function forbidden(): string[] {
  const e = process.env;
  const sys = [e.SystemRoot ?? "C:\\Windows", e.ProgramFiles ?? "C:\\Program Files", e["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    e.ProgramData ?? "C:\\ProgramData", config.home, config.appDir];
  return sys.filter(Boolean).map(norm);
}

export function validateRoot(db: Db, input: string, role: string): { path: string; role: Role } {
  if (!input || !path.isAbsolute(input)) throw new RootError("Give an absolute folder path, e.g. D:\\Documents.");
  if (!["source", "library", "backup"].includes(role)) throw new RootError("Role must be source, library or backup.");
  const abs = path.resolve(input);
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { throw new RootError(`"${abs}" does not exist or cannot be read.`); }
  if (!st.isDirectory()) throw new RootError(`"${abs}" is not a folder.`);
  const n = norm(abs);
  const systemDrive = norm((process.env.SystemDrive ?? "C:") + "\\");
  if (WIN && n === systemDrive.replace(/[\\/]+$/, "")) throw new RootError("The whole system drive cannot be a root. Choose the folders that hold your files.");
  for (const f of forbidden()) {
    if (within(n, f) || within(f, n)) throw new RootError(`"${abs}" is or contains a system or Atlas folder.`);
  }
  // Overlapping roots would index the same physical files twice under two paths.
  for (const r of db.all<{ path: string }>("SELECT path FROM roots")) {
    const o = norm(r.path);
    if (within(n, o) || within(o, n)) throw new RootError(`"${abs}" overlaps the registered folder "${r.path}".`);
  }
  return { path: abs.replace(/[\\/]+$/, "") || abs, role: role as Role };
}

export function addRoot(db: Db, input: string, role: string): number {
  const v = validateRoot(db, input, role);
  return Number(db.run("INSERT INTO roots(path, role, created) VALUES (?, ?, ?)", v.path, v.role, Date.now()).lastInsertRowid);
}

/** Forget a root: index rows only. No file on disk is touched. */
export function removeRoot(db: Db, id: number) {
  db.tx(() => {
    db.run("DELETE FROM fts_name WHERE rowid IN (SELECT id FROM files WHERE root = ?)", id);
    db.run("DELETE FROM files WHERE root = ?", id);
    db.run("DELETE FROM roots WHERE id = ?", id);
    // Content that no remaining file points at goes too: its text, its index
    // entry and its row. Without this, forgetting a folder left every unique
    // content it had ever contributed behind - searchable by text, counted as
    // "unique", and attached to nothing.
    const orphans = "SELECT id FROM contents WHERE NOT EXISTS (SELECT 1 FROM files WHERE files.content = contents.id)";
    db.run(`DELETE FROM fts_text WHERE rowid IN (${orphans})`);
    db.run(`DELETE FROM texts WHERE content IN (${orphans})`);
    db.run(`DELETE FROM contents WHERE id IN (${orphans})`);
  });
}

/** Absolute on-disk path of an indexed file, guaranteed to be inside its root. */
export function resolveFile(rootPath: string, rel: string): string {
  const root = path.resolve(rootPath);
  const abs = path.resolve(root, ...rel.split("/"));
  if (!within(norm(abs), norm(root))) throw new RootError("path escapes its root");
  return abs;
}
