// Measures what the AI tier actually costs per file, on a bounded sample.
//
// WHY A SAMPLE AND NOT THE WHOLE CORPUS
//
// With AI_ESCALATE_BELOW_CONFIDENCE=always, every classified file calls
// Gemini. Running that across a few thousand files would burn hours against
// the free tier's 15 requests/minute and spend real money to learn something
// a few dozen calls already tell you: the token cost per document. So this
// takes a deliberately small sample, measures tokens and latency directly
// from the API's own usage numbers, and extrapolates.
//
// Nothing here writes to the database. It calls the classifier and reports.
//
// Usage:
//   node scripts/measure-ai-cost.js                 # 25 files
//   node scripts/measure-ai-cost.js --sample 50
//   node scripts/measure-ai-cost.js --sample 25 --in-price 0.10 --out-price 0.40

const { Pool } = require("pg");
const env = require("../src/config/env");
const geminiClassifier = require("../src/services/ai/geminiClassifier");
const subjectRepository = require("../src/repositories/subjectRepository");
const documentTypeRepository = require("../src/repositories/documentTypeRepository");

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

const SAMPLE = parseInt(argOf("sample", "25"), 10);
// USD per 1M tokens. These are defaults, not gospel -- Google changes pricing
// and the script prints them so a stale number is visible rather than silently
// baked into the conclusion. Override with --in-price / --out-price.
const IN_PRICE = parseFloat(argOf("in-price", "0.10"));
const OUT_PRICE = parseFloat(argOf("out-price", "0.40"));

const pool = new Pool({ connectionString: env.databaseUrl });

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const usd = (n) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

(async () => {
  if (!env.ai.enabled) throw new Error("AI is disabled (GEMINI_API_KEY unset or AI_CLASSIFICATION_ENABLED=false).");

  // Deliberately spread across the size range: cost is driven by excerpt
  // length, and sampling only small files would understate it.
  const { rows: files } = await pool.query(
    `SELECT f.id, f.filename_current, f.extension, length(fc.extracted_text) AS chars, fc.extracted_text
       FROM files f JOIN file_content fc ON fc.file_id = f.id
      WHERE length(coalesce(fc.extracted_text,'')) > 200
      ORDER BY md5(f.id::text)
      LIMIT $1`, [SAMPLE]);

  if (!files.length) throw new Error("No files with extracted text. Run the pilot first.");

  const [subjects, documentTypes] = await Promise.all([
    subjectRepository.list({ limit: 1000 }),
    documentTypeRepository.list({ limit: 1000 }),
  ]);

  console.log("=".repeat(72));
  console.log("GEMINI COST MEASUREMENT");
  console.log("=".repeat(72));
  console.log(`model          ${env.ai.model}`);
  console.log(`sample         ${files.length} files with extracted text`);
  console.log(`excerpt cap    ${geminiClassifier.MAX_EXCERPT_CHARS} chars`);
  console.log(`client pacing  ${env.ai.rateLimitPerMinute}/min`);
  console.log(`pricing used   ${usd(IN_PRICE)}/1M in, ${usd(OUT_PRICE)}/1M out  <-- verify against current Google pricing\n`);

  const rows = [];
  let failures = 0;
  const started = Date.now();

  for (const [i, f] of files.entries()) {
    const t = Date.now();
    try {
      const r = await geminiClassifier.classify({
        filename: f.filename_current,
        bodyText: f.extracted_text,
        subjects,
        documentTypes,
        embeddedTitle: null,
      });
      const ms = Date.now() - t;
      const u = r.usage || {};
      // The Interactions API has used a couple of different names for these
      // across versions; take whichever is present rather than reporting 0
      // and quietly understating cost.
      const inTok = u.input_tokens ?? u.prompt_token_count ?? u.promptTokens ?? 0;
      const outTok = u.output_tokens ?? u.candidates_token_count ?? u.completionTokens ?? 0;
      rows.push({ chars: Number(f.chars), ms, inTok, outTok, ext: f.extension, title: r.shortTitle, conf: r.confidenceLevel });
      process.stdout.write(`  ${String(i + 1).padStart(3)}/${files.length}  ${String(ms).padStart(5)}ms  in:${String(inTok).padStart(5)} out:${String(outTok).padStart(4)}  ${r.confidenceLevel.padEnd(6)} ${String(r.shortTitle).slice(0, 44)}\n`);
    } catch (err) {
      failures += 1;
      console.log(`  ${String(i + 1).padStart(3)}/${files.length}  FAILED  ${err.message.slice(0, 90)}`);
    }
  }

  if (!rows.length) throw new Error("Every call failed -- nothing to measure.");

  const wall = (Date.now() - started) / 1000;
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const avgIn = sum("inTok") / rows.length;
  const avgOut = sum("outTok") / rows.length;
  const costPerFile = (avgIn / 1e6) * IN_PRICE + (avgOut / 1e6) * OUT_PRICE;
  const lat = rows.map((r) => r.ms);

  console.log(`\n${"-".repeat(72)}`);
  console.log(`succeeded            ${rows.length}/${files.length}${failures ? `  (${failures} failed)` : ""}`);
  console.log(`wall clock           ${wall.toFixed(1)}s  -> ${(rows.length / (wall / 60)).toFixed(1)} files/min end to end`);
  console.log(`latency              p50 ${pct(lat, 0.5)}ms   p95 ${pct(lat, 0.95)}ms   max ${Math.max(...lat)}ms`);
  console.log(`tokens per file      ${avgIn.toFixed(0)} in  +  ${avgOut.toFixed(0)} out`);
  console.log(`cost per file        ${usd(costPerFile)}`);
  console.log(`\nextrapolated`);
  for (const n of [1000, 10000, 50000, 100000]) {
    // Client-side pacing is off by default now (config/env.js), so there is
    // no fixed rate to project a duration from -- throughput is whatever
    // Google allows. Only quote wall-clock when someone opted into a pace.
    const pace = env.ai.rateLimitPerMinute;
    const duration = pace > 0 ? `   ${(n / pace / 60).toFixed(1)}h at ${pace}/min` : "";
    console.log(`  ${String(n).padStart(6)} files   ${usd(costPerFile * n).padStart(10)}${duration}`);
  }

  console.log(`\nnotes`);
  console.log(`  - Cost is driven by the ${geminiClassifier.MAX_EXCERPT_CHARS}-char excerpt cap, not file size:`);
  console.log(`    sampled documents ranged ${Math.min(...rows.map((r) => r.chars))} to ${Math.max(...rows.map((r) => r.chars))} chars`);
  console.log(`    and every one over the cap costs the same.`);
  console.log(`  - Exact duplicates reuse a sibling's result and cost nothing.`);
  // No ceiling to report against: the daily cap and the default per-minute
  // pace were both removed (config/env.js). Spend is reported, not refused.
  console.log(`  - There is no artificial AI cap. Spend is bounded by how many files you`);
  console.log(`    process, not by a quota this application enforces.`);
})()
  .catch((e) => { console.error("\nFAILED:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
