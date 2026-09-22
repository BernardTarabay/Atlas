// Shared by the maintenance scripts: is an Atlas engine answering on this machine?
// Scripts that write to the database refuse while it is: the engine is the only
// writer by design.
import http from "node:http";
import { config } from "../src/config.ts";

export function engineRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port: config.port, path: "/api/health", headers: { host: `127.0.0.1:${config.port}` }, timeout: 1500 },
      (res) => { res.resume(); resolve(true); });
    r.on("timeout", () => { r.destroy(); resolve(false); });
    r.on("error", () => resolve(false));
  });
}
