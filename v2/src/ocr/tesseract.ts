// Tesseract, one process per image. OMP_THREAD_LIMIT=1 so parallelism is ours to
// control (a pool of N processes), not Tesseract's (which would oversubscribe cores).
import { execFile } from "node:child_process";
import fs from "node:fs";

const CANDIDATES = [process.env.ATLAS_TESSERACT, "C:\\Program Files\\Tesseract-OCR\\tesseract.exe", "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe"];
export const tesseractExe = CANDIDATES.find((p) => p && fs.existsSync(p)) ?? null;

export function tesseract(image: string, opts: { langs: string; tessdata: string; psm?: number; timeoutMs?: number }): Promise<{ text: string; ms: number }> {
  if (!tesseractExe) return Promise.reject(new Error("Tesseract is not installed"));
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    execFile(tesseractExe, [image, "stdout", "-l", opts.langs, "--tessdata-dir", opts.tessdata, "--psm", String(opts.psm ?? 3)], {
      env: { ...process.env, OMP_THREAD_LIMIT: "1" }, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024,
      windowsHide: true, encoding: "utf8",
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ text: stdout, ms: Math.round(performance.now() - t0) });
    });
  });
}
