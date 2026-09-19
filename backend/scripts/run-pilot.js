// Measures the whole pipeline against a few thousand files and reports what
// it actually costs.
//
// WHY IT RUNS THE REAL QUEUE INSTEAD OF CALLING PROCESSORS DIRECTLY
//
// Calling each processor in a loop would give tidier numbers and would be a
// lie: in production every stage hands off through the queue, and each handoff
// costs a processing_jobs INSERT plus the claim query the worker runs against
// it (SELECT ... FOR UPDATE SKIP LOCKED). At four fan-out jobs per file that
// overhead is a real part of the answer to "how long will the client's drive
// take", so the pilot pays it too.
//
// It spawns its OWN worker with AI classification forced off. Two reasons:
// the live worker would race this one for jobs and make the timings
// meaningless, and with AI_ESCALATE_BELOW_CONFIDENCE=always a 3,000-file scan
// would fire 3,000 Gemini calls. AI cost is measured separately and
// deliberately, by scripts/measure-ai-cost.js, on a bounded sample.
//
// Usage:
//   node scripts/run-pilot.js
//   node scripts/run-pilot.js --corpus "D:\\some\\folder"
//   node scripts/run-pilot.js --teardown

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Pool } = require("pg");
const env = require("../src/config/env");
const storageLocationService = require("../src/services/storageLocationService");
const { enqueueJob, closeAllQueues } = require("../src/queues");
const pgQueue = require("../src/queues/pgQueue");
const { JobType } = require("../src/models/enums");

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const CORPUS = argOf("corpus", path.join(process.env.LOCALAPPDATA, "AtlasPilotCorpus"));
const TEARDOWN = args.includes("--teardown");
const LOCATION_NAME = "PILOT -- synthetic corpus";

const pool = new Pool({ connectionString: env.databaseUrl });
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const one = async (sql, params) => (await q(sql, params))[0];
const secs = (ms) => (ms / 1000).toFixed(1);
const pad = (s, n) => String(s).padEnd(n);
const num = (n, w = 7) => String(n).padStart(w);

async function findPilotLocation() {
  return one("SELECT * FROM storage_locations WHERE name = $1", [LOCATION_NAME]);
}

