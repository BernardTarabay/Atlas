// The user's decisions, outside the database (src/intent.ts).
//
//   npm run intent -- export           write <home>/intent/latest.json now
//   npm run intent -- list             the export and its history, with counts
//   npm run intent -- import [file]    put roots and choices back (default: latest.json)
//   npm run intent -- import --exact [file]
//                                      make the database's choices EXACTLY the export's -
//                                      after restoring a backup older than the export
//
// import writes to the database, so Atlas must be stopped: it is the only writer
// by design. It re-adds missing roots, scans them (a directory listing, no file is
// read), and re-attaches every choice it can place with certainty. Run it again
// after Atlas has read the files if some choices were only findable by content.
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.ts";
import { Db } from "../src/db/db.ts";
import { IntentExport, importIntent, readIntent } from "../src/intent.ts";
import { scanRoot } from "../src/scan/scanner.ts";
import { engineRunning } from "./_engine.ts";

const args = process.argv.slice(2);
const exact = args.includes("--exact");
const [cmd, arg] = args.filter((a) => a !== "--exact");
const dbFile = path.join(config.home, "atlas.db");

function count(file: string) {
  const x = readIntent(file);
  return x ? `${x.roots.length} root(s), ${x.files.length} choice(s), written ${x.written}` : "unreadable";
}

if (cmd === "export") {
  const db = new Db(dbFile);
  const out = new IntentExport(db);
  const r = out.write();
  db.close();
  console.log(r === "empty" ? "The database has no roots: nothing to export (an existing export is left alone)." : `${r}: ${out.latest}`);
} else if (cmd === "list") {
  const dir = path.join(config.home, "intent");
  const latest = path.join(dir, "latest.json");
  console.log(fs.existsSync(latest) ? `latest   ${count(latest)}\n         ${latest}` : `no export yet in ${dir}`);
  const hist = path.join(dir, "history");
  if (fs.existsSync(hist)) {
    for (const n of fs.readdirSync(hist).sort().reverse()) console.log(`history  ${count(path.join(hist, n))}\n         ${path.join(hist, n)}`);
  }
} else if (cmd === "import") {
  let file = path.resolve(arg ?? path.join(config.home, "intent", "latest.json"));
  const x = readIntent(file);
  if (!x) { console.error(`Not an Atlas intent export: ${file}`); process.exit(1); }
  if (await engineRunning()) { console.error(`Atlas is running on port ${config.port}. Stop it first: import writes to its database.`); process.exit(1); }
  // latest.json is rewritten as soon as Atlas runs again - with only what this import
  // could place. Import from a copy that stays put, so a second run has everything.
  if (path.basename(file) === "latest.json") {
    const copy = path.join(path.dirname(file), `imported-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.copyFileSync(file, copy);
    file = copy;
    console.log(`importing from a copy: ${file}`);
  }
  const db = new Db(dbFile);
  try {
    const r = await importIntent(db, x, (id) => scanRoot(db, id), { exact });
    const f = r.files;
    console.log(`roots: ${r.roots.added.length} added, ${r.roots.present.length} already there${exact ? ` (${r.roots.updated.length} set to the export's role)` : ""}, ${r.roots.skipped.length} skipped`);
    for (const s of r.roots.skipped) console.log(`  skipped ${s.path}: ${s.reason}`);
    console.log(`choices: ${f.byPath} by path, ${f.byFileId} by file ID (moved), ${f.bySha} by content, ${f.already} already in place`
      + (exact ? `, ${f.cleared} removed (not in the export)` : ""));
    for (const c of f.conflicts) console.log(`  kept the database's own choice for ${c.entry} (${c.kept})`);
    for (const a of f.ambiguous) console.log(`  not placed, ambiguous: ${a}`);
    if (f.unmatched.length) {
      console.log(`  ${f.unmatched.length} not found yet:`);
      for (const u of f.unmatched.slice(0, 20)) console.log(`    ${u}`);
      console.log("  Files that moved to another drive are found by content, once Atlas has read them:");
      console.log(`  start Atlas, let it finish, stop it, then: npm run intent -- import ${exact ? "--exact " : ""}"${file}"`);
    }
  } finally {
    db.close();
  }
} else {
  console.log("usage: npm run intent -- export | list | import [--exact] [file]");
  process.exit(cmd ? 1 : 0);
}
