import "./_env.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Db } from "../src/db/db.ts";
import { Engine } from "../src/pipeline/engine.ts";
import { startServer } from "../src/server/http.ts";
import { config } from "../src/config.ts";
import * as auth from "../src/server/auth.ts";

(config as { port: number }).port = 7899;
const tree = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-http-"));
fs.writeFileSync(path.join(tree, "evil.html"), "<script>fetch('/api/roots')</script>");
fs.writeFileSync(path.join(tree, "movie.mp4"), Buffer.alloc(1000, 7));
fs.mkdirSync(path.join(tree, "sub"));
let db: Db, engine: Engine, server: http.Server, cookie = "";

function req(method: string, p: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const data = opts.body ? JSON.stringify(opts.body) : undefined;
    const r = http.request({ host: "127.0.0.1", port: 7899, method, path: p, headers: { host: "127.0.0.1:7899", ...(cookie ? { cookie } : {}), ...(data ? { "content-type": "application/json" } : {}), ...opts.headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const local = { origin: "http://127.0.0.1:7899" };

before(async () => {
  db = new Db(path.join(process.env.ATLAS_HOME!, "http.db"));
  db.run("INSERT INTO roots(path, created) VALUES (?, ?)", tree, Date.now());
  db.run("INSERT INTO files(root, path, size, mtime, seen, state) VALUES (1, 'evil.html', 38, 0, 1, 50), (1, 'movie.mp4', 1000, 0, 1, 50)");
  engine = new Engine(db);
  engine.pool = { busy: 0 } as Engine["pool"];
  server = startServer(db, engine);
  await new Promise((r) => server.once("listening", r));
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(tree, { recursive: true, force: true });
});

test("unknown Host headers are refused (DNS rebinding)", async () => {
  assert.equal((await req("GET", "/api/health", { headers: { host: "evil.example.com" } })).status, 421);
  assert.equal((await req("GET", "/api/health", { headers: { host: "atlas.tail1234.ts.net" } })).status, 200);
});

test("everything but health/session/login requires a session", async () => {
  assert.equal((await req("GET", "/api/status")).status, 401);
  assert.equal((await req("GET", "/api/files/1/content")).status, 401);
});

test("setup: code required, local only; then login works and state changes need a same-origin Origin", async () => {
  const code = /code: (\d+)/.exec(fs.readFileSync(auth.ensureSetupCode(db)!, "utf8"))![1];
  const remote = await req("POST", "/api/setup", { headers: { ...local, "tailscale-user-login": "x@y" }, body: { code, password: "correct horse battery" } });
  assert.equal(remote.status, 403, "setup is refused through the tunnel");
  assert.equal((await req("POST", "/api/setup", { headers: local, body: { code: "00000000", password: "correct horse battery" } })).status, 403);
  const ok = await req("POST", "/api/setup", { headers: local, body: { code, password: "correct horse battery" } });
  assert.equal(ok.status, 200);
  cookie = ok.headers["set-cookie"]![0].split(";")[0];
  assert.match(ok.headers["set-cookie"]![0], /HttpOnly; SameSite=Strict/);
  assert.equal((await req("POST", "/api/scan", { body: {} })).status, 403, "no Origin header: refused");
  assert.equal((await req("POST", "/api/scan", { headers: { origin: "https://evil.example.com" }, body: {} })).status, 403);
  assert.equal((await req("POST", "/api/scan", { headers: local, body: {} })).status, 200);
});

test("a library HTML file is never rendered as a page on Atlas's origin", async () => {
  const r = await req("GET", "/api/files/1/content");
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /^text\/plain/);
  assert.equal(r.headers["content-security-policy"], "sandbox");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
});

test("range requests stream partial content (video seeking)", async () => {
  const r = await req("GET", "/api/files/2/content", { headers: { range: "bytes=100-199" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers["content-range"], "bytes 100-199/1000");
  assert.equal(r.body.length, 100);
  assert.equal((await req("GET", "/api/files/2/content", { headers: { range: "bytes=5000-6000" } })).status, 416);
});

test("host folder browsing is local only", async () => {
  assert.equal((await req("GET", "/api/browse", { headers: { "tailscale-user-login": "x@y" } })).status, 403);
  assert.equal((await req("GET", "/api/browse")).status, 200);
});

test("roots cannot overlap, be system folders, or be relative", async () => {
  const add = (p: string) => req("POST", "/api/roots", { headers: local, body: { path: p } });
  assert.equal((await add(path.join(tree, "sub"))).status, 400);
  assert.equal((await add(process.env.SystemRoot ?? "C:\\Windows")).status, 400);
  assert.equal((await add("relative\\path")).status, 400);
});
