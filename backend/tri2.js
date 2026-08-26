process.env.PG_STATEMENT_TIMEOUT_MS = "300000";
require("dotenv").config({ quiet: true });
process.env.PG_STATEMENT_TIMEOUT_MS = "300000";
const t0 = Date.now();
(async () => {
  const db = require("./src/config/database");
  const { rows: u } = await db.query("select id from users limit 1");
  const svc = require("./src/services/triageService");
  const s = await svc.summary(u[0].id);
  console.log(`triage summary completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(s).slice(0, 300));
  process.exit(0);
})().catch((e) => { console.error(`FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, e.message); process.exit(1); });
