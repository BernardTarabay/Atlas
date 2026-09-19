// The engine: one scheduler loop over durable per-file state.
//
// There is no job table and no "running" state in the database. The DB records
// only facts (NEW, IDENT, DONE...). What is in flight lives in memory; after a
// crash it is simply gone, and every row below DONE is picked up again. Every
// step is idempotent (contents are keyed by SHA-256, plans are recomputed), so
// redoing work is always safe.
//
// Each tick: fill idle workers with NEW files -> write finished results in one
// transaction -> plan a bounded batch of IDENT files. Ticks are short so the
// HTTP server on the same thread stays responsive.
import path from "node:path";
import type { Db } from "../db/db.ts";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { AnalyzePool, type JobResult } from "./pool.ts";
import type { Job } from "./worker.ts";
import { S, C, OCR } from "./states.ts";
import { scanRoot, type ScanStats } from "../scan/scanner.ts";
import { planBatch } from "../plan/planner.ts";
import { ANALYZER_VERSION } from "../analyze/analyze.ts";
import { extOf } from "../analyze/sniff.ts";
import { OcrService, type OcrResult } from "../ocr/ocr.ts";
import { assessText } from "../analyze/quality.ts";
import { detectDocType, openingLines } from "../analyze/dtype.ts";
import { headingFrom } from "../analyze/title.ts";
import { indexText } from "../search/text.ts";

interface Failure { job: Job; code: string; message: string }
interface OcrOutcome { cid: number; result?: OcrResult; error?: string }

export interface Counters {
  hashed: number; analyzed: number; duplicates: number; bytes: number; errors: number; planned: number;
  ocrDone: number; ocrFailed: number; ocrPages: number; msOcr: number;
  /** Main-thread milliseconds per activity: the engine's own profile. */
  msDispatch: number; msDecide: number; msFlush: number; msPlan: number;
}

export class Engine {
  pool!: AnalyzePool;
  private roots = new Map<number, string>();
  private inflight = new Set<number>();
  private retryAt = new Map<number, number>();
  private extracting = new Set<string>(); // uppercase hex, matches SQLite hex()
  private jobSha = new Map<number, string>(); // job id -> the content hash it is analyzing
  private done: JobResult[] = [];
  private failed: Failure[] = [];
  private cursor = 0;
  private queue: { id: number; root: number; path: string; size: number; mtime: number }[] = [];
  private lastFlush = 0;
  private lastPlan = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private scanQueue: number[] = [];
  private scanning: number | null = null;
  private lastWork = Date.now();
  readonly counters: Counters = {
    hashed: 0, analyzed: 0, duplicates: 0, bytes: 0, errors: 0, planned: 0,
    ocrDone: 0, ocrFailed: 0, ocrPages: 0, msOcr: 0, msDispatch: 0, msDecide: 0, msFlush: 0, msPlan: 0,
  };
  ocr: OcrService | null = null;
  private ocrInflight = new Set<number>();
  private ocrOut: OcrOutcome[] = [];
  readonly startedAt = Date.now();
  onBusyChange: (busy: boolean) => void = () => {};
  private busy = false;
  lastScans = new Map<number, ScanStats>();

  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  start() {
    this.running = true;
    this.reloadRoots();
    this.pool = new AnalyzePool(
      config.analyzeWorkers, config.jobTimeoutMs,
      (job, sha) => this.decide(job, sha),
      // A finished worker is idle NOW: wake the loop so it gets its next file immediately.
      (r) => { this.done.push(r); this.kick(); },
      (job, code, message) => { this.failed.push({ job, code, message }); this.kick(); },
    );
    // OCR is optional: without an engine, contents simply stay "waiting for OCR".
    if (config.ocrWorkers > 0 && OcrService.available()) this.ocr = new OcrService(config.ocrWorkers);
    this.tick();
    log.info("engine started", { workers: config.analyzeWorkers, ocrWorkers: this.ocr ? config.ocrWorkers : 0, roots: this.roots.size });
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.pool?.stop();
    this.flush(); // results that finished before the pool stopped are not lost
    this.flushOcr();
    this.ocr?.close();
    log.info("engine stopped");
  }

