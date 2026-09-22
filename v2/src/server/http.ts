// The HTTP surface: local UI, remote UI (through `tailscale serve`), JSON API,
// and file streaming. Bound to loopback only.
//
// Security, proportionate to one user:
//   - Host header allowlist (localhost, *.ts.net): defeats DNS rebinding
//   - Origin must match Host on every state-changing request: defeats CSRF
//   - one owner session (HttpOnly, SameSite=Strict cookie)
//   - "local" = no Tailscale identity header. Setup and host-folder browsing are local-only.
//   - files are only served by id, from rows whose path resolves inside a registered root
//   - active formats (HTML/SVG/XML) are never rendered on Atlas's origin
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/db.ts";
import type { Engine } from "../pipeline/engine.ts";
import { config } from "../config.ts";
import { log } from "../log.ts";
import * as auth from "./auth.ts";
import { listFolder, fileDetail, counts, photos, find, dashboard, stats, duplicateGroups, failedFiles, type StatsQuery } from "../library.ts";
import { chat, READ_ONLY, designCard } from "../ai/assistant.ts";
import { aiAvailable, AiError } from "../ai/gemini.ts";
import { search } from "../search/search.ts";
import { addRoot, removeRoot, resolveFile, RootError } from "../roots.ts";
import { kindFromExt, extOf } from "../analyze/sniff.ts";
import { safeSegment } from "../plan/names.ts";
import { Thumbs, bucket, THUMB_V } from "../thumbs.ts";
import { S as STATE } from "../pipeline/states.ts";
import type { IntentExport } from "../intent.ts";
import type { Maintenance } from "../db/maintenance.ts";

type Req = http.IncomingMessage & { remote: boolean; https: boolean; url: string };
type Res = http.ServerResponse;
type Handler = (req: Req, res: Res, m: RegExpExecArray, body: Record<string, unknown>) => unknown | Promise<unknown>;

const COOKIE = "atlas_sid";
const extraHosts = (process.env.ATLAS_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const ACTIVE_TYPES = /^(text\/html|application\/xhtml|image\/svg|application\/xml|text\/xml)/;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h.endsWith(".ts.net") || extraHosts.includes(h);
}

function cookie(req: Req, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function json(res: Res, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req: Req): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "request too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid JSON"); }
}


/**
 * A folder inside the virtual library, sanitized segment by segment.
 *
 * This value becomes part of `files.plan`, which is what the apply step will one
 * day turn into a real path - so it is checked here as strictly as a real path
 * would be: no traversal, no drive letters, no reserved names, no trailing dots.
 */
function libraryFolder(input: string): string {
  const parts = input.split(/[/\\]/).map((p) => p.trim()).filter((p) => p && p !== ".");
  if (parts.some((p) => p === ".." || /^[a-zA-Z]:$/.test(p))) throw new HttpError(400, "invalid folder");
  const clean = parts.map((p) => safeSegment(p));
  if (!clean.length) throw new HttpError(400, "invalid folder");
  if (clean.join("/").length > 400) throw new HttpError(400, "folder path too long");
  return clean.join("/");
}

const APP_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' blob: data:; media-src 'self'; frame-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const STATIC: Record<string, string> = {
  "/": "index.html", "/app.js": "app.js", "/app.css": "app.css", "/explorer.js": "explorer.js", "/assistant.js": "assistant.js", "/dashboard.js": "dashboard.js",
  "/dashboard.css": "dashboard.css", "/motion.css": "motion.css",
  "/explorer.css": "explorer.css", "/icon.svg": "icon.svg", "/manifest.webmanifest": "manifest.webmanifest",
};
const STATIC_TYPE: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml", webmanifest: "application/manifest+json" };

