// Express app assembly. Kept free of listen()/process concerns so it can be
// imported directly by tests. Routes are resource-organized per
// docs/08-api-contracts.md; controllers stay thin, business logic lives in
// src/services/, per spec §24.
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const pgQueue = require("./queues/pgQueue");
const fileRecovery = require("./services/fileRecovery");
const db = require("./config/database");
const env = require("./config/env");
const { authLimiter, apiLimiter } = require("./middleware/rateLimiters");

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const roleRoutes = require("./routes/roleRoutes");
const storageLocationRoutes = require("./routes/storageLocationRoutes");
const fileRoutes = require("./routes/fileRoutes");
const documentRoutes = require("./routes/documentRoutes");
const documentTypeRoutes = require("./routes/documentTypeRoutes");
const subjectRoutes = require("./routes/subjectRoutes");
const duplicateGroupRoutes = require("./routes/duplicateGroupRoutes");
const renameProposalRoutes = require("./routes/renameProposalRoutes");
const processingJobRoutes = require("./routes/processingJobRoutes");
const triageRoutes = require("./routes/triageRoutes");
const photoRoutes = require("./routes/photoRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const auditLogRoutes = require("./routes/auditLogRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const aiChatRoutes = require("./routes/aiChatRoutes");
const emailAccountRoutes = require("./routes/emailAccountRoutes");
const inboxRoutes = require("./routes/inboxRoutes");
const agentRoutes = require("./routes/agentRoutes");

const app = express();

/**
 * SECURITY HEADERS, MINUS ONE DIRECTIVE THAT BREAKS PLAIN-HTTP DEPLOYMENTS.
 *
 * helmet's default CSP includes `upgrade-insecure-requests`, which tells the
 * browser to rewrite every http:// subresource request to https://. Browsers
 * treat localhost and 127.0.0.1 as trustworthy origins and EXEMPT them, so
 * this is invisible during development.
 *
 * It is not invisible on a LAN address. Opening the app from a second machine
 * at http://192.168.1.101:5000 got every asset request upgraded to https on a
 * server that does not speak TLS, so the JavaScript never loaded and the page
 * rendered blank -- with the correct title, since the HTML itself had already
 * arrived. Nothing in the console, nothing in the server log: the requests
 * failed before they were made.
 *
 * So the directive is emitted only when THAT REQUEST really arrived over TLS.
 *
 * WHY PER-REQUEST AND NOT A FLAG
 *
 * This started as a single SERVE_OVER_HTTPS boolean, which is wrong as soon as
 * the app is reachable two ways at once -- which is exactly what running behind
 * `tailscale serve` produces:
 *
 *     https://atlas.<tailnet>.ts.net    TLS, needs the directive
 *     http://192.168.1.101:5000         plain, blank page if it gets it
 *     http://localhost:5000             plain, but exempt as a trusted origin
 *
 * With one flag you have to pick which of those breaks. Setting it for the
 * tunnel silently re-breaks the LAN address, reproducing the original bug --
 * blank page, right title, nothing in any log -- on the fallback path you reach
 * for precisely when the tunnel is down. Deciding per request means every
 * address is correct simultaneously and there is no setting to get wrong.
 *
 * X-Forwarded-Proto is read directly rather than via Express's `trust proxy`,
 * deliberately: enabling that globally would also make express-rate-limit key
 * on X-Forwarded-For, i.e. let any caller reset their own rate limit by
 * inventing a header. The blast radius of spoofing THIS header is only that the
 * spoofer's own browser upgrades its own subresource requests, which is a way
 * to inconvenience yourself and nobody else.
 *
 * SERVE_OVER_HTTPS=true remains as an override for a TLS terminator that does
 * not set the header.
 */
const FORCE_HTTPS_HEADERS = process.env.SERVE_OVER_HTTPS === "true";

const requestIsOverHttps = (req) =>
  FORCE_HTTPS_HEADERS ||
  req.secure ||
  String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";

const helmetOptions = (overHttps) => ({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // blob: is REQUIRED for any image in this app to render.
        //
        // Previews are fetched through the API client so the JWT can be
        // attached (a bare <img src="/api/..."> cannot carry an Authorization
        // header), and the response is turned into an object URL. Those are
        // blob: URLs, which helmet's default `img-src 'self' data:` does not
        // permit -- so every photo silently failed to decode: the fetch
        // succeeded, the <img> was created, and the browser refused to paint
        // it. Broken tiles with no error anywhere except the CSP report.
        imgSrc: ["'self'", "data:", "blob:"],
        // Same reasoning for anything opened in a frame (PDF preview) and for
        // media, both of which go through the same authenticated-fetch route.
        mediaSrc: ["'self'", "blob:"],
        frameSrc: ["'self'", "blob:"],
        ...(overHttps ? {} : { upgradeInsecureRequests: null }),
      },
    },
});

