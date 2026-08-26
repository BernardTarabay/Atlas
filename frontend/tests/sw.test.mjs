// The service worker's routing rules, exercised.
//
// WHY THIS EXISTS
//
// A service worker is the one piece of this frontend that cannot be checked by
// looking at the app: it sits *between* the app and the network, it only runs
// in a production build, and when it is wrong the symptom is stale data or a
// blank page rather than an error. DevTools can show you what it did once; it
// cannot tell you what it will do to a request shape you did not think to try.
//
// So sw.js is loaded into a fake worker global here and asked directly. The
// rule that matters most -- that /api is never intercepted -- is the first
// test, because a regression there would silently serve someone yesterday's
// document library, and no observation from inside the app would distinguish
// that from the server being wrong.
//
//   npm test        (from frontend/)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SW_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "sw.js");
const ORIGIN = "http://localhost:5000";

// In a worker, a relative URL resolves against the worker's scope, and Node's
// Request has no such base -- `new Request("/")` simply throws. So the sandbox
// gets a Request that resolves against the origin, exactly as the browser
// would. Without this the harness rejects code the browser accepts.
class ScopedRequest extends Request {
  constructor(input, init) {
    super(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
  }
}

/**
 * Minimal stand-ins for the bits of CacheStorage that sw.js actually uses.
 *
 * `network` is INJECTED rather than read off globalThis. `cache.add()` fetches,
 * and reading `globalThis.fetch` here got Node's real one -- so three of these
 * tests were quietly making live requests to http://localhost:5000 and passed
 * only while a server happened to be listening on it. A unit test that depends
 * on a running server is not a unit test; it is a test that fails for reasons
 * having nothing to do with the code under test.
 */
function makeCaches(network) {
  const stores = new Map();
  // CacheStorage keys on the full request URL, so a string key and a Request
  // for the same resource are the same entry. Keying on the raw string instead
  // would make `cache.add(new Request("/"))` and `cache.match("/")` miss each
  // other here while matching perfectly in a browser -- a harness bug that
  // reads exactly like a worker bug.
  const keyOf = (request) => new URL(typeof request === "string" ? request : request.url, ORIGIN).href;

  const openCache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      async match(request) {
        return entries.get(keyOf(request));
      },
      async put(request, response) {
        entries.set(keyOf(request), response);
      },
      async add(request) {
        const response = await network(request);
        entries.set(keyOf(request), response);
      },
    };
  };

  return {
    stores,
    api: {
      open: async (name) => openCache(name),
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
      match: async (request) => {
        for (const entries of stores.values()) {
          const hit = entries.get(keyOf(request));
          if (hit) return hit;
        }
        return undefined;
      },
    },
  };
}

/**
 * Loads sw.js into a sandbox and returns handles to poke at it.
 * @param {(request: Request) => Promise<Response>} network
 */