function serveStatic(res: Res, file: string) {
  const abs = path.join(config.uiDir, file);
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { ...APP_HEADERS, "content-type": STATIC_TYPE[extOf(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
}

function contentDisposition(kind: "inline" | "attachment", name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function streamFile(db: Db, req: Req, res: Res, id: number, download: boolean) {
  const row = db.get<{ path: string; rootPath: string; mime: string | null }>(
    "SELECT f.path, r.path AS rootPath, c.mime FROM files f JOIN roots r ON r.id = f.root LEFT JOIN contents c ON c.id = f.content WHERE f.id = ?", id);
  if (!row) throw new HttpError(404, "no such file");
  const abs = resolveFile(row.rootPath, row.path);
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { throw new HttpError(410, "the file is no longer at its location"); }
  const name = row.path.slice(row.path.lastIndexOf("/") + 1);
  let type = row.mime || kindFromExt(extOf(name)).mime;
  const headers: Record<string, string | number> = {
    "accept-ranges": "bytes", "x-content-type-options": "nosniff", "cache-control": "private, max-age=300",
    "content-disposition": contentDisposition(download ? "attachment" : "inline", name),
  };
  if (!download && ACTIVE_TYPES.test(type)) {
    // An HTML/SVG file from the library must never run as a page on Atlas's origin.
    type = "text/plain; charset=utf-8";
    headers["content-security-policy"] = "sandbox";
  }
  if (type.startsWith("text/") && !type.includes("charset")) type += "; charset=utf-8";
  headers["content-type"] = type;
  let start = 0, end = st.size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && st.size > 0) {
    start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { "content-range": `bytes */${st.size}` }); res.end(); return; }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, "content-length": st.size });
  }
  if (req.method === "HEAD" || st.size === 0) { res.end(); return; }
  const s = fs.createReadStream(abs, { start, end, highWaterMark: 1 << 20 });
  s.on("error", () => res.destroy());
  s.pipe(res);
}

/** Subfolders of a host folder, for choosing roots. Local requests only; directories only, never files. */
function browse(p: string | null) {
  if (!p) {
    const drives: string[] = [];
    if (process.platform === "win32") for (let c = 67; c <= 90; c++) { const d = String.fromCharCode(c) + ":\\"; if (fs.existsSync(d)) drives.push(d); }
    const home = process.env.USERPROFILE;
    return { path: null, dirs: [...(home ? [home] : []), ...drives] };
  }
  const abs = path.resolve(p);
  const dirs = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("$") && e.name !== "System Volume Information")
    .map((e) => path.join(abs, e.name)).sort((a, b) => a.localeCompare(b));
  return { path: abs, parent: path.dirname(abs) !== abs ? path.dirname(abs) : null, dirs };
}

/**
 * A file's thumbnail. Content-addressed, so the response can be cached by the
 * browser for good: the same URL can never mean different pixels, because a
 * changed file is a different content with a different hash.
 */
