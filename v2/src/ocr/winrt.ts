// Client for bin/atlas-winrt.exe: Windows' built-in OCR and PDF rendering.
// One helper process serves requests one at a time; run several for parallelism.
// A request that exceeds its deadline kills the helper (it is then restarted on the
// next call), so a pathological image cannot wedge OCR.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { config } from "../config.ts";

export interface OcrText { text: string; lines: number; angle: number; w: number; h: number; ms: number }

interface Pending { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export const winrtExe = path.join(config.appDir, "bin", "atlas-winrt.exe");
export const winrtAvailable = () => process.platform === "win32" && fs.existsSync(winrtExe);

export class WinRt {
  private p: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private next = 1;
  private timeoutMs: number;

  constructor(timeoutMs = 60_000) {
    this.timeoutMs = timeoutMs;
  }

  private ensure(): ChildProcess {
    if (this.p) return this.p;
    const p = spawn(winrtExe, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    readline.createInterface({ input: p.stdout! }).on("line", (line) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { return; }
      const pend = this.pending.get(msg.id as number);
      if (!pend) return;
      this.pending.delete(msg.id as number);
      clearTimeout(pend.timer);
      // `code`: the Windows error, when there is one (Apply tells "exists" from "in use" by it).
      if (msg.error) pend.reject(Object.assign(new Error(String(msg.error)), { code: msg.code }));
      else pend.resolve(msg);
    });
    p.on("exit", () => {
      if (this.p === p) this.p = null;
      for (const [id, pend] of this.pending) { clearTimeout(pend.timer); pend.reject(new Error("OCR helper exited")); this.pending.delete(id); }
    });
    p.on("error", () => { /* surfaced through exit */ });
    this.p = p;
    return p;
  }

  private call(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = this.ensure();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OCR helper timed out after ${this.timeoutMs} ms`));
        p.kill(); // wedged: start a fresh one next time
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      p.stdin!.write(JSON.stringify({ ...req, id }) + "\n");
    });
  }

  async langs(): Promise<string[]> { return (await this.call({ op: "langs" })).langs as string[]; }
  async ocr(file: string, lang: string): Promise<OcrText> { return (await this.call({ op: "ocr", path: file, lang })) as unknown as OcrText; }
  async pages(pdf: string): Promise<number> { return (await this.call({ op: "pages", path: pdf })).pages as number; }
  async ocrPdf(pdf: string, page: number, dpi: number, lang: string): Promise<OcrText> {
    return (await this.call({ op: "ocrpdf", path: pdf, page, dpi, lang })) as unknown as OcrText;
  }
  async render(pdf: string, page: number, dpi: number, out: string): Promise<void> { await this.call({ op: "render", path: pdf, page, dpi, out }); }
  /** Explorer's own thumbnail for a file, written to `out`. Rejects "no thumbnail" when Windows has none. */
  async thumb(file: string, size: number, out: string): Promise<{ w: number; h: number; source: string; format: string; bytes: number; ms: number }> {
    return (await this.call({ op: "thumb", path: file, size, out })) as unknown as { w: number; h: number; source: string; format: string; bytes: number; ms: number };
  }

  /** Rename on one volume that never replaces an existing file (native/winrt.cs Move). */
  async move(from: string, to: string): Promise<void> { await this.call({ op: "move", path: from, to }); }
  /** Set a file's creation time (a copy gets a new one; Apply gives it back the original's). */
  async setCreated(file: string, unixMs: number): Promise<void> { await this.call({ op: "created", path: file, t: Math.round(unixMs) }); }

  close() { this.p?.kill(); this.p = null; }
}
