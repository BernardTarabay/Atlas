// One owner, one password. Proportionate, not an IAM system.
//
// First run: there is no password until someone who can read
// <home>\setup-code.txt (i.e. has local access to the machine) enters that code
// and chooses one. Sessions are random tokens; only their SHA-256 is stored.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/db.ts";
import { config } from "../config.ts";

const SESSION_DAYS = 30;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function hasPassword(db: Db): boolean {
  return Boolean(db.meta("password"));
}

/** Creates (once) and returns the path of the one-time setup code file. */
export function ensureSetupCode(db: Db): string | null {
  if (hasPassword(db)) return null;
  const file = path.join(config.home, "setup-code.txt");
  if (!db.meta("setupCode")) {
    const code = crypto.randomInt(0, 1e8).toString().padStart(8, "0");
    db.setMeta("setupCode", sha(code));
    fs.writeFileSync(file, `Atlas setup code: ${code}\r\nEnter it at http://127.0.0.1:${config.port} to set the owner password.\r\n`);
  }
  return file;
}

export function setup(db: Db, code: string, password: string): boolean {
  if (hasPassword(db)) return false;
  const expected = db.meta("setupCode");
  if (!expected || !timingSafeEqualHex(sha(String(code).trim()), expected)) return false;
  setPassword(db, password);
  db.run("DELETE FROM meta WHERE key = 'setupCode'");
  fs.rmSync(path.join(config.home, "setup-code.txt"), { force: true });
  return true;
}

export function setPassword(db: Db, password: string) {
  if (typeof password !== "string" || password.length < 8) throw new Error("The password must be at least 8 characters.");
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  db.setMeta("password", `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`);
  db.run("DELETE FROM sessions"); // a new password signs everyone out
}

export function checkPassword(db: Db, password: string): boolean {
  const stored = db.meta("password");
  if (!stored) return false;
  const [, saltHex, hashHex] = stored.split("$");
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}

export function createSession(db: Db, remote: boolean): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.run("INSERT INTO sessions(token, created, seen, remote) VALUES (?, ?, ?, ?)", sha(token), now, now, remote ? 1 : 0);
  return token;
}

export function checkSession(db: Db, token: string | undefined): boolean {
  if (!token) return false;
  const row = db.get<{ seen: number }>("SELECT seen FROM sessions WHERE token = ?", sha(token));
  if (!row) return false;
  const now = Date.now();
  if (now - row.seen > SESSION_DAYS * 86400_000) { db.run("DELETE FROM sessions WHERE token = ?", sha(token)); return false; }
  if (now - row.seen > 60_000) db.run("UPDATE sessions SET seen = ? WHERE token = ?", now, sha(token));
  return true;
}

export function endSession(db: Db, token: string | undefined) {
  if (token) db.run("DELETE FROM sessions WHERE token = ?", sha(token));
}

function timingSafeEqualHex(a: string, b: string) {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Tiny login throttle: 5 failures in 10 minutes locks login for 5 minutes. */
const failures: number[] = [];
export function loginAllowed(): boolean {
  const now = Date.now();
  while (failures.length && now - failures[0] > 600_000) failures.shift();
  return failures.length < 5 || now - failures[failures.length - 1] > 300_000;
}
export const noteFailure = () => { failures.push(Date.now()); };
