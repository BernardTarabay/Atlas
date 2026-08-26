// Proves the organized shortcut mirror works end to end on this machine:
// real .lnk files, pointing at real originals that were never moved.
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const env = require("../src/config/env");
const { Pool } = require("pg");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const fileRepository = require("../src/repositories/fileRepository");
const mirrorService = require("../src/services/mirror/mirrorService");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

let source, mirror, locId, savedMirrorRoot;

async function cleanup() {
  try {
    if (locId) {
      await p.query("DELETE FROM files WHERE storage_location_id=$1", [locId]);
      await p.query("DELETE FROM filesystem_scans WHERE storage_location_id=$1", [locId]);
      await p.query("DELETE FROM storage_locations WHERE id=$1", [locId]);
    }
    for (const d of [source, mirror]) if (d) await fsp.rm(d, { recursive: true, force: true });
    console.log("\ncleaned up.");
  } catch (e) { console.log("cleanup warning:", e.message); }
  env.mirrorRoot = savedMirrorRoot;
  await p.end(); await closeAllQueues();
}

(async () => {
  source = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-mirror-src-"));
  mirror = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-mirror-out-"));
  savedMirrorRoot = env.mirrorRoot;
  env.mirrorRoot = mirror;

  // Messy original names, exactly like the real thing.
  const originals = {
    "scan0001.pdf": "quarterly finance report contents",
    "IMG_4471.docx": "conférence sur l'espérance — accented content",
    "untitled (1).xlsx": "spreadsheet contents",
  };
  for (const [name, body] of Object.entries(originals)) {
    await fsp.writeFile(path.join(source, name), body);
  }
  console.log("source folder (originals, messy names):", source);
  console.log("mirror root:", mirror);

  const admin = await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1");
  // The mirror is built per account. This script predates that and called
  // sync() bare, which requireOwner now refuses outright.
  const owner = admin.rows[0].id;
  const loc = await storageLocationService.create(
    { name: "Mirror Test", type: "local", rootPath: source, accessMode: "direct" }, admin.rows[0].id);
  locId = loc.id;
  await scanProcessor.handle({ storageLocationId: locId });

  // Give each file a canonical name + subject folder, as approving a
  // proposal on a read-only location would.
  const files = await p.query("SELECT * FROM files WHERE storage_location_id=$1 ORDER BY filename_current", [locId]);
  const canonical = [
    { match: "IMG_4471.docx", name: "Conférence sur l'Espérance 2026.docx", dir: "Academic/Conferences" },
    { match: "scan0001.pdf", name: "Quarterly Finance Report 2026.pdf", dir: "Finance/Reports" },
    { match: "untitled (1).xlsx", name: "Quarterly Finance Report 2026.pdf", dir: "Finance/Reports" }, // deliberate collision
  ];
  for (const c of canonical) {
    const f = files.rows.find((r) => r.filename_current === c.match);
    await fileRepository.setCanonicalName(f.id, { canonicalFilename: c.name, canonicalRelativeDir: c.dir });
  }

  console.log("\n--- building the mirror ---");
  const summary = await mirrorService.sync({ ownerUserId: owner });
  console.log("   summary:", JSON.stringify({
    candidates: summary.candidates, written: summary.written,
    pruned: summary.pruned, skippedOffline: summary.skippedOffline, errors: summary.errors.length,
  }));

  // Walk the OWNER'S root, not MIRROR_ROOT itself. Each account's tree is
  // nested under its own id (mirrorService.mirrorRoot), so listing from
  // MIRROR_ROOT makes every path below start with a uuid segment and no
  // expectation written as "Finance/Reports/..." can ever match.
  const ownerRoot = mirrorService.mirrorRoot(owner);
  const listing = [];
  (function walk(d, rel = "") {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else listing.push(r);
    }
  })(ownerRoot);
  console.log("\n   mirror tree:");
  listing.sort().forEach((l) => console.log(`     ${l}`));

  // SCOPED TO THIS SCRIPT'S OWN FIXTURES.
  //
  // These used to assert `summary.written === 3`, which was only ever true
  // while the database was empty: a sync covers everything the OWNER has, and
  // this script signs in as the first user in the table -- who also owns the
  // real repository. So once that had canonical names of its own the count
  // became 266 and every run failed on a number that was actually correct.
  // (The sync was global before ownership landed; it is per-account now, which
  // narrows the blast radius but does not help here, since it is the same
  // account either way.) Asserting that
  // MY three shortcuts exist says the same thing and stays true no matter
  // what else is in the database.
  // Distinct paths only: two fixtures deliberately claim the same canonical
  // name, and the second is disambiguated rather than written to that path.
  // The disambiguation itself is asserted separately below.
  const mine = [...new Set(
    canonical.map((c) => path.join(c.dir.replace(/\//g, path.sep), `${c.name}.lnk`))
  )];
  const missing = mine.filter((rel) => !listing.includes(rel));
  check("a shortcut was written for every fixture file", missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : `${mine.length}/${mine.length}`);

  // Scoped to the fixtures BY PATH, not by mirror root: this account's real
  // repository shortcuts land in this temp mirror too, so "starts with the
  // mirror root" matches all of them, not just the three written here.
  const mineAbs = new Set(mine.map((rel) => path.join(ownerRoot, rel)));
  const myErrors = summary.errors.filter((e) => mineAbs.has(String(e.shortcutPath || "")));
  check("no errors on the fixture shortcuts", myErrors.length === 0, JSON.stringify(myErrors).slice(0, 160));

  // Errors on the real repository's files are not this test's to assert on,
  // but silently dropping them would waste the one place they are visible.
  const otherErrors = summary.errors.filter((e) => !mineAbs.has(String(e.shortcutPath || "")));
  if (otherErrors.length) {
    console.log(`\n   NOTE: ${otherErrors.length} shortcut(s) from the real repository failed in this run:`);
    for (const e of otherErrors.slice(0, 5)) {
      console.log(`     ${path.basename(e.shortcutPath)}\n       ${String(e.message).slice(0, 130)}`);
    }
  }

  check("subject folders were created", listing.some((l) => l.startsWith(path.join("Finance", "Reports"))));
  check("accented canonical name preserved",
    listing.some((l) => l.includes("Espérance")), listing.find((l) => l.includes("Esp")) || "not found");
  check("colliding names were disambiguated, not overwritten",
    listing.filter((l) => l.includes("Quarterly Finance Report")).length === 2);

  console.log("\n--- do the shortcuts actually resolve? ---");
  if (process.platform === "win32") {
    const lnk = path.join(ownerRoot, listing.find((l) => l.endsWith(".lnk")));
    const target = execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
       `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`],
      { encoding: "utf8", windowsHide: true }).trim();
    console.log(`   ${path.basename(lnk)}\n     -> ${target}`);
    check("shortcut points at the real original", fs.existsSync(target) && target.startsWith(source));
  }

  console.log("\n--- originals must be untouched ---");
  const stillThere = (await fsp.readdir(source)).sort();
  console.log("   source folder now:", stillThere.join(", "));
  check("all originals still present under their ORIGINAL names",
    Object.keys(originals).every((n) => stillThere.includes(n)));

  console.log("\n--- re-running is idempotent, and prunes stale entries ---");
  const again = await mirrorService.sync({ ownerUserId: owner });
  // Pruning is the assertion that matters for idempotency: a second run must
  // not delete anything it just wrote. The written COUNT is global and
  // therefore not this test's to predict.
  const stillMine = mine.filter((rel) => fs.existsSync(path.join(ownerRoot, rel)));
  check("a second run keeps every fixture shortcut and prunes nothing",
    stillMine.length === mine.length && again.pruned === 0,
    `kept=${stillMine.length}/${mine.length} pruned=${again.pruned}`);

  // Drop a canonical name -> its shortcut should be pruned.
  const drop = files.rows[0];
  await p.query("UPDATE files SET canonical_filename=NULL, canonical_relative_dir=NULL WHERE id=$1", [drop.id]);
  const third = await mirrorService.sync({ ownerUserId: owner });
  check("removing a canonical name prunes its shortcut", third.pruned === 1, `pruned=${third.pruned}`);

  // A user's own file in the mirror must survive pruning.
  const userFile = path.join(ownerRoot, "my own notes.txt");
  await fsp.writeFile(userFile, "not a shortcut");
  await mirrorService.sync({ ownerUserId: owner });
  check("a non-shortcut file in the mirror is left alone", fs.existsSync(userFile));

  console.log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
})()
  .catch((e) => { console.error("\nFAILED:", e); failed += 1; })
  // Exit code, so a runner can tell a failing run from a passing one.
  .finally(async () => {
    await cleanup();
    process.exitCode = failed === 0 ? 0 : 1;
  });
