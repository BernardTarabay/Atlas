// Drives are identified by their volume serial, not their letter.
//
// A root records the serial of the volume it was on (roots.volume). The scanner
// refuses to list a different volume at the root's path; this module answers the
// other half: when the root's path is gone, has its disk come back under another
// letter? (A USB disk that was E: yesterday and is F: today.) Only a single
// unambiguous match counts - the same serial AND the same folder path on it.
//
// All asynchronous: a stat of a mapped drive whose server is gone can take
// seconds, and nothing on the main thread may wait for a disk.
import fsp from "node:fs/promises";
import { serialOf } from "./walker.ts";

/** The volume serial at `dir` ("4043c450"), or null when it cannot be reached. */
export async function volumeAt(dir: string): Promise<string | null> {
  try {
    const s = await fsp.stat(dir, { bigint: true });
    return s.isDirectory() ? serialOf(s.dev) : null;
  } catch {
    return null;
  }
}

/** "E:\\Photos" -> letter-relative rest "\\Photos"; null for UNC paths and others without a drive letter. */
const onLetter = (p: string) => (/^[a-zA-Z]:[\\/]/.test(p) ? p.slice(2) : null);

/**
 * Where the folder `path` (last seen on `volume`) is now, if its disk is mounted
 * under a different letter: the one path X:<same folder> whose volume serial is
 * `volume`. Null when not found, or found more than once (a cloned disk).
 */
export async function findMovedRoot(path: string, volume: string, letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"): Promise<string | null> {
  const rest = onLetter(path);
  if (rest == null) return null;
  const current = path[0].toUpperCase();
  const tries = [...letters].filter((l) => l !== current).map(async (l) => {
    const candidate = `${l}:${rest}`;
    return (await volumeAt(candidate)) === volume ? candidate : null;
  });
  const found = (await Promise.all(tries)).filter((c): c is string => c != null);
  return found.length === 1 ? found[0] : null;
}
