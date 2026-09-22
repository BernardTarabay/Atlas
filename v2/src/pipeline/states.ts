// The file lifecycle. One integer per file; the database always knows where
// every file is, and restarting simply resumes every row below DONE.
//
//   NEW     discovered or changed; needs read + hash (+ analysis if the content is new)
//   IDENT   hashed and linked to a content row (or a cloud placeholder, which is never read);
//           needs planning
//   DONE    planned into the virtual library (or recognized as a copy of a planned file)
//   MISSING not seen by the last complete scan of its root
//   FAILED  could not be read after config.maxTries attempts. NOT retried by scans:
//           only when the file changes (size, mtime, file ID), when `fsig` no
//           longer matches (content failures), at `fnext` (access failures), or
//           when someone asks (Engine.retry).
export const S = { NEW: 0, IDENT: 20, DONE: 50, MISSING: 70, FAILED: 90 } as const;

/**
 * What a failure says about the file.
 *
 * content  the bytes defeat the reader: a parser that hung past its deadline
 *          (TIMEOUT), a worker that died (CRASH), an exception in our own code
 *          (ERR, ERR_*). The same bytes through the same code fail the same way,
 *          so retrying on a timer only burns a worker.
 * access   the file could not be reached: locked (EBUSY), denied (EACCES, EPERM),
 *          a disk error (EIO), still being written (UNSTABLE), a read that stopped
 *          making progress (STALL), anything else the OS reported. Those pass.
 */
export type FailureClass = "content" | "access";
export function failureClass(code: string): FailureClass {
  return code === "TIMEOUT" || code === "CRASH" || code === "ERR" || code.startsWith("ERR_") ? "content" : "access";
}

/** How long an access failure waits before its next round: 1 h, 6 h, then daily. */
const BACKOFF_MS = [3_600_000, 21_600_000, 86_400_000];
export const backoffMs = (rounds: number) => BACKOFF_MS[Math.min(Math.max(rounds, 0), BACKOFF_MS.length - 1)];

/** FILE_ATTRIBUTE_OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS: reading would trigger a cloud download. */
export const PLACEHOLDER_ATTRS = 0x1000 | 0x40000 | 0x400000;

export const isPlaceholder = (attrs: number) => (attrs & PLACEHOLDER_ATTRS) !== 0;

/** Content analysis levels. */
export const C = { HASHED: 0, ANALYZED: 10 } as const;

/** contents.ocr */
export const OCR = { NA: 0, PENDING: 1, DONE: 2, FAILED: 3, NO_ENGINE: 4 } as const;
