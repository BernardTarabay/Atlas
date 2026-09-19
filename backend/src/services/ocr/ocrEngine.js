// Optical character recognition, via the native Tesseract binary.
//
// WHY A BINARY AND NOT A LIBRARY
//
// The alternative was tesseract.js, a WASM build that downloads its language
// data at runtime. For this corpus -- French and Arabic scans -- that is
// 30-40MB of traineddata fetched on first use, decoded in-process, and an
// order of magnitude slower per page. The native binary is a one-time install
// and reads the same traineddata from disk.
//
// The cost is that it is an EXTERNAL dependency the app does not control. So
// this module treats "tesseract is not installed" as a first-class, reported
// state rather than an exception: `ocr_status = 'unavailable'` with a message
// naming the install command. Nothing here ever fabricates text, and a file
// whose OCR could not run keeps its original name and stays visible in the
// Photos workspace -- which is the honest outcome, and the one the user can
// act on.
//
// WHY NOT WINDOWS.MEDIA.OCR
//
// It is genuinely good and needs no install, but it is Windows-only and
// reachable only through a PowerShell/WinRT bridge. Making the OCR engine
// platform-specific would mean this feature quietly does nothing the day the
// backend moves to a Linux box, which is exactly the class of surprise the
// rest of this codebase avoids.
const { execFile } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Where tesseract might be. PATH first, then the two locations the official
// Windows installer uses -- checking those means a normal install works with
// no configuration, and TESSERACT_PATH covers everything else.
const CANDIDATE_PATHS = [
  process.env.TESSERACT_PATH,
  "tesseract",
  "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
  "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe",
  "/usr/bin/tesseract",
  "/usr/local/bin/tesseract",
  "/opt/homebrew/bin/tesseract",
].filter(Boolean);

/**
 * Languages to recognise, in Tesseract's `+`-joined form.
 *
 * Defaults to French, Arabic and English because that is what this archive
 * actually contains -- docs/13 §13.3 is emphatic that anything
 * touching text here has to survive both French and Arabic. Tesseract needs
 * the matching traineddata installed for each; a missing one is reported by
 * the binary and surfaced verbatim rather than silently dropped, since
 * "recognised as English" on an Arabic scan is worse than no result.
 */
const DEFAULT_LANGUAGES = process.env.OCR_LANGUAGES || "fra+ara+eng";

// A page of dense text takes a few seconds; a large multi-page scan can take
// much longer. Bounded so a pathological input cannot occupy a worker slot
// indefinitely.
const TIMEOUT_MS = parseInt(process.env.OCR_TIMEOUT_MS || "120000", 10);

// What tesseract will accept directly. Anything else (notably PDF) has to be
// rasterised first -- see pdfRasterizer.js.
const DIRECT_IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "webp", "jp2", "pnm",
]);

let cachedBinary;      // undefined = not looked yet, null = looked and absent
let cachedAt = 0;

/**
 * How long a NEGATIVE detection result is trusted.
 *
 * A positive result is cached for the life of the process -- a binary that
 * exists does not stop existing, and spawning `tesseract --version` per file
 * is real cost.
 *
 * A negative one MUST expire, and not doing so was a real bug: the first
 * failed lookup cached "absent" permanently, so installing Tesseract while the
 * app was running had no effect whatsoever. The Photos page went on saying
 * "no OCR engine is installed" against a machine where it plainly was, and the
 * only cure was a restart that the message never mentioned. Re-checking every
 * 30 seconds costs one process spawn per half-minute in the only situation
 * where it matters -- when the engine is missing -- and lets an install take
 * effect on its own.
 */
const NEGATIVE_CACHE_MS = 30_000;

