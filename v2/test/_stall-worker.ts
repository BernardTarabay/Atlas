// A worker that misbehaves on purpose, for the pool's clocks (test/retry.test.ts).
// The job's `abs` names the behaviour:
//   moving  reads slowly but steadily (progress every 100 ms for 2.5 s), then finishes
//   stall   reports a little progress, then goes silent while "reading"
//   hang    hashes at once, then never finishes analysing
import { parentPort } from "node:worker_threads";

const port = parentPort!;
const sha = new Uint8Array(32);
const jobs = new Map<number, string>();

port.on("message", (m: { t: string; id: number; abs: string }) => {
  if (m.t === "go") {
    if (jobs.get(m.id) !== "hang") port.postMessage({ t: "done", id: m.id, sha, actual: { size: 0, mtime: 0 } });
    return;
  }
  if (m.t === "leave") { port.close(); return; }
  if (m.t !== "job") return;
  jobs.set(m.id, m.abs);
  let n = 0;
  if (m.abs === "moving") {
    const t = setInterval(() => {
      port.postMessage({ t: "progress", id: m.id, bytes: ++n });
      if (n === 25) { clearInterval(t); port.postMessage({ t: "hash", id: m.id, sha }); }
    }, 100);
  } else if (m.abs === "stall") {
    const t = setInterval(() => {
      port.postMessage({ t: "progress", id: m.id, bytes: ++n });
      if (n === 2) clearInterval(t);
    }, 100);
  } else if (m.abs === "hang") {
    port.postMessage({ t: "hash", id: m.id, sha });
  }
});