// Both variants are built once, at startup, rather than per request: helmet
// compiles its directives on construction, and doing that on every request
// would put it in the path of every preview byte this app serves.
const helmetOverHttps = helmet(helmetOptions(true));
const helmetOverHttp = helmet(helmetOptions(false));

app.use((req, res, next) => (requestIsOverHttps(req) ? helmetOverHttps : helmetOverHttp)(req, res, next));

// CORS was `cors()` with no options, i.e. Access-Control-Allow-Origin: * --
// every website on the internet allowed to call this API from a visitor's
// browser. That is a strange thing to hand out on a machine that indexes
// someone's private documents, and it buys nothing here: in production the
// UI is served from this very origin (see FRONTEND_DIST below), and in
// development Vite proxies /api to us, so the browser considers both
// same-origin and never sends a cross-origin request at all.
//
// The allowlist therefore exists only for the case of running the Vite dev
// server against a backend on a different host/port without the proxy.
// Requests with no Origin header (same-origin navigations, curl, the
// desktop agent) are passed through -- Origin is a browser construct and
// its absence is not something to reject on.
const allowedOrigins = new Set(
  [
    env.frontendUrl,
    `http://localhost:${env.port}`,
    `http://127.0.0.1:${env.port}`,
  ].filter(Boolean)
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(null, false);
    },
  })
);

// Explicit limit rather than body-parser's silent 100kb default, so the
// ceiling is a decision on the record. The largest legitimate body here is an
// assistant chat turn carrying page context (bounded in aiChatController);
// nothing in this API uploads bytes.
app.use(express.json({ limit: "1mb" }));

// HEALTH, INCLUDING THE QUEUE.
//
// This used to report `status: "ok"` unconditionally -- even with the database
// down, because `status` was a literal and only `database` reflected reality.
// It also said nothing at all about the job queue, which is how a two-day
// outage went unnoticed: Redis had stopped, the pipeline was dead, and this
// endpoint answered "ok" throughout.
//
// It now reports what is actually true, and `status` is derived rather than
// asserted. The HTTP code deliberately stays 200 even when degraded: this is a
// liveness endpoint, scripts/restart-atlas.bat polls it with `curl -f` to know
// the API is up, and failing it while the worker is still starting would turn
// a normal restart into a reported failure. Degradation belongs in the body.
app.get("/api/health", async (req, res) => {
  let dbConnected = false;
  try {
    dbConnected = await db.healthCheck();
  } catch {
    dbConnected = false;
  }

  let queue = null;
  let files = null;
  const warnings = [];
  if (dbConnected) {
    try {
      queue = await pgQueue.queueHealth();
      warnings.push(...queue.warnings);
    } catch (err) {
      warnings.push(`Could not read queue health: ${err.message}`);
    }

    // THE LIBRARY'S OWN HEALTH, NOT JUST THE QUEUE'S.
    //
    // A queue can be empty, a worker can be up, and the pipeline can still be
    // failing its actual job. That is not hypothetical: 5,730 files sat in
    // `failed_retryable` for thirteen hours while this endpoint answered
    // {"status":"ok"} with zero queued jobs and one live worker -- every
    // signal it had was about machinery, and none about whether the machinery
    // was achieving anything.
    //
    // Files waiting on recovery are reported as a NUMBER always, and escalate
    // to a warning only when they are not moving. A backlog the sweep is
    // actively draining is normal and should not cry wolf; a backlog older
    // than several sweep intervals means recovery itself is stuck, and that is
    // the thing nobody could see last time.
    try {
      files = await fileRecovery.strandedSummary();
      if (files.retryable > 0 && files.oldestRetryableSeconds > 900) {
        warnings.push(
          `${files.retryable} file(s) are waiting on stage recovery, the oldest for ` +
            `${Math.round(files.oldestRetryableSeconds / 60)} minutes.`
        );
      }
    } catch (err) {
      warnings.push(`Could not read file recovery health: ${err.message}`);
    }
  } else {
    warnings.push("Database unavailable; the queue cannot be reached either.");
  }

  res.json({
    status: dbConnected && warnings.length === 0 ? "ok" : "degraded",
    message: "Document Management API is running",
    database: dbConnected ? "connected" : "unavailable",
    queue: queue ? { workers: queue.workers, queued: queue.queued, paused: queue.paused,
                     oldestQueuedSeconds: queue.oldestQueuedSeconds } : null,
    // `awaitingRecovery` is files a stage failed on that the sweep will
    // re-run; `failedTerminal` is files it has genuinely given up on and a
    // person needs to look at. Separating them matters: the first number
    // should trend to zero on its own, the second should not.
    files: files ? { awaitingRecovery: files.retryable, failedTerminal: files.terminal,
                     oldestAwaitingSeconds: files.oldestRetryableSeconds } : null,
    warnings,
  });
});