function loadWorker(network) {
  const listeners = new Map();
  const calls = { skipWaiting: 0, claim: 0, network: [] };

  const fetchImpl = async (request) => {
    calls.network.push(typeof request === "string" ? request : request.url);
    return network(request);
  };

  // The cache uses the SAME stub, so a cache.add() is counted and stubbed like
  // any other fetch rather than escaping to the real network.
  const caches = makeCaches(fetchImpl);

  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type, handler) => listeners.set(type, handler),
    skipWaiting: () => {
      calls.skipWaiting += 1;
    },
    clients: {
      claim: async () => {
        calls.claim += 1;
      },
    },
    registration: { unregister: async () => {} },
  };

  const sandbox = { self, caches: caches.api, fetch: fetchImpl, Response, Request: ScopedRequest, URL, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SW_PATH, "utf8"), sandbox, { filename: "sw.js" });

  /** Fires a fetch event and returns the Response, or null if not intercepted. */
  const dispatchFetch = async (url, init = {}) => {
    let responded = null;
    const request = new ScopedRequest(new URL(url, ORIGIN), { method: init.method || "GET" });
    // `mode` is read-only on a real Request, so it is layered on for the test.
    Object.defineProperty(request, "mode", { value: init.mode || "cors", configurable: true });

    listeners.get("fetch")({
      request,
      respondWith: (promise) => {
        responded = promise;
      },
    });
    return responded === null ? null : await responded;
  };

  const dispatchLifecycle = async (type) => {
    const waits = [];
    await listeners.get(type)({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
  };

  return { dispatchFetch, dispatchLifecycle, calls, caches };
}

const ok = (body, type = "text/plain") => new Response(body, { status: 200, headers: { "Content-Type": type } });

// A real same-origin fetch yields a response of type "basic", which is what
// sw.js checks before caching anything. Response cannot be constructed that
// way, so the property is layered on.
const basic = (body, type) => {
  const response = ok(body, type);
  Object.defineProperty(response, "type", { value: "basic", configurable: true });
  return response;
};

test("never intercepts /api - the rule that protects live, authenticated data", async () => {
  const worker = loadWorker(async () => basic("{}", "application/json"));

  assert.equal(await worker.dispatchFetch("/api/files"), null);
  assert.equal(await worker.dispatchFetch("/api/files/123/preview"), null);
  assert.equal(await worker.dispatchFetch("/api/dashboard"), null);
  // Nothing was fetched by the worker at all: the browser was left to do it.
  assert.deepEqual(worker.calls.network, []);
});

test("ignores non-GET requests", async () => {
  const worker = loadWorker(async () => basic("ok"));

  assert.equal(await worker.dispatchFetch("/anything", { method: "POST" }), null);
  assert.equal(await worker.dispatchFetch("/anything", { method: "DELETE" }), null);
});

test("ignores cross-origin requests (Google Fonts)", async () => {
  const worker = loadWorker(async () => basic("ok"));

  assert.equal(await worker.dispatchFetch("https://fonts.googleapis.com/css2?family=Inter"), null);
  assert.equal(await worker.dispatchFetch("https://fonts.gstatic.com/s/inter.woff2"), null);
});

test("navigations are network-first, so a rebuild is picked up immediately", async () => {
  let served = "BUILD-1";
  const worker = loadWorker(async () => basic(served, "text/html"));

  await worker.dispatchLifecycle("install");
  const first = await worker.dispatchFetch("/", { mode: "navigate" });
  assert.equal(await first.text(), "BUILD-1");

  served = "BUILD-2";
  const second = await worker.dispatchFetch("/", { mode: "navigate" });
  assert.equal(await second.text(), "BUILD-2", "a cached shell must never win over a reachable network");
});

test("a navigation offline falls back to the cached shell", async () => {
  let online = true;
  const worker = loadWorker(async () => {
    if (!online) throw new TypeError("Failed to fetch");
    return basic("<html>Atlas</html>", "text/html");
  });

  await worker.dispatchLifecycle("install");
  await worker.dispatchFetch("/", { mode: "navigate" });

  online = false;
  // A deep link, not the URL that was cached: every client-side route resolves
  // to the same shell, which is why the worker caches it under one key.
  const offline = await worker.dispatchFetch("/triage", { mode: "navigate" });
  assert.equal(offline.status, 200);
  assert.match(await offline.text(), /Atlas/);
});

test("with nothing cached, offline gives an explaining 503 rather than a browser error page", async () => {
  const worker = loadWorker(async () => {
    throw new TypeError("Failed to fetch");
  });

  const response = await worker.dispatchFetch("/", { mode: "navigate" });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /offline/i);
});

test("hashed assets are cache-first, and served without a second network trip", async () => {
  const worker = loadWorker(async () => basic("console.log(1)", "text/javascript"));

  const first = await worker.dispatchFetch("/assets/index-ABC123.js");
  assert.equal(await first.text(), "console.log(1)");
  assert.equal(worker.calls.network.length, 1);

  const second = await worker.dispatchFetch("/assets/index-ABC123.js");
  assert.equal(await second.text(), "console.log(1)");
  assert.equal(worker.calls.network.length, 1, "a fingerprinted asset must not be re-fetched");
});

test("install primes the shell and activates without waiting for tabs to close", async () => {
  const worker = loadWorker(async () => basic("<html></html>", "text/html"));

  await worker.dispatchLifecycle("install");
  assert.equal(worker.calls.skipWaiting, 1);
});

test("activate drops caches from previous versions and claims open pages", async () => {
  const worker = loadWorker(async () => basic("x"));
  worker.caches.stores.set("atlas-v0", new Map([["stale", ok("old")]]));
  worker.caches.stores.set("unrelated-cache", new Map());

  await worker.dispatchLifecycle("activate");

  const names = [...worker.caches.stores.keys()];
  assert.ok(!names.includes("atlas-v0"), "an older atlas cache must be deleted");
  assert.ok(names.includes("unrelated-cache"), "caches this worker does not own must be left alone");
  assert.equal(worker.calls.claim, 1);
});
