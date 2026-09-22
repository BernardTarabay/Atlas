// One writer. The engine is designed as the only process that writes the database,
// and the maintenance commands that write it (Apply, intent import, restore) run
// with the engine stopped. Until now that rested on "the web port is taken"; now a
// lock file says it: <home>/atlas.lock, held open with no sharing (UV_FS_O_EXLOCK)
// for as long as a writer runs. The operating system releases it when the process
// ends, however it ends - a crash cannot leave a stale lock behind.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

/** libuv's UV_FS_O_EXLOCK: open with no sharing (Windows). Not exposed in fs.constants. */
const EXLOCK = 0x10000000;

export interface Lock { release(): void }

/** Take the writer's lock, or null if another Atlas process holds it. */
export function acquireLock(who: string, home = config.home): Lock | null {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "atlas.lock");
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | (process.platform === "win32" ? EXLOCK : 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EBUSY") return null;
    throw e;
  }
  // For people: who holds it. The lock is the open handle, not this text.
  try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, `${who} (pid ${process.pid}) since ${new Date().toISOString()}\r\n`); } catch { /* informational */ }
  let held = true;
  return { release() { if (held) { held = false; fs.closeSync(fd); } } };
}

/** Who holds the lock, as it says (best effort; unreadable while held on some systems). */
export function lockHolder(home = config.home): string | null {
  try { return fs.readFileSync(path.join(home, "atlas.lock"), "utf8").trim() || null; } catch { return null; }
}
