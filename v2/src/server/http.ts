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
import { listFolder, fileDetail, counts } from "../library.ts";
import { search } from "../search/search.ts";
import { addRoot, removeRoot, resolveFile, RootError } from "../roots.ts";
import { kindFromExt, extOf } from "../analyze/sniff.ts";

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

const APP_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' blob: data:; media-src 'self'; frame-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const STATIC: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/app.css": "app.css", "/icon.svg": "icon.svg", "/manifest.webmanifest": "manifest.webmanifest" };
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

export function startServer(db: Db, engine: Engine): http.Server {
  let statesCache: { at: number; value: ReturnType<typeof counts> } | null = null;
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
      return listFolder(db, u.searchParams.get("path") ?? "");
    }],
    ["GET", /^\/api\/search$/, (req) => {
      const u = new URL(req.url, "http://x");
      return search(db, u.searchParams.get("q") ?? "", { kind: u.searchParams.get("kind") ?? undefined, limit: Number(u.searchParams.get("limit") ?? 50) });
    }],
    ["GET", /^\/api\/files\/(\d+)$/, (_req, _res, m) => fileDetail(db, Number(m[1])) ?? (() => { throw new HttpError(404, "no such file"); })()],
    ["GET", /^\/api\/files\/(\d+)\/content$/, (req, res, m) => {
      streamFile(db, req, res, Number(m[1]), new URL(req.url, "http://x").searchParams.has("download"));
      return undefined;
    }],
    ["GET", /^\/api\/roots$/, () => db.all("SELECT * FROM roots ORDER BY id")],
    ["POST", /^\/api\/roots$/, (_req, _res, _m, b) => {
      const id = addRoot(db, String(b.path ?? ""), String(b.role ?? "source"));
      engine.reloadRoots();
      engine.requestScan(id);
      return { id };
    }],
    ["PATCH", /^\/api\/roots\/(\d+)$/, (_req, _res, m, b) => {
      const id = Number(m[1]);
      if (b.role != null) {
        if (!["source", "library", "backup"].includes(String(b.role))) throw new HttpError(400, "bad role");
        db.run("UPDATE roots SET role = ? WHERE id = ?", String(b.role), id);
        db.run("UPDATE files SET state = 20 WHERE root = ? AND state = 50", id); // representatives may change
      }
      if (b.enabled != null) db.run("UPDATE roots SET enabled = ? WHERE id = ?", b.enabled ? 1 : 0, id);
      engine.reloadRoots();
      return { ok: true };
    }],
    ["DELETE", /^\/api\/roots\/(\d+)$/, (_req, _res, m) => { removeRoot(db, Number(m[1])); engine.reloadRoots(); return { ok: true }; }],
    ["POST", /^\/api\/scan$/, (_req, _res, _m, b) => { engine.requestScan(b.root != null ? Number(b.root) : undefined); return { ok: true }; }],
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