app.use("/api/auth", authLimiter, authRoutes);

app.use("/api/users", apiLimiter, userRoutes);
app.use("/api/roles", apiLimiter, roleRoutes);
app.use("/api/storage-locations", apiLimiter, storageLocationRoutes);
app.use("/api/files", apiLimiter, fileRoutes);
app.use("/api/documents", apiLimiter, documentRoutes);
app.use("/api/document-types", apiLimiter, documentTypeRoutes);
app.use("/api/subjects", apiLimiter, subjectRoutes);
app.use("/api/duplicate-groups", apiLimiter, duplicateGroupRoutes);
app.use("/api/rename-proposals", apiLimiter, renameProposalRoutes);
app.use("/api/processing-jobs", apiLimiter, processingJobRoutes);
app.use("/api/triage", apiLimiter, triageRoutes);
app.use("/api/photos", apiLimiter, photoRoutes);
app.use("/api/devices", apiLimiter, deviceRoutes);
app.use("/api/audit-logs", apiLimiter, auditLogRoutes);
app.use("/api/dashboard", apiLimiter, dashboardRoutes);
app.use("/api/ai", apiLimiter, aiChatRoutes);
app.use("/api/email-accounts", apiLimiter, emailAccountRoutes);
app.use("/api/inbox", apiLimiter, inboxRoutes);
// Agents poll frequently and authenticate with their own token kind, so
// they get the general API limiter rather than the stricter auth limiter --
// a polling agent is not a credential-guessing client.
app.use("/api/agents", apiLimiter, agentRoutes);

// --- serving the built UI ------------------------------------------------
//
// In development the frontend runs on Vite's own server (port 5173) and
// proxies /api here. That is two processes and two ports, which is fine for
// a developer and wrong for the person actually using this: they should
// open one address and get the app.
//
// So if frontend/dist exists -- i.e. someone has run `npm run build` -- it
// is served from here. One process, one URL, no terminal.
const FRONTEND_DIST = path.resolve(__dirname, "..", "..", "frontend", "dist");
const hasBuiltFrontend = fs.existsSync(path.join(FRONTEND_DIST, "index.html"));

