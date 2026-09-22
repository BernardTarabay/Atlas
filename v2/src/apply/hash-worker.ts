// SHA-256 of a whole file, off the main thread (src/apply/fsops.ts). Apply proves a
// copy by its hash before the original may be deleted; a multi-gigabyte file must
// not stall the process that answers the web pages and the service's liveness check.
//   main -> worker  { id, path }
//   worker -> main  { id, sha } | { id, error, code }
import { parentPort } from "node:worker_threads";
import crypto from "node:crypto";
import fs from "node:fs";

const chunk = Buffer.allocUnsafe(4 << 20);
parentPort!.on("message", (m: { id: number; path: string }) => {
  try {
    const fd = fs.openSync(m.path, "r");
    try {
      const h = crypto.createHash("sha256");
      for (;;) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (!n) break;
        h.update(n === chunk.length ? chunk : chunk.subarray(0, n));
      }
      parentPort!.postMessage({ id: m.id, sha: h.digest("hex") });
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: (e as Error).message, code: (e as NodeJS.ErrnoException).code });
  }
});
