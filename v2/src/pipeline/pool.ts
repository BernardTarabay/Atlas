// A fixed set of analysis worker threads, one job each. The pool is where the
// "a hung parser must not hang Atlas" guarantee lives, with two different clocks:
//
//   reading    no deadline, because size is not a fault: a 40 GB file on a USB 2
//              disk legitimately reads for twenty minutes. The worker reports
//              progress; a read that makes NONE for `stallMs` is stuck (a dead share,
//              a failing disk) and is killed as STALL - an access failure.
//   analyzing  a fixed deadline, `timeoutMs`, from the moment the hash is known. A
//              parser that runs past it is hung on these bytes: TIMEOUT, a content
//              failure.
//
// A worker that misses either is terminated and replaced.
import { Worker } from "node:worker_threads";
import type { Analysis } from "../analyze/analyze.ts";
import type { Job } from "./worker.ts";

/** `actual` is the size/mtime of the file as it was read -- what the hash describes. */
export interface JobResult { job: Job; sha: Buffer; actual: { size: number; mtime: number }; a?: Analysis; index?: string }

interface Slot { w: Worker; job: Job | null; timer: NodeJS.Timeout | null; since: number; stage: Stage; read: number }

/** What a worker is doing right now, for the live pipeline view. */
export type Stage = "idle" | "reading" | "analyzing" | "linking";
export interface WorkerActivity { worker: number; file: string | null; size: number; since: number; stage: Stage; read: number }

export class AnalyzePool {
  private slots: Slot[] = [];
  private stopped = false;
  private stopping: Promise<void> | null = null;
  private timeoutMs: number;
  private stallMs: number;
  private workerUrl: URL;
  /** Called after hashing; return true if this content must be analyzed (it is new). */
  private onHash: (job: Job, sha: Buffer) => boolean;
  private onDone: (r: JobResult) => void;
  private onError: (job: Job, code: string, message: string) => void;

  constructor(
    size: number,
    timeoutMs: number,
    stallMs: number,
    onHash: (job: Job, sha: Buffer) => boolean,
    onDone: (r: JobResult) => void,
    onError: (job: Job, code: string, message: string) => void,
    /** The worker script; tests substitute one that misbehaves on purpose. */
    workerUrl = new URL("./worker.ts", import.meta.url),
  ) {
    this.timeoutMs = timeoutMs;
    this.stallMs = stallMs;
    this.workerUrl = workerUrl;
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
      worker: i + 1, file: s.job?.abs ?? null, size: s.job?.size ?? 0, since: s.since, stage: s.job ? s.stage : "idle", read: s.job ? s.read : 0,
    }));
  }

  submit(job: Job): boolean {
    const slot = this.slots.find((s) => !s.job);
    if (!slot) return false;
    slot.job = job;
    slot.since = Date.now();
    slot.stage = "reading";                 // read + hash, until the worker reports the hash
    slot.read = 0;
    this.watchRead(slot);
    slot.w.postMessage({ t: "job", ...job });
    return true;
  }

  /** (Re)arm the stall clock: it only runs out if the read stops moving. */
  private watchRead(slot: Slot) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => this.kill(slot, "STALL", `no progress reading the file for ${Math.round(this.stallMs / 1000)}s`), this.stallMs);
  }

  /**
   * Shutting down. An idle worker is asked to leave and ends on its own; only a busy one,
   * or one that has not left within `graceMs`, is terminated. Forcing a thread down is
   * the one way to stop a hung parser, and stays that - but it is the harsh path: native
   * code loaded in the thread gets no chance to wind down (pdf.js's canvas add-on crashed
   * the whole process that way, docs/18 Phase 6; it is now kept out, analyze/pdf.ts). A
   * shutdown has no reason to take that path for threads that are simply idle.
   *
   * A stopped pool is silent. Every job's clock is cleared and the job forgotten: nothing
   * is reported for it later (it is read again at the next start, as after a crash). A
   * clock left running here once kept a process alive for the whole analysis deadline
   * (3 min) and then reported a TIMEOUT to an engine that had stopped. Calling stop()
   * again returns the same shutdown.
   */
  stop(graceMs = 3000): Promise<void> {
    return (this.stopping ??= this.shutdown(graceMs));
  }

  private async shutdown(graceMs: number) {
    this.stopped = true;
    await Promise.all(this.slots.map((s) => new Promise<void>((resolve) => {
      const w = s.w;
      const busy = s.job != null;
      this.release(s);
      if (busy) { void w.terminate().then(() => resolve(), () => resolve()); return; }
      const force = setTimeout(() => { void w.terminate().then(() => resolve(), () => resolve()); }, graceMs);
      w.once("exit", () => { clearTimeout(force); resolve(); });
      w.postMessage({ t: "leave" });
    })));
  }

  private spawn(): Slot {
    const w = new Worker(this.workerUrl);
    const slot: Slot = { w, job: null, timer: null, since: 0, stage: "idle", read: 0 };
    w.on("message", (m: { t: string; id: number; sha: Uint8Array; bytes?: number; actual: { size: number; mtime: number }; a?: Analysis; index?: string; code?: string; message?: string }) => {
      const job = slot.job;
      if (!job || job.id !== m.id) return;
      if (m.t === "progress") {
        if (slot.stage === "reading") { slot.read = m.bytes ?? slot.read; this.watchRead(slot); }
        return;
      }
      if (m.t === "hash") {
        // The bytes are read; from here a fixed deadline applies to analysis.
        if (slot.timer) clearTimeout(slot.timer);
        slot.read = job.size;
        slot.timer = setTimeout(() => this.kill(slot, "TIMEOUT", `analysis exceeded ${Math.round(this.timeoutMs / 1000)}s`), this.timeoutMs);
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