if (hasBuiltFrontend) {
  app.use(
    express.static(FRONTEND_DIST, {
      // index.html must NEVER be cached; the hashed assets it points at
      // should be cached forever. Getting this backwards is what produced a
      // permanently blank page on a second machine:
      //
      //   1. the laptop loads the app and caches index.html
      //   2. the frontend is rebuilt here, so the asset hashes change
      //   3. the laptop re-uses its cached index.html and asks for the OLD
      //      hash, which no longer exists
      //   4. the SPA catch-all answers that miss with index.html
      //   5. the browser is handed HTML where it expected JavaScript, refuses
      //      to execute it, and renders nothing -- with the correct title,
      //      because that came from the cached HTML
      //
      // The page looked broken in a way no error message explained. Vite
      // fingerprints every asset filename, so `immutable` is safe for them
      // and correct: the content behind a given hash can never change.
      setHeaders(res, filePath) {
        const name = path.basename(filePath);

        if (name === "index.html") {
          res.setHeader("Cache-Control", "no-cache, must-revalidate");
        } else if (name === "sw.js" || name === "manifest.webmanifest") {
          // The service worker and the manifest get the SAME treatment as
          // index.html, and for a sharper version of the same reason.
          //
          // A cached index.html produces a blank page until someone hard
          // refreshes. A cached sw.js produces a blank page that a hard
          // refresh does NOT fix, because the stale worker is what answers
          // the reload -- the client would be stuck until someone talks them
          // through unregistering it from a browser console. Browsers
          // already bypass the HTTP cache when checking for a worker update,
          // but that is a browser behaviour to benefit from, not one to
          // depend on. Being explicit costs one header.
          res.setHeader("Cache-Control", "no-cache, must-revalidate");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    })
  );
}

// 404 for unmatched API routes. Kept scoped to /api so a client-side route
// like /subjects is NOT answered with JSON -- it has to fall through to the
// SPA below, or deep links and refreshes break.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

if (hasBuiltFrontend) {
  // Everything else is a React Router path: hand back index.html and let the
  // client router resolve it.
  //
  // EXCEPT anything that is asking for a FILE. A request for
  // /assets/index-OLDHASH.js is a stale build reference, not a client-side
  // route, and answering it with index.html is actively harmful: the browser
  // receives HTML with a JavaScript content type, refuses to run it, and the
  // app renders as a blank page whose title is right because it came from the
  // cached HTML. A 404 is both true and diagnosable -- it shows up plainly in
  // the network tab instead of as an inexplicable white screen.
  //
  // "Looks like a file" is deliberately narrow: a dot in the LAST path
  // segment. React Router paths in this app are word segments and uuids
  // (/files/2f1c-...), none of which contain dots, while every real asset
  // does.
  const looksLikeFile = (urlPath) => {
    const last = urlPath.split("/").pop() || "";
    return last.includes(".");
  };

  app.use((req, res, next) => {
    if (req.method !== "GET") return next();

    if (req.path.startsWith("/assets/") || looksLikeFile(req.path)) {
      return res.status(404).type("text/plain").send(
        `Not found: ${req.path}\n\n` +
        "If this is /assets/index-<hash>.js, your browser is using a cached index.html " +
        "from an older build and asking for a file that no longer exists. A hard refresh " +
        "(Ctrl+Shift+R) fixes it; the server now sends no-cache on index.html so it should " +
        "not recur."
      );
    }

    res.sendFile(path.join(FRONTEND_DIST, "index.html"));
  });
}

// Nothing matched and there is no built UI to fall back on.
app.use((req, res) => {
  res.status(404).json({
    error: hasBuiltFrontend
      ? "Not found"
      : "Not found. The UI has not been built -- run `npm run build` in frontend/, or use the Vite dev server.",
  });
});

// Centralized error handler (kept last).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);

  // Postgres 22P02 = invalid text representation. Every id in this schema is
  // a uuid, so any request carrying a malformed one (a typo, a stale link,
  // or a static path segment that fell through to a "/:id" route) reaches
  // the driver and blows up there. Left alone that surfaces as a bare 500,
  // which reads as "the server is broken" rather than "that id is not
  // valid". Handled here rather than in each controller so it holds for
  // every resource at once.
  if (err.code === "22P02") {
    return res.status(400).json({ error: "Malformed id." });
  }

  res.status(err.statusCode || 500).json({
    error: err.publicMessage || "Internal server error",
  });
});

module.exports = app;