function run(binary, args, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Find the tesseract binary, or report that there is none.
 *
 * Cached after the first look because this is called per file and spawning a
 * process to ask "are you there" thousands of times is real cost. The cache is
 * clearable so installing tesseract does not require restarting the worker.
 */
async function detect({ force = false } = {}) {
  if (!force && cachedBinary !== undefined) {
    // Positive: trusted indefinitely. Negative: re-checked once it goes stale,
    // so installing the engine does not require restarting anything.
    const stale = cachedBinary === null && Date.now() - cachedAt > NEGATIVE_CACHE_MS;
    if (!stale) {
      return cachedBinary
        ? { available: true, ...cachedBinary }
        : { available: false, reason: NOT_INSTALLED };
    }
  }

  for (const candidate of CANDIDATE_PATHS) {
    try {
      const { stdout } = await run(candidate, ["--version"], { timeout: 10000 });
      const version = String(stdout).split("\n")[0].trim();

      let languages = [];
      try {
        const listed = await run(candidate, ["--list-langs"], { timeout: 10000 });
        languages = String(listed.stdout).split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
      } catch {
        // Older builds print the list on stderr, and some report a non-zero
        // exit for it. Not knowing the language list is not a reason to
        // refuse to OCR -- tesseract itself will complain clearly if a
        // requested language is missing.
      }

      cachedBinary = { binary: candidate, version, languages };
      cachedAt = Date.now();
      return { available: true, ...cachedBinary };
    } catch {
      // Try the next candidate. ENOENT here is the normal case, not an error.
    }
  }

  cachedBinary = null;
  cachedAt = Date.now();
  return { available: false, reason: NOT_INSTALLED };
}

const NOT_INSTALLED =
  "No OCR engine is installed. Atlas uses Tesseract, which is a separate one-time install:\n" +
  "  Windows:  winget install --id UB-Mannheim.TesseractOCR\n" +
  "  macOS:    brew install tesseract tesseract-lang\n" +
  "  Debian:   sudo apt install tesseract-ocr tesseract-ocr-fra tesseract-ocr-ara\n" +
  "Then restart the worker. If it is installed somewhere unusual, set TESSERACT_PATH " +
  "to the full path of the executable.";

/** Which languages this install can actually read. */
async function availableLanguages() {
  const found = await detect();
  return found.available ? found.languages : [];
}

/**
 * Warn about a requested language the install does not have.
 *
 * Worth its own check because the failure is quiet and damaging: tesseract
 * errors out on a missing language, and a naive retry without it "succeeds"
 * by reading an Arabic document as if it were English, producing plausible
 * Latin gibberish that then gets used to name the file.
 */
async function missingLanguages(requested = DEFAULT_LANGUAGES) {
  const have = new Set(await availableLanguages());
  if (have.size === 0) return [];   // could not enumerate; let tesseract judge
  return requested.split("+").filter((lang) => !have.has(lang));
}

/**
 * The requested languages this install can actually read.
 *
 * DEGRADED, NOT REFUSED -- and the first version got this wrong.
 *
 * The default request is fra+ara+eng, because the archive this was built for
 * is French and Arabic. A stock Windows Tesseract ships with `eng` only. The
 * first version refused to run at all when ANY requested language was missing,
 * so a perfectly readable English receipt got no OCR because French was
 * unavailable -- giving the user nothing in the name of protecting them.
 *
 * The danger being guarded against is real but narrower: reading an ARABIC
 * scan with an English model produces confident Latin nonsense that then gets
 * used to name the file. The guard against that is not refusing to work; it is
 * (a) using only languages that are actually present, and (b) recording which
 * were skipped, so a bad reading is attributable rather than mysterious.
 *
 * Refusal is kept for the one case where it is the only option: none of the
 * requested languages are installed at all.
 */
async function effectiveLanguages(requested = DEFAULT_LANGUAGES) {
  const have = new Set(await availableLanguages());
  const asked = requested.split("+").map((l) => l.trim()).filter(Boolean);

  // Could not enumerate (some builds print the list to stderr) -- pass the
  // request through and let tesseract itself be the judge.
  if (have.size === 0) return { usable: requested, skipped: [] };

  return {
    usable: asked.filter((lang) => have.has(lang)).join("+"),
    skipped: asked.filter((lang) => !have.has(lang)),
  };
}

/**
 * Confidence, averaged over recognised words.
 *
 * Read from tesseract's TSV output rather than guessed at. Low confidence is
 * NOT treated as failure -- it is the signal that a human should look at the
 * picture, which is exactly what the Photos workspace is for. Suppressing a
 * low-confidence result would leave the user with nothing to judge.
 */
function parseConfidence(tsv) {
  const lines = String(tsv).split("\n").slice(1);
  const scores = [];
  for (const line of lines) {
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    const conf = Number(cols[10]);
    const text = (cols[11] || "").trim();
    if (text && Number.isFinite(conf) && conf >= 0) scores.push(conf);
  }
  if (scores.length === 0) return { confidence: null, wordCount: 0 };
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { confidence: Math.max(0, Math.min(1, mean / 100)), wordCount: scores.length };
}

/**
 * Recognise text in one image file.
 *
 * @param {string} imagePath - an absolute path to a real image on this disk
 * @param {object} [opts]
 * @param {string} [opts.languages]
 * @returns {Promise<{ok: boolean, text?: string, confidence?: number|null,
 *   engine?: string, engineVersion?: string, languages?: string,
 *   reason?: string, permanent?: boolean}>}
 */
async function recognizeImage(imagePath, { languages = DEFAULT_LANGUAGES } = {}) {
  const found = await detect();
  if (!found.available) {
    // `permanent: false` on purpose. The engine being absent is not a property
    // of this document -- installing tesseract and retrying is exactly the
    // fix, so this must not burn the file's retry budget or mark it terminally
    // failed.
    return { ok: false, reason: found.reason, permanent: false, unavailable: true };
  }

  const { usable, skipped } = await effectiveLanguages(languages);
  if (!usable) {
    return {
      ok: false,
      permanent: false,
      reason:
        "Tesseract is installed but has no data for any of the requested languages " +
        `(${languages.split("+").join(", ")}). Install at least one matching language pack, or set ` +
        "OCR_LANGUAGES to a language this install actually has.",
    };
  }

  // tesseract writes <base>.txt / <base>.tsv rather than to stdout when asked
  // for more than one output, so it needs a scratch base path.
  const base = path.join(os.tmpdir(), `atlas-ocr-${crypto.randomBytes(8).toString("hex")}`);
  try {
    await run(found.binary, [imagePath, base, "-l", usable, "txt", "tsv"]);

    const [text, tsv] = await Promise.all([
      fsp.readFile(`${base}.txt`, "utf8").catch(() => ""),
      fsp.readFile(`${base}.tsv`, "utf8").catch(() => ""),
    ]);

    const { confidence, wordCount } = parseConfidence(tsv);
    return {
      ok: true,
      text: text.trim(),
      confidence,
      wordCount,
      engine: "tesseract",
      engineVersion: found.version,
      // What was ACTUALLY used, not what was asked for. Recorded on the file
      // so a poor reading can be traced to a missing language pack rather than
      // looking like the document itself was unreadable.
      languages: usable,
      skippedLanguages: skipped,
    };
  } catch (err) {
    const stderr = String(err.stderr || "").trim();
    return {
      ok: false,
      // A timeout or a crash on one image is not a reason to give up on the
      // format forever, so these stay retryable; the per-stage retry counter
      // in pipelineState is what eventually stops them.
      permanent: false,
      reason: stderr || err.message || "Tesseract failed without an error message.",
    };
  } finally {
    await Promise.all([
      fsp.rm(`${base}.txt`, { force: true }).catch(() => {}),
      fsp.rm(`${base}.tsv`, { force: true }).catch(() => {}),
    ]);
  }
}

/** True when tesseract can read this file without rasterisation first. */
function isDirectlyReadable(extension) {
  return DIRECT_IMAGE_EXTENSIONS.has(String(extension || "").toLowerCase().replace(/^\./, ""));
}

/** Clears the binary cache, so installing tesseract takes effect without a restart. */
function resetDetection() {
  cachedBinary = undefined;
  cachedAt = 0;
}

module.exports = {
  DEFAULT_LANGUAGES, DIRECT_IMAGE_EXTENSIONS, NOT_INSTALLED,
  detect, availableLanguages, missingLanguages, effectiveLanguages,
  recognizeImage, isDirectlyReadable, resetDetection, parseConfidence,
};
