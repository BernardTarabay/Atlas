// Sizing the "Atlas keeps the files" option, from measured facts where they
// exist and stated assumptions where they do not.
//
// WHY THIS IS A SCRIPT AND NOT A PARAGRAPH
//
// The question -- "what would it cost to let Atlas delete the originals?" --
// has one honest answer and several invented ones. The honest answer needs the
// real corpus measured, and the real corpus is not on this machine yet. So this
// separates the two: everything it can read from the database and the disk it
// reads, and everything else it takes as a named input and labels as an
// assumption, so nobody mistakes a projection for a measurement.
//
// Re-run it against the real archive once that is scanned and every number
// below becomes measured rather than assumed.
//
//   node scripts/vault-sizing.js
//   node scripts/vault-sizing.js --files 9398 --avg-kb 400
//   node scripts/vault-sizing.js --files 9398 --total-gb 120 --dupe-pct 40

const { Pool } = require("pg");
const fs = require("fs");
const env = require("../src/config/env");

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

const GB = 1024 ** 3;
const fmt = (bytes) => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const pad = (s, n) => String(s).padEnd(n);

const p = new Pool({ connectionString: env.databaseUrl });

(async () => {
  // ---------------------------------------------------------------- measured
  const { rows: [db] } = await p.query(
    "SELECT pg_database_size(current_database())::bigint AS bytes"
  );
  /**
   * How much database ONE document costs.
   *
   * Not total-size-divided-by-files: most of this database is fixed overhead
   * and tables that have nothing to do with document count (`subjects` alone is
   * 11 MB of index pages left over from a 46,000-folder load test). Dividing by
   * 16 files projected a 14.9 GB database for the real archive, which is
   * nonsense and the kind of number that discredits every other number next to
   * it. Only the tables that grow per document are counted.
   */
  const { rows: [perDoc] } = await p.query(`
    SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::bigint AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname IN ('files','file_content','file_metadata','file_hashes',
                         'classification_results','file_descriptions','rename_proposals')`);
  const { rows: [live] } = await p.query(`
    SELECT count(*)::int AS files,
           coalesce(sum(size_bytes),0)::bigint AS bytes,
           count(DISTINCT sha256_hash)::int AS unique_files
      FROM files WHERE status <> 'deleted'`);
  /**
   * The duplicate fraction has to come from the audit log, not from the live
   * table: the redundant copies have already been deleted, so counting them now
   * reports 0% and would tell the client his archive has no duplication in it --
   * the opposite of what was actually measured.
   */
  const { rows: [dupes] } = await p.query(`
    SELECT count(*)::int AS copies,
           coalesce(sum((previous_state->>'sizeBytes')::bigint),0)::bigint AS bytes
      FROM audit_logs WHERE action = 'file.redundant_copy_deleted'`);

  const measuredAvg = live.files > 0 ? Number(live.bytes) / live.files : 0;

  console.log("VAULT SIZING -- what it costs for Atlas to hold the files\n" + "=".repeat(64));
  console.log("\nMEASURED, on this machine right now");
  console.log(`  ${pad("indexed documents", 30)} ${live.files}`);
  console.log(`  ${pad("their bytes", 30)} ${fmt(Number(live.bytes))}`);
  console.log(`  ${pad("average document", 30)} ${(measuredAvg / 1024).toFixed(0)} KB`);
  console.log(`  ${pad("database size", 30)} ${fmt(Number(db.bytes))}`);
  const sampleTotal = live.files + dupes.copies;
  console.log(`  ${pad("redundant copies removed", 30)} ${dupes.copies} (${fmt(Number(dupes.bytes))})`);
  console.log(`  ${pad("...so the sample was", 30)} ${dupes.copies} of ${sampleTotal} rows redundant`);
  console.log(`  ${pad("database per document", 30)} ${(Number(perDoc.bytes) / Math.max(1, live.files) / 1024).toFixed(0)} KB (marginal, excludes fixed overhead)`);

  let free = null;
  try {
    // Windows: the drive the vault would live on.
    const stat = fs.statfsSync ? fs.statfsSync(process.cwd()) : null;
    if (stat) free = stat.bavail * stat.bsize;
  } catch { /* not fatal -- reported as unknown */ }
  console.log(`  ${pad("free disk on this volume", 30)} ${free ? fmt(free) : "(unknown)"}`);

  // -------------------------------------------------------------- projected
  const files = arg("files", 9398);
  const totalGb = arg("total-gb", null);
  const avgKb = arg("avg-kb", null);
  const dupePct = arg("dupe-pct", null);

  const avgBytes = totalGb !== null ? (totalGb * GB) / files : (avgKb !== null ? avgKb * 1024 : measuredAvg);
  const rawBytes = avgBytes * files;

  // Observed duplicate fraction on the sample, unless overridden.
  const observedDupePct = sampleTotal > 0 ? (dupes.copies / sampleTotal) * 100 : 0;
  const dupeFraction = (dupePct !== null ? dupePct : observedDupePct) / 100;
  const storedBytes = rawBytes * (1 - dupeFraction);

  console.log("\nASSUMED, for the projection below");
  console.log(`  ${pad("documents in the real archive", 30)} ${files.toLocaleString()}  ${arg("files") ? "(you gave this)" : "(from docs/13-operational-notes.md)"}`);
  console.log(`  ${pad("average document size", 30)} ${(avgBytes / 1024).toFixed(0)} KB  ${
    totalGb !== null ? "(derived from --total-gb)" : avgKb !== null ? "(you gave this)" : "(THIS MACHINE'S sample -- photos and video, likely too big)"}`);
  console.log(`  ${pad("duplicate fraction", 30)} ${(dupeFraction * 100).toFixed(0)}%  ${
    dupePct !== null ? "(you gave this)" : "(observed on the sample)"}`);

  console.log("\nPROJECTED, if Atlas holds the files");
  console.log(`  ${pad("raw corpus", 30)} ${fmt(rawBytes)}`);
  console.log(`  ${pad("vault, deduplicated", 30)} ${fmt(storedBytes)}   <- server disk needed`);
  console.log(`  ${pad("during migration (both copies)", 30)} ${fmt(rawBytes + storedBytes)}   <- peak, before sources are deleted`);
  console.log(`  ${pad("one full backup of the vault", 30)} ${fmt(storedBytes)}`);
  console.log(`  ${pad("vault + one backup", 30)} ${fmt(storedBytes * 2)}`);
  console.log(`  ${pad("database", 30)} ${fmt((Number(perDoc.bytes) / Math.max(1, live.files)) * files)}   (marginal cost x documents)`);

  if (free !== null) {
    const ok = free > rawBytes + storedBytes;
    console.log(`\n  This volume has ${fmt(free)} free -- ${ok ? "enough" : "NOT ENOUGH"} for the migration peak.`);
  }

  console.log("\nWHAT CHANGES OPERATIONALLY, WHICH IS THE REAL COST");
  console.log("  Today   the client's files live on his drives. Atlas holds an index and");
  console.log("          shortcuts. If the server dies, nothing of his is lost -- rescan and");
  console.log("          the catalogue rebuilds. The database is the only thing worth backing up,");
  console.log(`          and it is ${fmt(Number(db.bytes))}.`);
  console.log("  After   the vault is the ONLY copy of every document whose source was deleted.");
  console.log("          A failed disk, a bad migration or a ransomware event loses the archive.");
  console.log("          Backups stop being prudent and become the product working at all.");
  console.log("\n  That is the decision. It is not a storage bill, it is who is responsible");
  console.log("  for the client's documents -- him, or this server.");

  await p.end();
})().catch((e) => { console.error(e); process.exitCode = 1; });
