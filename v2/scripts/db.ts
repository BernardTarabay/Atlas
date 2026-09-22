// The database: check it, back it up, put a backup back (src/db/maintenance.ts).
//
//   npm run db -- check              full integrity check (Atlas may be running)
//   npm run db -- backup             a verified backup now (Atlas may be running)
//   npm run db -- list               backups, newest first
//   npm run db -- restore [file]     replace the database with a backup (newest by
//                                    default). Atlas must be stopped. The current
//                                    database is moved aside, never deleted.
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.ts";
import { checkDatabase, listBackups, makeBackup, restoreBackup } from "../src/db/maintenance.ts";
import { readIntent } from "../src/intent.ts";
import { engineRunning } from "./_engine.ts";

const [cmd, arg] = process.argv.slice(2);
const live = path.join(config.home, "atlas.db");
const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;
const when = (t: number) => new Date(t).toLocaleString();

if (cmd === "check") {
  if (!fs.existsSync(live)) { console.error(`No database at ${live}`); process.exit(1); }
  const r = await checkDatabase(live, true);
  console.log(r.ok ? `ok: ${live} passed the full integrity check (${r.ms} ms)` : `FAILED:\n  ${r.detail.join("\n  ")}`);
  process.exit(r.ok ? 0 : 2);
} else if (cmd === "backup") {
  const r = await makeBackup(live);
  if (r.ok) console.log(`backed up and verified: ${r.backup.file} (${mb(r.backup.bytes)}, ${r.ms} ms)${r.removed.length ? `; ${r.removed.length} old backup(s) rotated out` : ""}`);
  else console.error(`backup failed (${r.stage}):\n  ${r.detail.join("\n  ")}`);
  process.exit(r.ok ? 0 : 2);
} else if (cmd === "list") {
  const all = listBackups();
  if (!all.length) console.log(`no backups yet in ${config.backupDir}`);
  for (const b of all) console.log(`${when(b.at)}   ${mb(b.bytes).padStart(8)}   ${b.file}`);
} else if (cmd === "restore") {
  const backup = arg ? path.resolve(arg) : listBackups()[0]?.file;
  if (!backup || !fs.existsSync(backup)) { console.error(arg ? `No such file: ${arg}` : `No backups in ${config.backupDir}`); process.exit(1); }
  if (await engineRunning()) { console.error(`Atlas is running on port ${config.port}. Stop it first: restore replaces its database.`); process.exit(1); }
  const taken = listBackups().find((b) => b.file === backup)?.at ?? fs.statSync(backup).mtimeMs;
  // Decisions made after the backup live in the intent export. Keep a copy that stays put:
  // latest.json is rewritten - from the restored, older database - as soon as Atlas runs.
  const latest = path.join(config.home, "intent", "latest.json");
  const x = readIntent(latest);
  let keep: string | null = null;
  if (x && Date.parse(x.written) > taken) {
    keep = path.join(config.home, "intent", `before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.copyFileSync(latest, keep);
  }
  try {
    const r = await restoreBackup(backup);
    console.log(`restored ${backup}\n  (made ${when(taken)}, schema ${r.schema})`);
    if (r.replacedDir) console.log(`the database it replaced is kept in ${r.replacedDir}`);
    if (keep) {
      console.log(`\nYour decisions were last exported at ${when(Date.parse(x!.written))}, after this backup was made.`);
      console.log("To put back the folders and names chosen since, BEFORE starting Atlas:");
      console.log(`  npm run intent -- import --exact "${keep}"`);
    }
  } catch (e) {
    console.error(`restore refused: ${(e as Error).message}`);
    process.exit(2);
  }
} else {
  console.log("usage: npm run db -- check | backup | list | restore [file]");
  process.exit(cmd ? 1 : 0);
}