  reloadRoots() {
    this.roots.clear();
    for (const r of this.db.all<{ id: number; path: string }>("SELECT id, path FROM roots WHERE enabled = 1")) this.roots.set(r.id, r.path);
  }

  /** Queue scans (all enabled roots when no id is given). Scans run one at a time: they compete for the same disks. */
  requestScan(rootId?: number) {
    const ids = rootId != null ? [rootId] : [...this.roots.keys()];
    for (const id of ids) if (id !== this.scanning && !this.scanQueue.includes(id)) this.scanQueue.push(id);
    this.kick();
  }

  get scanState() {
    return { scanning: this.scanning, queued: [...this.scanQueue] };
  }

  get isBusy() {
    return this.busy;
  }

  private immediate: NodeJS.Immediate | null = null;

  /** Run a tick as soon as the current event-loop turn ends; coalesces many wake-ups into one. */
  private kick() {
    if (!this.running || this.immediate) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.immediate = setImmediate(() => { this.immediate = null; this.tick(); });
  }

  private tick() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.running) return;
    let worked = false;
    try {
      this.maybeScan();
      let t = performance.now();
      worked = this.dispatch() || worked;
      this.counters.msDispatch += performance.now() - t;
      const now = Date.now();
      const idlePool = this.pool.busy === 0;
      if (this.done.length || this.failed.length) {
        if (this.done.length + this.failed.length >= 500 || now - this.lastFlush > 250 || idlePool) {
          t = performance.now();
          this.flush();
          this.counters.msFlush += performance.now() - t;
          worked = true;
        }
      }
      if (this.ocrOut.length) { this.flushOcr(); worked = true; }
      worked = this.dispatchOcr() || worked;
      // Planning is batched: one big batch every 250 ms beats a small one per finished file.
      if (idlePool || now - this.lastPlan > 250) {
        this.lastPlan = now;
        t = performance.now();
        const planned = planBatch(this.db, 1000, this.extracting);
        this.counters.msPlan += performance.now() - t;
        this.counters.planned += planned;
        if (planned > 0 && idlePool) worked = true;
      }
    } catch (e) {
      log.error("engine tick failed", { error: (e as Error).stack });
    }
    const active = worked || this.pool.busy > 0 || (this.ocr?.busy ?? 0) > 0 || this.scanning != null;
    if (active) this.lastWork = Date.now();
    this.setBusy(active || Date.now() - this.lastWork < 60_000);
    // More work likely waiting: go again right away. Otherwise the pool's callbacks wake us;
    // the timer is only a safety net (and what notices rows added by a scan or the API).
    if (worked) this.kick();
    else if (!this.immediate) this.timer = setTimeout(() => this.tick(), this.pool.busy > 0 ? 100 : 250);
  }

  private setBusy(b: boolean) {
    if (b === this.busy) return;
    this.busy = b;
    this.onBusyChange(b);
  }

  private maybeScan() {
    if (this.scanning != null || !this.scanQueue.length) return;
    const id = this.scanQueue.shift()!;
    if (!this.roots.has(id)) return;
    this.scanning = id;
    scanRoot(this.db, id)
      .then((s) => { this.lastScans.set(id, s); })
      .catch((e) => {
        log.error("scan failed", { root: this.roots.get(id), error: (e as Error).message });
        this.db.run("UPDATE roots SET scan_error = ? WHERE id = ?", (e as Error).message.slice(0, 300), id);
      })
      .finally(() => { this.scanning = null; this.kick(); });
  }

  /**
   * Refill the in-memory queue from the pending index, 1000 rows at a time. The cursor
   * walks forward by id; when it runs off the end it restarts, which is how rows that
   * became NEW again (changed files, retries) are picked up.
   */
  private refill() {
    const batch = 1000;
    let rows = this.db.all<{ id: number; root: number; path: string; size: number; mtime: number }>(
      `SELECT id, root, path, size, mtime FROM files WHERE state = ${S.NEW} AND id > ? ORDER BY id LIMIT ?`, this.cursor, batch);
    if (!rows.length && this.cursor > 0) {
      this.cursor = 0;
      rows = this.db.all(`SELECT id, root, path, size, mtime FROM files WHERE state = ${S.NEW} ORDER BY id LIMIT ?`, batch);
    }
    if (rows.length) this.cursor = rows[rows.length - 1].id;
    const now = Date.now();
    for (const r of rows) {
      if (this.inflight.has(r.id)) continue;
      const due = this.retryAt.get(r.id);
      if (due && due > now) continue;
      this.queue.push(r);
    }
  }

  /** Fill idle workers from the queue. */
  private dispatch(): boolean {
    let idle = this.pool.idle;
    if (idle === 0) return false;
    if (this.queue.length === 0) this.refill();
    let sent = false;
    while (idle > 0 && this.queue.length) {
      const r = this.queue.shift()!;
      if (this.inflight.has(r.id)) continue;
      const root = this.roots.get(r.root);
      if (!root) continue;
      const job: Job & { mtime: number } = {
        id: r.id, abs: path.join(root, ...r.path.split("/")), size: r.size, ext: extOf(r.path), mtime: r.mtime,
        wholeFileBytes: config.wholeFileBytes, maxParseBytes: config.maxParseBytes, maxTextChars: config.maxTextChars,
      };
      if (!this.pool.submit(job)) { this.queue.unshift(r); break; }
      this.inflight.add(r.id);
      idle--;
      sent = true;
    }
    return sent;
  }

  /** After hashing: analyze only content never seen before (and not being analyzed right now). */
  private decide(job: Job, sha: Buffer): boolean {
    const t = performance.now();
    try {
      this.counters.hashed++;
      const hex = sha.toString("hex").toUpperCase();
      if (this.extracting.has(hex)) { this.counters.duplicates++; return false; }
      const known = this.db.get<{ state: number; av: number }>("SELECT state, av FROM contents WHERE sha = ?", sha);
      if (known && known.state >= C.ANALYZED && known.av >= ANALYZER_VERSION) { this.counters.duplicates++; return false; }
      this.extracting.add(hex);
      this.jobSha.set(job.id, hex);
      return true;
    } finally {
      this.counters.msDecide += performance.now() - t;
    }
  }

  private releaseSha(jobId: number) {
    const hex = this.jobSha.get(jobId);
    if (hex) { this.extracting.delete(hex); this.jobSha.delete(jobId); }
  }

  /**
   * OCR runs per unique CONTENT, never per copy. Contents marked PENDING are picked
   * through the small partial index contents_ocr, with any one readable file as the
   * source. In-flight OCR lives only in memory: after a crash the row is still
   * PENDING and simply runs again.
   */
  private dispatchOcr(): boolean {
    const ocr = this.ocr;
    if (!ocr || ocr.idle === 0) return false;
    const rows = this.db.all<{ cid: number; kind: string; root: number; path: string }>(
      `SELECT c.id AS cid, c.kind, f.root, f.path FROM contents c
       JOIN files f ON f.id = (SELECT id FROM files WHERE content = c.id AND state IN (${S.IDENT}, ${S.DONE}) LIMIT 1)
       WHERE c.ocr = ${OCR.PENDING} LIMIT ?`, ocr.idle + this.ocrInflight.size);
    let sent = false;
    for (const r of rows) {
      if (ocr.idle === 0) break;
      if (this.ocrInflight.has(r.cid)) continue;
      const root = this.roots.get(r.root);
      if (!root) continue;
      this.ocrInflight.add(r.cid);
      const abs = path.join(root, ...r.path.split("/"));
      ocr.recognize(abs, r.kind === "pdf" ? "pdf" : "image")
        .then((result) => this.ocrOut.push({ cid: r.cid, result }))
        .catch((e: Error) => this.ocrOut.push({ cid: r.cid, error: e.message.slice(0, 300) }))
        .finally(() => this.kick());
      sent = true;
    }
    return sent;
  }

  /** Record OCR results: text, index, document type, language; then re-plan the content's files. */
  private flushOcr() {
    const out = this.ocrOut;
    this.ocrOut = [];
    if (!out.length) return;
    const db = this.db;
    db.tx(() => {
      for (const o of out) {
        this.ocrInflight.delete(o.cid);
        const c = db.get<{ title: string | null; dtype: string | null; lang: string | null; meta: string | null; quality: string | null; kind: string }>(
          "SELECT title, dtype, lang, meta, quality, kind FROM contents WHERE id = ?", o.cid);
        if (!c) continue;
        const meta = c.meta ? (JSON.parse(c.meta) as Record<string, unknown>) : {};
        if (!o.result) {
          this.counters.ocrFailed++;
          meta.ocrError = o.error;
          db.run(`UPDATE contents SET ocr = ${OCR.FAILED}, meta = ? WHERE id = ?`, JSON.stringify(meta), o.cid);
          continue;
        }
        const r = o.result;
        this.counters.ocrDone++;
        this.counters.ocrPages += r.pages;
        this.counters.msOcr += r.ms;
        const text = r.text.slice(0, config.maxTextChars);
        const quality = assessText(text);
        if (text) db.run("INSERT INTO texts(content, src, body) VALUES (?, 'o', ?) ON CONFLICT(content, src) DO UPDATE SET body = excluded.body", o.cid, text);
        // The index holds everything readable about the content: any text layer, plus OCR
        // unless the OCR came back as noise.
        const extracted = c.quality === "ok" ? db.get<{ body: string }>("SELECT body FROM texts WHERE content = ? AND src = 'x'", o.cid)?.body ?? "" : "";
        const heading = (meta.heading as string | undefined) ?? (quality === "ok" ? headingFrom(text) ?? undefined : undefined);
        const useful = quality === "ok" || quality === "too_short";
        const body = indexText([c.title ?? "", heading ?? "", extracted, useful ? text : ""].join("\n"));
        db.run("DELETE FROM fts_text WHERE rowid = ?", o.cid);
        if (body.trim()) db.run("INSERT INTO fts_text(rowid, body) VALUES (?, ?)", o.cid, body);
        let dtype = c.dtype;
        if (!dtype && quality === "ok" && c.kind !== "sheet") {
          const dt = detectDocType(`${heading ?? ""}\n${openingLines(text)}`, text.slice(0, 600), text);
          if (dt) { dtype = dt.type; meta.dtypeMatched = dt.matched.slice(0, 6); }
        }
        if (heading) meta.heading = heading;
        meta.ocr = { engine: r.engine, lang: r.lang, pages: r.pages, chars: text.length, quality, ms: r.ms };
        db.run(`UPDATE contents SET ocr = ${OCR.DONE}, dtype = ?, lang = coalesce(lang, ?), meta = ? WHERE id = ?`,
          dtype, r.lang, JSON.stringify(meta), o.cid);
        // What the file is may have changed (a photo turned out to be an invoice): re-plan its copies.
        db.run(`UPDATE files SET state = ${S.IDENT} WHERE content = ? AND state = ${S.DONE}`, o.cid);
      }
    });
  }

  /** Write every finished result in one transaction. */
  flush() {
    const done = this.done;
    const failed = this.failed;
    this.done = [];
    this.failed = [];
    this.lastFlush = Date.now();
    if (!done.length && !failed.length) return;
    const db = this.db;
    const upsertFull = db.q(
      `INSERT INTO contents(sha, size, kind, mime, state, ocr, quality, lang, dtype, title, ddate, dsrc, width, height, pages, meta, tlen, av)
       VALUES (?, ?, ?, ?, ${C.ANALYZED}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sha) DO UPDATE SET kind = excluded.kind, mime = excluded.mime, state = excluded.state, ocr = excluded.ocr,
         quality = excluded.quality, lang = excluded.lang, dtype = excluded.dtype, title = excluded.title, ddate = excluded.ddate,
         dsrc = excluded.dsrc, width = excluded.width, height = excluded.height, pages = excluded.pages, meta = excluded.meta,
         tlen = excluded.tlen, av = excluded.av
       WHERE contents.state < excluded.state OR contents.av < excluded.av`);
    const insertStub = db.q("INSERT INTO contents(sha, size) VALUES (?, ?) ON CONFLICT(sha) DO NOTHING");
    const contentId = db.q("SELECT id FROM contents WHERE sha = ?");
    const putText = db.q("INSERT INTO texts(content, src, body) VALUES (?, 'x', ?) ON CONFLICT(content, src) DO UPDATE SET body = excluded.body");
    const delFts = db.q("DELETE FROM fts_text WHERE rowid = ?");
    const addFts = db.q("INSERT INTO fts_text(rowid, body) VALUES (?, ?)");
    // Recorded with the size/mtime the worker actually read, which is what the hash describes.
    // If the file changes again later, the next scan sees the difference and it is re-read.
    const link = db.q(`UPDATE files SET content = ?, state = ${S.IDENT}, tries = 0, err = NULL, size = ?, mtime = ? WHERE id = ? AND state = ${S.NEW}`);
    const fail = db.q(`UPDATE files SET tries = tries + 1, err = ?, state = CASE WHEN tries + 1 >= ? THEN ${S.FAILED} ELSE state END WHERE id = ? AND state = ${S.NEW}`);
    const gone = db.q(`UPDATE files SET state = ${S.MISSING}, err = ? WHERE id = ?`);
    // Copies planned while this content was still unanalyzed get re-planned with the real analysis.
    const replanGroup = db.q(`UPDATE files SET state = ${S.IDENT} WHERE content = ? AND state = ${S.DONE}`);
    // A title shared by 5 contents is template boilerplate, not a name (planner.ts). The moment a
    // title crosses that line, files already named from it are re-planned, so names never depend
    // on how far processing had got when a file happened to be planned.
    const titleCount = db.q("SELECT count(*) AS n FROM (SELECT 1 FROM contents WHERE title = ? LIMIT 6)");
    const replanTitle = db.q(`UPDATE files SET state = ${S.IDENT} WHERE state = ${S.DONE} AND content IN (SELECT id FROM contents WHERE title = ?)`);

    db.tx(() => {
      for (const r of done) {
        const j = r.job as Job & { mtime: number };
        this.inflight.delete(j.id);
        this.counters.bytes += j.size;
        if (r.a) {
          const a = r.a;
          this.counters.analyzed++;
          upsertFull.run(r.sha, j.size, a.kind, a.mime, a.ocr ?? OCR.NA, a.quality, a.lang, a.dtype, a.title, a.ddate, a.dsrc,
            a.width, a.height, a.pages, a.meta ? JSON.stringify(a.error ? { ...a.meta, error: a.error } : a.meta) : null,
            a.text.length, ANALYZER_VERSION);
          const cid = (contentId.get(r.sha) as { id: number }).id;
          if (a.text) putText.run(cid, a.text);
          if (r.index) { delFts.run(cid); addFts.run(cid, r.index); }
          replanGroup.run(cid);
          if (a.title && (titleCount.get(a.title) as { n: number }).n === 5) replanTitle.run(a.title);
          this.releaseSha(j.id);
        } else {
          insertStub.run(r.sha, j.size);
        }
        const cid = (contentId.get(r.sha) as { id: number }).id;
        link.run(cid, r.actual.size, r.actual.mtime, j.id);
        this.retryAt.delete(j.id);
      }
      for (const f of failed) {
        this.inflight.delete(f.job.id);
        this.counters.errors++;
        // A crashed/timed-out analysis must not leave its duplicates waiting forever.
        this.releaseSha(f.job.id);
        if (f.code === "ENOENT") gone.run("file disappeared before it could be read", f.job.id);
        else if (f.code === "UNSTABLE") this.retryAt.set(f.job.id, Date.now() + 60_000); // still being written: let it settle
        else {
          fail.run(`${f.code}: ${f.message}`.slice(0, 300), config.maxTries, f.job.id);
          const tries = (this.db.get<{ tries: number }>("SELECT tries FROM files WHERE id = ?", f.job.id)?.tries) ?? 1;
          this.retryAt.set(f.job.id, Date.now() + 30_000 * tries);
        }
      }
    });
    if (failed.length) {
      log.warn("files could not be read", { count: failed.length, sample: failed.slice(0, 5).map((f) => ({ id: f.job.id, code: f.code, msg: f.message })) });
    }
  }
}