async function teardown() {
  const loc = await findPilotLocation();
  if (!loc) { console.log("No pilot storage location in the database."); }
  else {
    console.log(`Removing pilot data for location ${loc.id}...`);
    // Explicit child-table deletes rather than trusting cascade: several of
    // these tables reference files without ON DELETE CASCADE, and a partial
    // teardown that leaves orphans is worse than none.
    await q(`DELETE FROM duplicate_group_members WHERE file_id IN (SELECT id FROM files WHERE storage_location_id=$1)`, [loc.id]);
    // Groups of ONE, not just groups of zero. The corpus deliberately clones
    // real documents, so pilot files hash-match the user's genuine files and
    // join the same duplicate groups. Removing only the pilot members leaves
    // a group with a single survivor -- which is not a duplicate of anything
    // and pollutes the real Duplicates page. Groups that still hold two or
    // more real files are untouched.
    await q(`DELETE FROM duplicate_group_members
              WHERE duplicate_group_id IN (
                SELECT duplicate_group_id FROM duplicate_group_members GROUP BY 1 HAVING count(*) < 2)`);
    await q(`DELETE FROM duplicate_groups WHERE id NOT IN (SELECT duplicate_group_id FROM duplicate_group_members)`);
    await q(`DELETE FROM classification_results WHERE file_id IN (SELECT id FROM files WHERE storage_location_id=$1)`, [loc.id]);
    await q(`DELETE FROM rename_proposals        WHERE file_id IN (SELECT id FROM files WHERE storage_location_id=$1)`, [loc.id]);
    await q(`DELETE FROM file_content            WHERE file_id IN (SELECT id FROM files WHERE storage_location_id=$1)`, [loc.id]);
    await q(`DELETE FROM file_metadata           WHERE file_id IN (SELECT id FROM files WHERE storage_location_id=$1)`, [loc.id]);
    await q(`DELETE FROM file_hashes             WHERE file_id IN (SELECT id FROM files WHERE storage_location_id=$1)`, [loc.id]);
    await q(`DELETE FROM audit_logs              WHERE entity_type='file' AND entity_id IN (SELECT id FROM files WHERE storage_location_id=$1)`, [loc.id]);
    // Two passes on purpose. Scoping by storage_location_id alone misses
    // every job enqueued without one -- generate_names is enqueued with an
    // empty options object, so its rows have a NULL location and survived
    // the first cleanup, sitting "queued" forever in the Jobs dock.
    await q(`DELETE FROM processing_jobs WHERE storage_location_id=$1`, [loc.id]);
    await q(`DELETE FROM processing_jobs WHERE payload->>'fileId' IN (SELECT id::text FROM files WHERE storage_location_id=$1)`, [loc.id]);
    await q(`DELETE FROM filesystem_scans        WHERE storage_location_id=$1`, [loc.id]);
    await q(`DELETE FROM files                   WHERE storage_location_id=$1`, [loc.id]);
    await q(`DELETE FROM storage_locations       WHERE id=$1`, [loc.id]);
    console.log("Database rows removed.");
  }

  // Draining the queue and cancelling the rows used to be two steps that could
  // disagree -- obliterating Redis left processing_jobs rows claiming to be
  // queued, which showed in the Jobs dock as permanent phantom work. Since
  // migration 040 the row IS the queue entry, so cancelling the rows is the
  // drain, and there is nothing left over to reconcile.
  const stranded = await q(
    `UPDATE processing_jobs SET status='cancelled', finished_at=now(),
            error_message='Cancelled by pilot teardown.'
      WHERE status IN ('queued','running') RETURNING id`);
  console.log(`Queue drained: cancelled ${stranded.length} pending job row(s).`);
  console.log(`\nThe corpus itself is still on disk at ${CORPUS}`);
  console.log(`Delete it with:  node scripts/generate-pilot-corpus.js --clean`);
}

// ---------------------------------------------------------------------------

async function activeWorkersElsewhere() {
  // Each worker holds a shared advisory lock for as long as it lives
  // (pgQueue.registerWorker), so counting holders in pg_locks sees the live
  // worker process even though it is not a child of this one -- the same
  // question the old BullMQ queue answered from its own worker registry.
  return pgQueue.countActiveWorkers();
}

function startPilotWorker() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "workers", "runner.js")], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, AI_CLASSIFICATION_ENABLED: "false", WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY || "4" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logPath = path.join(process.env.TEMP, "atlas-pilot-worker.log");
  const log = fs.createWriteStream(logPath);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return { child, logPath };
}

async function jobStats(since) {
  return q(
    `SELECT job_type, status, count(*)::int AS n
       FROM processing_jobs WHERE created_at >= $1
      GROUP BY job_type, status`, [since]);
}

