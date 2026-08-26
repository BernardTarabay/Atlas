// Give every existing file a description.
//
// The describe stage runs automatically for anything ingested from now on
// (hashProcessor for photos and recordings, classifyProcessor for documents,
// ocrService for scans). This is for everything that was already in the
// repository before the stage existed.
//
//   node scripts/backfill-descriptions.js                 everything missing one
//   node scripts/backfill-descriptions.js --limit 100     just the first 100
//   node scripts/backfill-descriptions.js --force         redo ones already done
//   node scripts/backfill-descriptions.js --embed-only    only fill in missing vectors
//   node scripts/backfill-descriptions.js --queue         hand them to the worker instead
//   node scripts/backfill-descriptions.js --dry-run       report, change nothing
//
// WHY IT RUNS IN PROCESS BY DEFAULT
//
// Enqueueing 9,000 describe jobs hands the worker a backlog that competes
// with live ingestion, with no way to watch it or stop it short of pausing
// the queue. Running here means one file at a time, in order, with progress
// on screen and Ctrl-C as a working stop button. `--queue` is there for
// anyone who wants the other behaviour.
//
// COST
//
// One AI call per file that needs a description and cannot inherit one, plus
// one embedding call per description. There is no artificial cap to stop
// against any more (see config/env.js) -- the run goes until it is done, and
// Google's own 429 + retry hint is what paces it. Spend is recorded in the
// audit log; `node scripts/measure-ai-cost.js` reports it.
// `--embed-only` costs embeddings alone, which are far cheaper, and is the
// right first run if descriptions already exist and only search is missing.
const { Pool } = require("pg");
const env = require("../src/config/env");
const descriptionService = require("../src/services/descriptionService");
const fileDescriptionRepository = require("../src/repositories/fileDescriptionRepository");
const { enqueueJob, closeAllQueues } = require("../src/queues");
const { JobType } = require("../src/models/enums");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const LIMIT = parseInt(valueOf("--limit", "100000"), 10);
const FORCE = has("--force");
const QUEUE = has("--queue");
const DRY_RUN = has("--dry-run");
const EMBED_ONLY = has("--embed-only");

const pool = new Pool({ connectionString: env.databaseUrl });

let stopping = false;
process.on("SIGINT", () => {
  console.log("\n\nStopping after the file in flight. Nothing is lost -- rerun to continue.");
  stopping = true;
});

async function targets() {
  if (EMBED_ONLY) {
    const { rows } = await pool.query(
      `SELECT f.id, f.filename_current, f.owner_user_id
         FROM file_descriptions d
         JOIN files f ON f.id = d.file_id
        WHERE d.embedding IS NULL AND d.description IS NOT NULL AND f.status <> 'deleted'
        ORDER BY d.generated_at
        LIMIT $1`,
      [LIMIT]
    );
    return rows;
  }

  const { rows } = await pool.query(
    `SELECT f.id, f.filename_current, f.owner_user_id
       FROM files f
       LEFT JOIN file_descriptions d ON d.file_id = f.id
      WHERE f.status NOT IN ('deleted', 'missing')
        AND ($2::boolean OR d.file_id IS NULL OR d.source = 'failed')
      ORDER BY f.imported_at DESC
      LIMIT $1`,
    [LIMIT, FORCE]
  );
  return rows;
}

async function main() {
  const files = await targets();

  console.log(
    `${files.length} file(s) to ${EMBED_ONLY ? "embed" : "describe"}` +
    `${FORCE ? " (--force: redoing ones already described)" : ""}` +
    `${DRY_RUN ? " -- DRY RUN, nothing will change" : ""}\n`
  );

  if (!files.length || DRY_RUN) {
    await report();
    return;
  }

  const counts = { ok: 0, failed: 0, skipped: 0, bySource: {} };
  let index = 0;

  for (const file of files) {
    if (stopping) break;
    index += 1;
    const label = `[${String(index).padStart(String(files.length).length)}/${files.length}] ${String(file.filename_current).slice(0, 44)}`;

    if (QUEUE) {
      await enqueueJob(JobType.DESCRIBE, { fileId: file.id, force: FORCE }, { ownerUserId: file.owner_user_id });
      console.log(`${label} -> queued`);
      counts.ok += 1;
      continue;
    }

    try {
      const result = await descriptionService.describeFile(file.id, { force: FORCE });
      if (result.ok) {
        counts.ok += 1;
        counts.bySource[result.source] = (counts.bySource[result.source] || 0) + 1;
        console.log(`${label} -> ${result.source}${result.embedded === false ? " (not embedded)" : ""}`);
      } else if (result.skipped) {
        counts.skipped += 1;
        console.log(`${label} -> skipped (${result.reason})`);
      } else {
        counts.failed += 1;
        console.log(`${label} -> FAILED: ${result.reason}`);
      }
    } catch (err) {
      counts.failed += 1;
      console.log(`${label} -> THREW: ${err.message}`);
    }
  }

  console.log(`\ndescribed ${counts.ok}, skipped ${counts.skipped}, failed ${counts.failed}`);
  if (Object.keys(counts.bySource).length) {
    console.log("by evidence:", Object.entries(counts.bySource).map(([k, v]) => `${k}=${v}`).join(" "));
  }
  await report();
}

async function report() {
  const { rows: owners } = await pool.query(
    "SELECT DISTINCT owner_user_id FROM files WHERE status <> 'deleted'"
  );
  console.log("\nCoverage now:");
  for (const { owner_user_id: owner } of owners) {
    const rows = await fileDescriptionRepository.countBySource(owner);
    const total = rows.reduce((sum, r) => sum + r.files, 0);
    console.log(`\n  owner ${owner} -- ${total} file(s)`);
    for (const row of rows) {
      const flag = row.source === "(none)" ? "  <- still undescribed" : "";
      console.log(`    ${String(row.source).padEnd(14)} ${String(row.files).padStart(6)}  (${row.embedded} embedded)${flag}`);
    }
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => {
    await pool.end().catch(() => {});
    await closeAllQueues().catch(() => {});
    
  });
