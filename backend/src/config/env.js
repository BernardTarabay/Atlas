// Centralized, validated environment configuration.
// Fail fast at boot rather than surfacing undefined env vars deep in a request.
require("dotenv").config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Node's built-in test runner sets this in each test child process. Used only
// to keep the advisory warning below out of the suite's output -- the hard
// failures still apply everywhere.
const IS_TEST_RUNNER = process.env.NODE_TEST_CONTEXT !== undefined;

const MIN_SECRET_LENGTH = 32;

/**
 * A secret that must not be guessable.
 *
 * `required()` above only proves a variable is SET, which was not enough: this
 * install ran in production for months with JWT_ACCESS_SECRET still set to the
 * literal "change-me-access-secret" from .env.example. Presence is not the
 * property that matters for a signing key -- unpredictability is. Anyone who
 * could reach the API and had seen this repository could mint an access token
 * for any user id and be an administrator.
 *
 * So placeholders are refused OUTRIGHT, in every environment: nothing
 * legitimate is called "change-me-...", and the one situation this has to
 * catch is someone copying .env.example and starting the server. Length is
 * only fatal in production, so a developer's throwaway value and the unit
 * tests' short fixtures still work.
 */
function secret(name, rawValue) {
  const value = required(name, rawValue);
  const generate = `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`;

  if (/change[-_ ]?me|your[-_ ]?secret|placeholder|^(secret|password|test)$/i.test(value)) {
    throw new Error(
      `${name} is still set to a placeholder value ("${value}"). This is a signing key -- ` +
      `anyone who guesses it can forge a session for any account. Generate a real one:\n  ${generate}`
    );
  }

  if (value.length < MIN_SECRET_LENGTH) {
    const message =
      `${name} is only ${value.length} characters; at least ${MIN_SECRET_LENGTH} are needed for a signing key. ` +
      `Generate one with:\n  ${generate}`;
    if ((process.env.NODE_ENV || "development") === "production") throw new Error(message);
    if (!IS_TEST_RUNNER) console.warn(`[env] WARNING: ${message}`);
  }

  return value;
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "5000", 10),

  databaseUrl: required("DATABASE_URL"),
  pgSsl: process.env.PGSSL === "true",

  /**
   * How long Trash holds a document before it is removed for good.
   *
   * A window, not a setting to tune for performance: it is the period in which
   * "I did not mean that" is still recoverable. Thirty days is the same promise
   * most desktop recycle bins make, which matters because that is the
   * expectation people arrive with.
   */
  trash: {
    retentionDays: Math.max(1, parseInt(process.env.TRASH_RETENTION_DAYS || "30", 10) || 30),
  },

  /**
   * How long the record of WORK is kept, as opposed to the work's results.
   *
   * `processing_jobs` and `audit_logs` are the only two tables that grow with
   * how many times something happened rather than with how many documents
   * exist, and nothing deleted from either -- 5.2 GB of a 5.4 GB database on
   * this installation, behind a 48 MB library. See migration 045.
   *
   * These are windows in which a question is still answerable, not tuning
   * knobs. Completed jobs answer "what did the pipeline do this week", which
   * nobody asks about last month. Failures answer "why did this break", which
   * people genuinely do ask about weeks later, so they are kept ten times
   * longer and are three orders of magnitude rarer anyway.
   *
   * Telemetry is per-file mechanical noise ("this file was hashed") on an
   * explicit allowlist. The audit RECORD -- sign-ins, downloads, renames,
   * deletions -- has no retention here and is never removed by this sweep.
   */
  retention: {
    completedJobDays: Math.max(1, parseInt(process.env.RETENTION_COMPLETED_JOB_DAYS || "7", 10) || 7),
    failedJobDays: Math.max(1, parseInt(process.env.RETENTION_FAILED_JOB_DAYS || "30", 10) || 30),
    telemetryDays: Math.max(1, parseInt(process.env.RETENTION_TELEMETRY_DAYS || "30", 10) || 30),
  },

  /**
   * Filing the unfiled pile automatically, and inventing the folders it needs.
   *
   * ON BY DEFAULT, deliberately. The feature had a button and nothing else,
   * which meant a client who did not know to press it got an archive where a
   * large share of documents sat in Unfiled forever -- the folder each needed
   * did not exist, and the classifier cannot create one. A capability nobody
   * discovers is not a feature.
   *
   * It is also the only scheduled thing here that SPENDS MONEY per run, so
   * every number below is a limit rather than a tuning knob. See
   * jobs/organizeUnfiledScheduler.js for what each one is protecting against.
   */
  organizeUnfiled: {
    enabled: process.env.ORGANIZE_UNFILED_AUTO !== "false",
    // Below this, leave it alone: a small residue is the planner correctly
    // declining to guess, not a backlog.
    threshold: Math.max(1, parseInt(process.env.ORGANIZE_UNFILED_THRESHOLD || "50", 10) || 50),
    intervalMinutes: Math.max(5, parseInt(process.env.ORGANIZE_UNFILED_INTERVAL_MINUTES || "60", 10) || 60),
    // ~600 files per run at the planner's batch size.
    batchesPerRun: Math.max(1, parseInt(process.env.ORGANIZE_UNFILED_BATCHES_PER_RUN || "5", 10) || 5),
    // The ceiling that does not depend on the pile ever emptying: 8 runs x 5
    // batches x 120 files is ~4,800 files a day, so even a very large import
    // is organized within days rather than in one unbounded overnight bill.
    maxRunsPerDay: Math.max(1, parseInt(process.env.ORGANIZE_UNFILED_MAX_RUNS_PER_DAY || "8", 10) || 8),
  },

  /**
   * Who is allowed to create an account.
   *
   * WHY THIS EXISTS
   *
   * `POST /api/auth/register` was unauthenticated and open, and the role it
   * assigns ("User") carries `storage.manage` and `scan.run`. Combined with a
   * folder picker that defaults to unconfined, anyone who could reach the port
   * could: register an account, enumerate the server's entire filesystem,
   * register C:\Users\<someone> as their own storage location, scan it, and
   * then read every document in it -- as its legitimate owner.
   *
   * The ownership model did not stop this and could not. `ownership.js` is
   * exemplary at preventing account A from reading account B's ROWS; the
   * attacker never touches anyone else's rows. They create their own, over the
   * same bytes on disk. Ownership was modelled on the database record; the
   * asset is the filesystem.
   *
   * WHY CLOSING REGISTRATION RATHER THAN NARROWING THE ROLE
   *
   * The obvious fix -- strip `storage.manage` from the default role -- is wrong
   * here and would have broken this install. The only account on it holds
   * exactly that role, so narrowing the role removes the owner's ability to
   * manage their own storage locations. The permission is not the bug. Handing
   * it to unauthenticated strangers is.
   *
   *   first-run  registration works while there are ZERO accounts, and is
   *              refused afterwards. The first request bootstraps the owner;
   *              nothing else gets in. This is the honest default for a
   *              self-hosted archive of one person's documents.
   *   open       the old behaviour. Anyone who can reach the API can register.
   *   closed     no registration at all, ever, including the first.
   *
   * To add a second person deliberately: set ALLOW_REGISTRATION=open, register
   * them, set it back. Clunky on purpose -- adding an account to a private
   * document archive should be an act, not an availability.
   */
  registration: {
    mode: ["first-run", "open", "closed"].includes(process.env.ALLOW_REGISTRATION)
      ? process.env.ALLOW_REGISTRATION
      : "first-run",
  },

  jwt: {
    accessSecret: secret("JWT_ACCESS_SECRET"),
    refreshSecret: secret("JWT_REFRESH_SECRET"),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  },

  bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || "12", 10),


  // Optional: unset simply means no Filesystem Agent can connect (agentService
  // throws a clear message at first use). But if it IS set, it is a signing
  // key and gets the same placeholder/length treatment as the two above.
  agentJwtSecret: process.env.AGENT_JWT_SECRET
    ? secret("AGENT_JWT_SECRET")
    : undefined,

  // Where the organized shortcut tree is built (docs: the "mirror"). Every
  // entry in it is a shortcut to a file that stays where it already lives,
  // so this folder is disposable -- deleting it loses nothing and
  // `sync_mirror` rebuilds it. Unset means the mirror is simply not built.
  mirrorRoot: process.env.MIRROR_ROOT || null,

  // Real-time ingestion. The watcher notices new/changed files in watched
  // storage locations; the periodic rescan is the safety net for events
  // missed while the machine was asleep or a drive was unplugged.
  watch: {
    enabled: process.env.WATCH_ENABLED !== "false",
    // Wait for writes to settle before ingesting -- a file being copied in
    // fires many events and is incomplete until the last one.
    debounceMs: parseInt(process.env.WATCH_DEBOUNCE_MS || "4000", 10),
    rescanIntervalMinutes: parseInt(process.env.WATCH_RESCAN_INTERVAL_MINUTES || "60", 10),
  },

  // Ceiling on how large a file may be before the two extraction stages
  // refuse to open it.
  //
  // Both stages read the WHOLE file into a Buffer (utils/streamToBuffer), and
  // Buffer.concat transiently holds two copies. They also run on separate
  // queues, so the same file is buffered twice simultaneously, four-wide
  // each. There was no limit of any kind: one very large file in a corpus
  // measured in hundreds of GB was enough to OOM the worker process -- which
  // hosts all fourteen queues, so it took every other in-flight job with it.
  //
  // Over-size files are recorded as 'skipped' with a reason rather than
  // silently ignored, so they appear in triage instead of looking processed.
  extraction: {
    maxBytes: parseInt(process.env.MAX_EXTRACTION_BYTES || String(256 * 1024 * 1024), 10),
  },

  // Auto-apply naming without human review. Only ever consulted for
  // locations that also have auto_apply_naming enabled, and only meaningful
  // for read-only locations, where applying a name touches the mirror
  // rather than the original file.
  autoApply: {
    minConfidence: process.env.AUTO_APPLY_MIN_CONFIDENCE || "high",
  },

  // Where the browser lives -- used only to build the final redirect after
  // an OAuth callback finishes server-side (the provider itself only ever
  // talks to the backend's own callback URL, never this one directly).
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",

  // Encrypts email_accounts.refresh_token_encrypted at rest -- see
  // utils/tokenCrypto.js. Required before any email account can be
  // connected; deliberately NOT defaulted (unlike most of this file) since
  // a default here would mean every uninitialized install shares the same
  // encryption key.
  // Empty/unset stays undefined so tokenCrypto can fail loudly at first use
  // rather than silently encrypting with a shared default. A key that IS
  // present goes through the same placeholder check as the JWT secrets --
  // this one protects real mailbox refresh tokens at rest.
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY
    ? secret("TOKEN_ENCRYPTION_KEY")
    : undefined,

  // Email inbox triage (docs/10-email-inbox.md). Gmail is the only provider;
  // the Outlook/Microsoft Graph one was removed. It is OAuth2-only -- there is
  // no password-based path -- so an app must be registered in Google Cloud
  // Console before any account can be connected. Leaving clientId unset means
  // "Connect Gmail" 400s with a clear message; it blocks nothing else.
  email: {
    syncIntervalMinutes: parseInt(process.env.EMAIL_SYNC_INTERVAL_MINUTES || "15", 10),
    google: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    },
  },

  // AI classification escalation tier (see docs/09-ai-classification.md).
  // Entirely opt-in: unset GEMINI_API_KEY and the classifier stage behaves
  // exactly as it did before this feature existed (rule-based only).
  ai: {
    enabled: Boolean(process.env.GEMINI_API_KEY) && process.env.AI_CLASSIFICATION_ENABLED !== "false",
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
    // Separate knob for the Subjects-page chatbot (docs/08-api-contracts.md
    // §9.10) -- conversational tool-selection benefits from a bit more
    // headroom than the bounded, single-shot classification task above, but
    // defaults to the exact same model/key so the feature works out of the
    // box for anyone who already set GEMINI_API_KEY for classification.
    chatModel: process.env.GEMINI_CHAT_MODEL || process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
    // Only escalate to the LLM when the rule-based pass wasn't confident --
    // a clean keyword match doesn't need an API call to confirm.
    escalateBelowConfidence: process.env.AI_ESCALATE_BELOW_CONFIDENCE || "high",
    // AI_DAILY_CALL_CAP IS GONE, DELIBERATELY.
    //
    // It was one env var enforced three different ways: classifyProcessor
    // counted only `ai_classification.called`, ocrService counted only
    // `ai_image_description.called`, and descriptionService counted the sum of
    // all three. So a "500-call cap" let through 1,003 calls in a day -- each
    // stage correctly reporting it had stayed inside the limit -- while the
    // description stage, the only one measuring the true total, starved four
    // seconds into a scan and left 6,953 files undescribed.
    //
    // The fix is not a fourth counting rule. A cap that silently converts
    // "your files are being processed" into "6,953 files failed" is worse than
    // no cap: the work still needs doing, the user still wants it done, and
    // the failure surfaces as a broken pipeline rather than a budget decision.
    // Spend stays visible in the audit log (BILLED_AI_ACTIONS in
    // descriptionService), which is the honest place for it -- reporting, not
    // refusing.
    timeoutMs: parseInt(process.env.AI_REQUEST_TIMEOUT_MS || "20000", 10),
    // CLIENT-SIDE PACING IS OFF BY DEFAULT. 0 = no artificial throttle.
    //
    // This used to default to 12 requests/minute, chosen to sit under the free
    // tier's 15. That is the same mistake as the daily cap one comment up,
    // just measured per minute instead of per day: it is this application
    // inventing a limit and then failing its own work against it. At 12/min a
    // 5,730-file recovery takes eight hours, and the pipeline spends that time
    // looking stalled.
    //
    // The real limit belongs to Google and Google enforces it -- a 429 comes
    // back carrying "Please retry in 25.054123681s", and every AI caller here
    // already honours that hint and retries (see parseRetryDelayMs in
    // services/ai/rateLimiter.js). That is genuine backpressure measured
    // against the real quota, rather than a guess at it. Guessing low only
    // slows down work that would have been allowed.
    //
    // Set GEMINI_RATE_LIMIT_PER_MINUTE to a positive number to opt back into
    // client-side pacing on a constrained key. Nothing sets it by default.
    rateLimitPerMinute: parseInt(process.env.GEMINI_RATE_LIMIT_PER_MINUTE || "0", 10),
  },
};

module.exports = env;