async function main() {
  if (TEARDOWN) return teardown();

  if (!fs.existsSync(CORPUS)) {
    throw new Error(`No corpus at ${CORPUS}. Run: node scripts/generate-pilot-corpus.js --count 3000`);
  }
  if (await findPilotLocation()) {
    throw new Error(`A previous pilot is still registered. Clear it first:  node scripts/run-pilot.js --teardown`);
  }
  const running = await activeWorkersElsewhere();
  if (running > 0) {
    throw new Error(
      `${running} worker(s) are already consuming the queues. Stop the live worker first, or it will race this ` +
      `pilot and fire Gemini on every file.\n` +
      `  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where CommandLine -like "*runner.js*" | ForEach { Stop-Process -Id $_.ProcessId }`);
  }

  const admin = await one("SELECT id FROM users ORDER BY created_at LIMIT 1");
  const onDisk = { files: 0, bytes: 0 };
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else { onDisk.files += 1; onDisk.bytes += fs.statSync(f).size; }
    }
  })(CORPUS);

  const dbBefore = await one("SELECT pg_database_size(current_database())::bigint AS b");

  console.log("=".repeat(72));
  console.log("ATLAS PILOT");
  console.log("=".repeat(72));
  console.log(`corpus        ${CORPUS}`);
  console.log(`on disk       ${onDisk.files} files, ${(onDisk.bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`concurrency   ${process.env.WORKER_CONCURRENCY || "4"}`);
  console.log(`AI            disabled for this run (measured separately)\n`);

  const { child, logPath } = startPilotWorker();
  const cleanupWorker = () => { try { child.kill(); } catch { /* already gone */ } };
  process.on("exit", cleanupWorker);

  const pilotStart = new Date();
  const t0 = Date.now();

  const loc = await storageLocationService.create(
    { name: LOCATION_NAME, type: "local", rootPath: CORPUS, accessMode: "direct" }, admin.id);
  console.log(`Registered storage location ${loc.id} (read-only: ${loc.is_read_only})`);

  await enqueueJob(JobType.SCAN, { storageLocationId: loc.id }, { storageLocationId: loc.id, createdBy: admin.id });
  console.log("Scan enqueued. Watching the pipeline drain...\n");

  console.log(`${pad("elapsed", 9)}${pad("files", 8)}${pad("hashed", 8)}${pad("text", 8)}${pad("classed", 9)}${pad("queued", 8)}running`);

  let scanDoneAt = null, lastChange = Date.now(), prevSignature = "";
  const timeline = [];

  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));

    const [counts, jobs] = await Promise.all([
      one(`SELECT
             (SELECT count(*) FROM files WHERE storage_location_id=$1)::int AS files,
             (SELECT count(*) FROM files WHERE storage_location_id=$1 AND sha256_hash IS NOT NULL)::int AS hashed,
             (SELECT count(*) FROM file_content fc JOIN files f ON f.id=fc.file_id WHERE f.storage_location_id=$1)::int AS text,
             (SELECT count(DISTINCT cr.file_id) FROM classification_results cr JOIN files f ON f.id=cr.file_id WHERE f.storage_location_id=$1)::int AS classed`,
        [loc.id]),
      one(`SELECT count(*) FILTER (WHERE status='queued')::int AS queued,
                  count(*) FILTER (WHERE status='running')::int AS running
             FROM processing_jobs WHERE created_at >= $1`, [pilotStart]),
    ]);

    const elapsed = Date.now() - t0;
    timeline.push({ ms: elapsed, ...counts });
    console.log(
      `${pad(secs(elapsed) + "s", 9)}${pad(counts.files, 8)}${pad(counts.hashed, 8)}${pad(counts.text, 8)}${pad(counts.classed, 9)}${pad(jobs.queued, 8)}${jobs.running}`
    );

    if (!scanDoneAt && counts.files >= onDisk.files) scanDoneAt = elapsed;

    const signature = JSON.stringify({ ...counts, ...jobs });
    if (signature !== prevSignature) { lastChange = Date.now(); prevSignature = signature; }

    if (jobs.queued === 0 && jobs.running === 0 && counts.files > 0) break;
    // Nothing moved for two minutes: something is wedged. Report rather than
    // hang forever.
    if (Date.now() - lastChange > 120000) { console.log("\n!! stalled -- no progress for 2 minutes, stopping"); break; }
  }

  const totalMs = Date.now() - t0;
  cleanupWorker();

  // --- results -------------------------------------------------------------

  console.log(`\n${"=".repeat(72)}\nRESULTS\n${"=".repeat(72)}`);

  const files = await one(`SELECT count(*)::int n, sum(size_bytes)::bigint b FROM files WHERE storage_location_id=$1`, [loc.id]);
  console.log(`\nwall clock                ${secs(totalMs)}s for ${files.n} files (${(files.b / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  discovery (scan)        ${scanDoneAt ? secs(scanDoneAt) + "s" : "n/a"}`);
  console.log(`  throughput              ${(files.n / (totalMs / 1000)).toFixed(1)} files/sec  |  ${((files.b / 1024 / 1024) / (totalMs / 1000)).toFixed(1)} MB/sec`);
  console.log(`  per 10,000 files        ~${((totalMs / files.n) * 10000 / 1000 / 60).toFixed(0)} minutes at this rate`);

  const ext = await q(
    `SELECT lower(f.extension) AS ext, count(*)::int AS n,
            count(*) FILTER (WHERE length(coalesce(fc.extracted_text,'')) > 0)::int AS with_text,
            round(avg(length(coalesce(fc.extracted_text,''))))::int AS avg_chars
       FROM files f LEFT JOIN file_content fc ON fc.file_id=f.id
      WHERE f.storage_location_id=$1 GROUP BY 1 ORDER BY 2 DESC`, [loc.id]);
  console.log(`\nextraction by type`);
  console.log(`  ${pad("ext", 8)}${num("files")}${num("w/ text")}${num("recall")}   avg chars`);
  let totN = 0, totT = 0;
  for (const r of ext) {
    totN += r.n; totT += r.with_text;
    console.log(`  ${pad(r.ext || "(none)", 8)}${num(r.n)}${num(r.with_text)}${num(((r.with_text / r.n) * 100).toFixed(0) + "%")}   ${r.avg_chars ?? 0}`);
  }
  console.log(`  ${pad("TOTAL", 8)}${num(totN)}${num(totT)}${num(((totT / totN) * 100).toFixed(0) + "%")}`);

  const dupes = await q(
    `SELECT dg.group_type, count(DISTINCT dg.id)::int AS groups, count(dgm.file_id)::int AS members,
            round(avg(dgm.similarity_score)::numeric, 3) AS avg_score
       FROM duplicate_groups dg JOIN duplicate_group_members dgm ON dgm.duplicate_group_id=dg.id
       JOIN files f ON f.id=dgm.file_id
      WHERE f.storage_location_id=$1 GROUP BY 1`, [loc.id]);
  console.log(`\nduplicates`);
  if (!dupes.length) console.log("  none found");
  for (const d of dupes) console.log(`  ${pad(d.group_type, 10)}${num(d.groups)} groups  ${num(d.members)} members  avg score ${d.avg_score}`);

  const conf = await q(
    `SELECT confidence_level, count(*)::int AS n FROM classification_results cr
       JOIN files f ON f.id=cr.file_id WHERE f.storage_location_id=$1 GROUP BY 1 ORDER BY 2 DESC`, [loc.id]);
  console.log(`\nrule-based classification (no AI)`);
  for (const c of conf) console.log(`  ${pad(c.confidence_level, 10)}${num(c.n)}`);
  const proposals = await one(
    `SELECT count(*)::int n FROM rename_proposals rp JOIN files f ON f.id=rp.file_id WHERE f.storage_location_id=$1`, [loc.id]);
  console.log(`  rename proposals generated  ${proposals.n}`);

  const jobRows = await jobStats(pilotStart);
  const totalJobs = jobRows.reduce((a, r) => a + r.n, 0);
  console.log(`\njob rows created          ${totalJobs}  (${(totalJobs / files.n).toFixed(1)} per file)`);
  for (const r of jobRows.filter((r) => r.status !== "completed").sort((a, b) => b.n - a.n)) {
    console.log(`  ${pad(r.job_type, 22)}${pad(r.status, 12)}${num(r.n)}`);
  }

  const dbAfter = await one("SELECT pg_database_size(current_database())::bigint AS b");
  const grewMb = (Number(dbAfter.b) - Number(dbBefore.b)) / 1024 / 1024;
  console.log(`\ndatabase growth           ${grewMb.toFixed(1)} MB for ${files.n} files ` +
              `(${(grewMb * 1024 / files.n).toFixed(1)} KB/file, ~${(grewMb / files.n * 100000 / 1024).toFixed(2)} GB per 100k files)`);

  console.log(`\nworker log                ${logPath}`);
  console.log(`teardown                  node scripts/run-pilot.js --teardown`);
}

main()
  .catch((e) => { console.error("\nPILOT FAILED:", e.message); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await closeAllQueues(); });
