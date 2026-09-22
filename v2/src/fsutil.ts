// Renaming a file Atlas has just written, on Windows.
//
// A freshly written file is often opened for a moment by someone else - the
// antivirus scanning it, the search indexer, a backup agent - and while it is,
// renaming it (or replacing the file it is renamed over) fails with EBUSY/EPERM/
// EACCES. That is not an error in what Atlas did; it is a few hundred milliseconds
// of waiting. These retry for a bounded time, then give up with the real error.
//
// Only for Atlas's OWN files (a backup, an export, a thumbnail, a report). A user's
// file is never renamed through here: Apply has its own, never-replacing move.
import fs from "node:fs";

const PASSING = new Set(["EBUSY", "EPERM", "EACCES"]);
const passing = (e: unknown) => PASSING.has((e as NodeJS.ErrnoException).code ?? "");

/** Asynchronous: waits without blocking anything else. Up to `budgetMs` (default 5 s). */
export async function renameRetrying(from: string, to: string, budgetMs = 5000): Promise<void> {
  const t0 = Date.now();
  for (let wait = 25; ; wait = Math.min(wait * 2, 500)) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (!passing(e) || Date.now() - t0 + wait > budgetMs) throw e;
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

/**
 * Synchronous, for the few places that must stay synchronous. It blocks the thread
 * while it waits, so its budget is short (default 1 s) and it is only used for
 * small files written rarely (the intent export, a sanity report).
 */
export function renameRetryingSync(from: string, to: string, budgetMs = 1000): void {
  const t0 = Date.now();
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let wait = 25; ; wait = Math.min(wait * 2, 250)) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (!passing(e) || Date.now() - t0 + wait > budgetMs) throw e;
    }
    Atomics.wait(pause, 0, 0, wait);
  }
}