async function sendThumb(db: Db, thumbs: Thumbs, req: Req, res: Res, id: number, want: number) {
  const row = db.get<{ path: string; rootPath: string; sha: string | null }>(
    `SELECT f.path, r.path AS rootPath, hex(c.sha) AS sha FROM files f JOIN roots r ON r.id = f.root
     LEFT JOIN contents c ON c.id = f.content WHERE f.id = ?`, id);
  if (!row?.sha) throw new HttpError(404, "no thumbnail");
  const size = bucket(want);
  const etag = `"${row.sha.slice(0, 16)}-${size}-v${THUMB_V}"`;
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag }); res.end(); return; }
  const abs = resolveFile(row.rootPath, row.path);
  let closed = false;
  res.on("close", () => { closed = true; });
  const file = await thumbs.get(row.sha, abs, size, () => closed);
  if (closed) return;
  if (!file) {
    // Short-lived: the file may gain a thumbnail handler, or come back online.
    res.writeHead(404, { "cache-control": "private, max-age=600", "content-type": "text/plain" });
    res.end("no thumbnail");
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": body[0] === 0x89 ? "image/png" : "image/jpeg",
    "content-length": body.length,
    "cache-control": "private, max-age=31536000, immutable",
    etag,
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

/**
 * A folder or name chosen by hand, on any file that is still on disk. A file that
 * is waiting to be read or re-planned keeps its state and gets the choice anyway;
 * only a planned one needs planning again. (Writing only to planned files used to
 * drop the choice, silently, for a file caught mid-processing.)
 */
const SET_PIN = `UPDATE files SET pin = ?, state = CASE WHEN state = ${STATE.DONE} THEN ${STATE.IDENT} ELSE state END
  WHERE id = ? AND state <> ${STATE.MISSING}`;
const SET_PINNAME = `UPDATE files SET pinname = ?, state = CASE WHEN state = ${STATE.DONE} THEN ${STATE.IDENT} ELSE state END
  WHERE id = ? AND state <> ${STATE.MISSING}`;

/**
 * `intent` receives every change a person makes (roots, folders and names chosen
 * by hand), after it is durably in the database, and exports it (src/intent.ts).
 */
export function startServer(db: Db, engine: Engine, intent?: IntentExport, maint?: Maintenance): http.Server {
  const thumbs = new Thumbs(2);
  /** A person decided something: it is on disk (Db.durable) before the response, and exported soon after. */
  const decided = () => { intent?.changed(); engine.wake(); };
  /**
   * A database that failed its integrity check is not written to: a decision saved
   * into it could be lost with it, and the way back is a restore. Reads still work.
   */
  const writable = () => {
    if (maint?.health.integrity === "failed") {
      throw new HttpError(503, "The database failed its integrity check, so Atlas has stopped changing it. Stop Atlas and run: npm run db -- restore");
    }
  };
  /** What the Status page shows about the database itself. */
  const safety = () => {
    if (!maint) return null;
    const h = maint.health;
    return {
      integrity: h.integrity, detail: h.detail.slice(0, 5), checkedAt: h.checkedAt,
      backup: { at: h.backup.last?.at ?? null, bytes: h.backup.last?.bytes ?? null, count: h.backup.count, running: h.backup.running, error: h.backup.error, dir: h.backup.dir },
    };
  };
  let statesCache: { at: number; value: ReturnType<typeof counts> } | null = null;
  let dashCache: { at: number; value: ReturnType<typeof dashboard> } | null = null;
  const routes: [string, RegExp, Handler, { public?: boolean; local?: boolean }?][] = [
    ["GET", /^\/api\/health$/, () => ({ ok: true }), { public: true }],
    ["GET", /^\/api\/session$/, (req) => ({
      authenticated: auth.checkSession(db, cookie(req, COOKIE)), setupNeeded: !auth.hasPassword(db), local: !req.remote,
      setupFile: !auth.hasPassword(db) && !req.remote ? path.join(config.home, "setup-code.txt") : undefined,
    }), { public: true }],
    ["POST", /^\/api\/setup$/, (req, res, _m, b) => {
      if (!auth.setup(db, String(b.code ?? ""), String(b.password ?? ""))) throw new HttpError(403, "wrong setup code, or already set up");
      return login(req, res);
    }, { public: true, local: true }],
    ["POST", /^\/api\/login$/, (req, res, _m, b) => {
      if (!auth.loginAllowed()) throw new HttpError(429, "too many attempts; wait a few minutes");
      if (!auth.checkPassword(db, String(b.password ?? ""))) { auth.noteFailure(); throw new HttpError(401, "wrong password"); }
      return login(req, res);
    }, { public: true }],
    ["POST", /^\/api\/logout$/, (req, res) => {
      auth.endSession(db, cookie(req, COOKIE));
      res.setHeader("set-cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
      return { ok: true };
    }],
    ["POST", /^\/api\/password$/, (_req, _res, _m, b) => {
      if (!auth.checkPassword(db, String(b.current ?? ""))) throw new HttpError(403, "current password is wrong");
      auth.setPassword(db, String(b.password ?? ""));
      return { ok: true };
    }],
    ["GET", /^\/api\/status$/, () => {
      if (!statesCache || Date.now() - statesCache.at > 2000) statesCache = { at: Date.now(), value: counts(db) };
      return {
        version: "2.0.0-dev", uptime: Math.round((Date.now() - engine.startedAt) / 1000), busy: engine.isBusy,
        workers: { total: config.analyzeWorkers, busy: engine.pool.busy }, scan: engine.scanState, counters: engine.counters,
        ...statesCache.value,
        roots: db.all("SELECT id, path, role, enabled, online, fs, scan_at, scan_ms, scan_files, scan_error FROM roots ORDER BY id"),
      };
    }],
    ["GET", /^\/api\/library$/, (req) => {
      const u = new URL(req.url, "http://x");
      return listFolder(db, u.searchParams.get("path") ?? "", 2000, u.searchParams.has("folders"));
    }],
    // Moving a file in the library changes the PLAN, never the disk: it pins the
    // folder, and the planner keeps naming and collision handling. That is why this
    // is allowed while every disk-touching command is not.
    ["POST", /^\/api\/plan\/move$/, (_req, _res, _m, b) => {
      writable();
      const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isInteger) : [];
      if (!ids.length) throw new HttpError(400, "no files given");
      if (ids.length > 5000) throw new HttpError(413, "too many files in one move");
      const folder = libraryFolder(String(b.folder ?? ""));
      // What Undo puts back: the choices these files had, captured before the change.
      const before = db.all<{ id: number; pin: string | null }>(
        `SELECT id, pin, pinname FROM files WHERE id IN (SELECT value FROM json_each(?)) AND state <> ${STATE.MISSING}`, JSON.stringify(ids));
      const set = db.q(SET_PIN);
      let moved = 0;
      db.durable(() => { for (const id of ids) moved += Number(set.run(folder, id).changes); });
      decided();
      // `skipped`: files no longer on disk (or unknown ids). Said, not hidden.
      return { moved, skipped: ids.length - moved, folder, before };
    }],
    // Undo, and "let the rules decide again", are the same operation.
    ["POST", /^\/api\/plan\/pin$/, (_req, _res, _m, b) => {
      writable();
      const items = Array.isArray(b.items) ? b.items : [];
      const set = db.q(SET_PIN);
      const setName = db.q(SET_PINNAME);
      let n = 0;
      db.durable(() => {
        for (const it of items as { id: unknown; pin: unknown; pinname?: unknown }[]) {
          const id = Number(it.id);
          if (!Number.isInteger(id)) continue;
          const pin = it.pin == null || it.pin === "" ? null : libraryFolder(String(it.pin));
          n += Number(set.run(pin, id).changes);
          if ("pinname" in it) {
            const nm = it.pinname == null || it.pinname === "" ? null : safeSegment(String(it.pinname));
            setName.run(nm, id);
          }
        }
      });
      decided();
      return { changed: n };
    }],
    ["GET", /^\/api\/search$/, (req) => {
      const u = new URL(req.url, "http://x");
      return search(db, u.searchParams.get("q") ?? "", {
        kind: u.searchParams.get("kind") ?? undefined,
        limit: Number(u.searchParams.get("limit") ?? 50),
        path: u.searchParams.get("in") ?? undefined,
      });
    }],
    // The status page. Headline numbers are cached for a second - they are GROUP
    // BYs, and the page polls - while activity is read straight from memory.
    ["GET", /^\/api\/dashboard$/, () => {
      if (!dashCache || Date.now() - dashCache.at > 1000) dashCache = { at: Date.now(), value: dashboard(db) };
      return { ...dashCache.value, busy: engine.isBusy, uptime: Math.round((Date.now() - engine.startedAt) / 1000), scan: engine.scanState, safety: safety() };
    }],
    ["GET", /^\/api\/activity$/, () => {
      const waiting = db.get<{ n: number }>("SELECT count(*) AS n FROM files WHERE state < 50")!.n;
      const ocrPending = db.get<{ n: number }>("SELECT count(*) AS n FROM contents WHERE ocr = 1 AND (onext IS NULL OR onext <= ?)", Date.now())!.n;
      const total = db.get<{ n: number }>("SELECT count(*) AS n FROM files WHERE state <> 70")!.n;
      return { ...engine.activity(), busy: engine.isBusy, scan: engine.scanState, waiting, ocrPending, total, counters: engine.counters };
    }],
    ["GET", /^\/api\/duplicates$/, (req) => duplicateGroups(db, Number(new URL(req.url, "http://x").searchParams.get("limit") ?? 8))],
    ["GET", /^\/api\/failed$/, (req) => failedFiles(db, Number(new URL(req.url, "http://x").searchParams.get("limit") ?? 10))],
    ["GET", /^\/api\/stats$/, (req) => {
      const u = new URL(req.url, "http://x");
      const t = (k: string) => u.searchParams.get(k) || undefined;
      try {
        return stats(db, {
          by: (t("by") ?? "kind") as StatsQuery["by"], metric: t("metric") as StatsQuery["metric"],
          kind: t("kind"), ext: t("ext"), dtype: t("dtype"), lang: t("lang"), folder: t("folder"),
          limit: u.searchParams.has("limit") ? Number(u.searchParams.get("limit")) : undefined,
        });
      } catch (e) { throw new HttpError(400, (e as Error).message); }
    }],
    ["POST", /^\/api\/ai\/card$/, async (_req, _res, _m, b) => {
      if (!aiAvailable()) throw new HttpError(503, "the assistant is off: no GEMINI_API_KEY");
      const request = String(b.request ?? "").trim();
      if (!request) throw new HttpError(400, "describe the card");
      try { return await designCard(request); } catch (e) {
        if (e instanceof AiError) throw new HttpError(502, e.message);
        throw e;
      }
    }],
    ["GET", /^\/api\/find$/, (req) => {
      const u = new URL(req.url, "http://x");
      const n = (k: string) => (u.searchParams.has(k) ? Number(u.searchParams.get(k)) : undefined);
      const t = (k: string) => u.searchParams.get(k) ?? undefined;
      return find(db, {
        ext: t("ext"), kind: t("kind"), dtype: t("dtype"), lang: t("lang"), folder: t("folder"),
        nameContains: t("name"), after: n("after"), before: n("before"),
        minSize: n("minSize"), maxSize: n("maxSize"), limit: n("limit"),
      });
    }],
    // Renaming changes the planned NAME, the way dragging changes the planned
    // folder. The rules still number it against its neighbours; the disk is not touched.
    ["POST", /^\/api\/plan\/rename$/, (_req, _res, _m, b) => {
      writable();
      const id = Number(b.id);
      if (!Number.isInteger(id)) throw new HttpError(400, "no file given");
      const name = safeSegment(String(b.name ?? "").split(/[/\\]/).pop() ?? "");
      if (!name || name === "_") throw new HttpError(400, "invalid name");
      const before = db.get<{ pinname: string | null; state: number }>("SELECT pinname, state FROM files WHERE id = ?", id);
      if (!before) throw new HttpError(404, "no such file");
      if (before.state === STATE.MISSING) throw new HttpError(409, "This file is no longer on disk, so it has no place in the library to rename.");
      db.durable(() => db.run(SET_PINNAME, name, id));
      decided();
      return { id, name, before: before.pinname };
    }],
    ["GET", /^\/api\/ai$/, () => ({ available: aiAvailable(), model: aiAvailable() ? config.ai.model : null })],
    ["POST", /^\/api\/ai\/chat$/, async (_req, _res, _m, b) => {
      if (!aiAvailable()) throw new HttpError(503, "the assistant is off: no GEMINI_API_KEY");
      const message = String(b.message ?? "").slice(0, 4000);
      if (!message.trim()) throw new HttpError(400, "say something");
      const history = Array.isArray(b.history) ? (b.history as { role: string; text: string }[]).slice(-8) : [];
      try {
        const answer = await chat(message, history, b.context ?? {});
        // The browser is told which of these it may run without asking. Deciding
        // that here, not there, keeps the rule in one place.
        return { ...answer, actions: answer.actions.map((a) => ({ ...a, confirm: !READ_ONLY.has(a.type) })) };
      } catch (e) {
        if (e instanceof AiError) throw new HttpError(502, e.message);
        throw e;
      }
    }],
    ["GET", /^\/api\/photos$/, (req) => {
      const u = new URL(req.url, "http://x");
      return photos(db, {
        status: u.searchParams.get("status") ?? undefined,
        limit: Number(u.searchParams.get("limit") ?? 200),
        offset: Number(u.searchParams.get("offset") ?? 0),
      });
    }],
    ["GET", /^\/api\/files\/(\d+)$/, (_req, _res, m) => fileDetail(db, Number(m[1])) ?? (() => { throw new HttpError(404, "no such file"); })()],
    ["GET", /^\/api\/files\/(\d+)\/thumb$/, async (req, res, m) => {
      const want = Number(new URL(req.url, "http://x").searchParams.get("s") ?? 256);
      await sendThumb(db, thumbs, req, res, Number(m[1]), Number.isFinite(want) ? want : 256);
      return undefined;
    }],
    ["GET", /^\/api\/files\/(\d+)\/content$/, (req, res, m) => {
      streamFile(db, req, res, Number(m[1]), new URL(req.url, "http://x").searchParams.has("download"));
      return undefined;
    }],
    ["GET", /^\/api\/roots$/, () => db.all("SELECT * FROM roots ORDER BY id")],
    ["POST", /^\/api\/roots$/, (_req, _res, _m, b) => {
      writable();
      const id = db.durable(() => addRoot(db, String(b.path ?? ""), String(b.role ?? "source")));
      intent?.changed();
      engine.reloadRoots();
      engine.requestScan(id);
      return { id };
    }],
    ["PATCH", /^\/api\/roots\/(\d+)$/, (_req, _res, m, b) => {
      writable();
      const id = Number(m[1]);
      if (b.role != null && !["source", "library", "backup"].includes(String(b.role))) throw new HttpError(400, "bad role");
      // One transaction: a role that changed with its files not re-planned would be a half-applied decision.
      db.durable(() => {
        if (b.role != null) {
          db.run("UPDATE roots SET role = ? WHERE id = ?", String(b.role), id);
          db.run(`UPDATE files SET state = ${STATE.IDENT} WHERE root = ? AND state = ${STATE.DONE}`, id); // representatives may change
        }
        if (b.enabled != null) db.run("UPDATE roots SET enabled = ? WHERE id = ?", b.enabled ? 1 : 0, id);
      });
      intent?.changed();
      engine.reloadRoots();
      engine.wake();
      return { ok: true };
    }],
    ["DELETE", /^\/api\/roots\/(\d+)$/, (_req, _res, m) => {
      writable();
      db.durable(() => removeRoot(db, Number(m[1])));
      intent?.changed();
      engine.reloadRoots();
      return { ok: true };
    }],
    ["POST", /^\/api\/scan$/, (_req, _res, _m, b) => { engine.requestScan(b.root != null ? Number(b.root) : undefined); return { ok: true }; }],
    // "Try again": failures are otherwise kept until the file changes (content) or
    // their backoff runs out (access). `ids` = these files; none = everything that failed.
    ["POST", /^\/api\/retry$/, (_req, _res, _m, b) => {
      writable();
      if (b.ids == null) return engine.retry();
      const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isInteger) : [];
      if (!ids.length) throw new HttpError(400, "no files given");
      if (ids.length > 5000) throw new HttpError(413, "too many files in one retry");
      return engine.retry(ids);
    }],
    ["GET", /^\/api\/browse$/, (req) => browse(new URL(req.url, "http://x").searchParams.get("path")), { local: true }],
  ];

  function login(req: Req, res: Res) {
    const token = auth.createSession(db, req.remote);
    res.setHeader("set-cookie", `${COOKIE}=${token}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Strict${req.https ? "; Secure" : ""}`);
    return { ok: true };
  }

  const server = http.createServer(async (rawReq, res) => {
    const req = rawReq as Req;
    req.remote = typeof req.headers["tailscale-user-login"] === "string" || typeof req.headers["x-forwarded-for"] === "string";
    req.https = req.headers["x-forwarded-proto"] === "https";
    try {
      if (!hostAllowed(req.headers.host)) throw new HttpError(421, "unrecognized host");
      const pathname = req.url.split("?")[0];
      if (req.method === "GET" && STATIC[pathname]) return serveStatic(res, STATIC[pathname]);
      if (req.method !== "GET" && req.method !== "HEAD") {
        const origin = req.headers.origin;
        if (!origin || new URL(origin).host !== req.headers.host) throw new HttpError(403, "cross-origin request refused");
      }
      const method = req.method === "HEAD" ? "GET" : req.method;
      for (const [verb, re, handler, flags] of routes) {
        if (verb !== method) continue;
        const m = re.exec(pathname);
        if (!m) continue;
        if (flags?.local && req.remote) throw new HttpError(403, "only available on the Atlas machine itself");
        if (!flags?.public && !auth.checkSession(db, cookie(req, COOKIE))) throw new HttpError(401, "sign in required");
        const body = await readBody(req);
        const out = await handler(req, res, m, body);
        if (out !== undefined && !res.headersSent) json(res, 200, out);
        return;
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const err = e as HttpError;
      const status = err instanceof HttpError ? err.status : e instanceof RootError ? 400 : 500;
      if (status === 500) log.error("request failed", { url: req.url, error: (e as Error).stack });
      if (!res.headersSent) json(res, status, { error: status === 500 ? "internal error" : err.message });
      else res.destroy();
    }
  });
  server.requestTimeout = 0; // long downloads and video streams
  server.headersTimeout = 30_000;
  server.on("error", (e: NodeJS.ErrnoException) => {
    // Two engines on one machine would fight over the same database and files.
    if (e.code === "EADDRINUSE") log.error("port already in use: another Atlas engine is probably running; exiting", { port: config.port });
    else log.error("http server failed", { error: e.message });
    process.exit(1);
  });
  server.listen(config.port, config.bindHost, () => log.info("http listening", { url: `http://${config.bindHost}:${config.port}` }));
  return server;
}
