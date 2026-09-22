// Atlas engine entrypoint. Run directly (`npm start`) or supervised by
// bin/AtlasService.exe, which sets ATLAS_HOSTED=1 and speaks a line protocol:
//   engine -> host (stdout): @@alive every 10s, @@awake 1|0 when busy changes
//   host -> engine (stdin):  shutdown | resume
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { Db } from "./db/db.ts";
import { Engine } from "./pipeline/engine.ts";
import { startServer } from "./server/http.ts";
import { ensureSetupCode } from "./server/auth.ts";
import { S } from "./pipeline/states.ts";
import { IntentExport } from "./intent.ts";

fs.mkdirSync(config.home, { recursive: true });
const t0 = performance.now();
const db = new Db(path.join(config.home, "atlas.db"));
const pending = db.get<{ n: number }>(`SELECT count(*) AS n FROM files WHERE state < ${S.DONE}`)!.n;
const engine = new Engine(db);
// What a person decided, exported beside the database (src/intent.ts): now, after
// every scan (a moved file carries its choices to its new path), and after every change.
const intent = new IntentExport(db);
intent.write();
engine.onScanned = () => intent.changed();
const control = (line: string) => { if (config.hosted) process.stdout.write(line + "\n"); };
engine.onBusyChange = (busy) => { control(`@@awake ${busy ? 1 : 0}`); log.info(busy ? "busy" : "idle"); };
engine.start();
const server = startServer(db, engine, intent);
const setupFile = ensureSetupCode(db);
log.info("atlas started", {
  home: config.home, port: config.port, hosted: config.hosted, resumed: pending, startupMs: Math.round(performance.now() - t0),
  ...(setupFile ? { setup: `first run: the setup code is in ${setupFile}` } : {}),
});

engine.requestScan();
const rescan = setInterval(() => engine.requestScan(), config.rescanMinutes * 60_000);

// Watchdog signals. @@alive only goes out if the event loop is actually turning,
// so a hung engine stops sending it and the host restarts the process.
const alive = setInterval(() => control("@@alive"), 10_000);
let lagCheck = performance.now();
const lag = setInterval(() => {
  const now = performance.now();
  const late = now - lagCheck - 1000;
  if (late > 2000) log.warn("event loop stalled", { ms: Math.round(late) });
  lagCheck = now;
}, 1000);
control("@@alive");

let stopping = false;
async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { reason });
  clearInterval(rescan);
  clearInterval(alive);
  clearInterval(lag);
  server.close();
  server.closeAllConnections();
  try { await engine.stop(); intent.flush(); } finally { db.close(); }
  control("@@awake 0");
  process.exit(0);
}

if (config.hosted) {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const cmd = line.trim();
    if (cmd === "shutdown") void shutdown("service stop");
    else if (cmd === "resume") { log.info("resumed from sleep; rescanning"); engine.requestScan(); }
  });
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (e) => { log.error("uncaught exception", { error: e.stack }); process.exit(1); });
process.on("unhandledRejection", (e) => { log.error("unhandled rejection", { error: (e as Error)?.stack ?? String(e) }); process.exit(1); });
