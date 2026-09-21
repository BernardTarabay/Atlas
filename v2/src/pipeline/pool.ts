// A fixed set of analysis worker threads, one job each. The pool is where the
// "a hung parser must not hang Atlas" guarantee lives: every job has a deadline,
// and a worker that misses it is terminated and replaced.
import { Worker } from "node:worker_threads";
import type { Analysis } from "../analyze/analyze.ts";
import type { Job } from "./worker.ts";

/** `actual` is the size/mtime of the file as it was read -- what the hash describes. */
export interface JobResult { job: Job; sha: Buffer; actual: { size: number; mtime: number }; a?: Analysis; index?: string }

interface Slot { w: Worker; job: Job | null; timer: NodeJS.Timeout | null; since: number; stage: Stage }

/** What a worker is doing right now, for the live pipeline view. */
export type Stage = "idle" | "reading" | "analyzing" | "linking";
export interface WorkerActivity { worker: number; file: string | null; size: number; since: number; stage: Stage }

export class AnalyzePool {
  private slots: Slot[] = [];
  private stopped = false;
  private timeoutMs: number;
  /** Called after hashing; return true if this content must be analyzed (it is new). */
  private onHash: (job: Job, sha: Buffer) => boolean;
  private onDone: (r: JobResult) => void;
  private onError: (job: Job, code: string, message: string) => void;

  constructor(
    size: number,
    timeoutMs: number,
    onHash: (job: Job, sha: Buffer) => boolean,
    onDone: (r: JobResult) => void,
    onError: (job: Job, code: string, message: string) => void,
  ) {
    this.timeoutMs = timeoutMs;
    this.onHash = onHash;
    this.onDone = onDone;
    this.onError = onError;
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  get idle(): number {
    return this.slots.filter((s) => !s.job).length;
  }

  get busy(): number {
    return this.slots.length - this.idle;
  }

  /** One row per worker. Cheap: it only reads the slots. */
  activity(): WorkerActivity[] {
    return this.slots.map((s, i) => ({
      worker: i + 1, file: s.job?.abs ?? null, size: s.job?.size ?? 0, since: s.since, stage: s.job ? s.stage : "idle",
    }));
  }

  submit(job: Job): boolean {
    const slot = this.slots.find((s) => !s.job);
    if (!slot) return false;
    slot.job = job;
    slot.since = Date.now();
    slot.stage = "reading";                 // read + hash, until the worker reports the hash
    slot.timer = setTimeout(() => this.kill(slot, "TIMEOUT", `analysis exceeded ${Math.round(this.timeoutMs / 1000)}s`), this.timeoutMs);
    slot.w.postMessage({ t: "job", ...job });
    return true;
  }

  async stop() {
    this.stopped = true;
    await Promise.all(this.slots.map((s) => s.w.terminate()));
  }

  private spawn(): Slot {
    const w = new Worker(new URL("./worker.ts", import.meta.url));
    const slot: Slot = { w, job: null, timer: null, since: 0, stage: "idle" };
    w.on("message", (m: { t: string; id: number; sha: Uint8Array; actual: { size: number; mtime: number }; a?: Analysis; index?: string; code?: string; message?: string }) => {
      const job = slot.job;
      if (!job || job.id !== m.id) return;
      if (m.t === "hash") {
        const extract = this.onHash(job, Buffer.from(m.sha));
        // New content is analyzed; a copy of known content is only linked to it.
        slot.stage = extract ? "analyzing" : "linking";
        w.postMessage({ t: "go", id: job.id, extract });
        return;
      }
      this.release(slot);
      if (m.t === "done") this.onDone({ job, sha: Buffer.from(m.sha), actual: m.actual, a: m.a, index: m.index });
      else this.onError(job, m.code ?? "ERR", m.message ?? "");
    });
    w.on("error", (e) => this.crashed(slot, e.message));
    w.on("exit", (code) => { if (!this.stopped) this.crashed(slot, `worker exited (${code})`); });
    return slot;
  }

  private release(slot: Slot) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    slot.stage = "idle";
    slot.since = Date.now();
  }

  private kill(slot: Slot, code: string, message: string) {
    const job = slot.job;
    this.release(slot);
    slot.w.removeAllListeners();
    slot.w.terminate().catch(() => {});
    this.replace(slot);
    if (job) this.onError(job, code, message);
  }

  private crashed(slot: Slot, message: string) {
    if (this.stopped || !this.slots.includes(slot)) return;
    const job = slot.job;
    this.release(slot);
    slot.w.removeAllListeners();
    this.replace(slot);
    if (job) this.onError(job, "CRASH", message);
  }

  private replace(slot: Slot) {
    if (this.stopped) return;
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots[i] = this.spawn();
  }
}
