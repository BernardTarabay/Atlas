# Document Management & Intelligent File Organization Platform

Point a folder at it and it works out what everything is, files it, proposes better
names, and lets you find any of it again by describing it from memory. Original files
are never renamed, moved or deleted — canonical names live in the database and the
organized view is a disposable tree of shortcuts.

Status: **Phases 1–12 complete** (Domain Analysis → Terminology → Taxonomy →
Storage Architecture → Database Model → Processing Pipeline → Background Jobs →
Auth/RBAC → API Contracts → Controllers/Services/Routes → React Frontend →
Electron Filesystem Agent), plus substantial post-Phase-11 work:

- **Find a file by describing it** (`docs/06 §6.8`) — every file gets a plain-language
  description of what it *is*, and search matches that description by **meaning**, not
  just words. "the photo of a kid blowing out birthday candles" finds a picture whose
  description reads "a child at a party with a cake", and an English phrase finds a
  French or Arabic document. Photos are described by a vision model, videos and audio
  are actually watched and listened to, and files nothing can read get a facts-only
  description that says so rather than inventing contents.
- **Per-user ownership** (migration 028) — ownership is in the schema and every
  repository read is scoped by it, not filtered at the route layer. Verified by
  `scripts/verify-ownership.js`.
- **A real file lifecycle** (migration 032) — pipeline position is recorded rather
  than inferred from four different predicates, with per-stage retry counts, so a
  retried file can be proven to be making progress instead of silently bouncing back
  into triage forever.
- **OCR** (`services/ocr/`) — scans and photographs are read, with a confidence floor
  below which the text is shown but never used to name a document.
- **Devices and replicas** (migration 030) — organization is cross-device; file
  *content* is not, and that gap is now modelled explicitly instead of papered over.
- **A taxonomy that can grow** (migration 029) — no longer a fixed three levels, and
  folders the assistant proposed are marked as its idea rather than presented as
  yours.
- **AI classification escalation tier** (`docs/09-ai-classification.md`) — when the
  rule-based classifier isn't confident and `GEMINI_API_KEY` is set, a Gemini pass
  produces a specific title, one-line summary and extracted entities. Entirely
  opt-in; unset the key and the pipeline behaves exactly as it did before.
- **Email inbox triage** (`docs/10-email-inbox.md`) — connect Gmail, auto-trash
  clutter, surface the rest on a read-only Inbox page.
- **Probable-duplicate and version detection** — content similarity short of a hash
  match, as reviewable suggestions that are never auto-applied.
- **Legacy Office extraction** — `.doc`/`.xls`/`.ppt` are now fully extracted.

Everything AI here is optional. With no `GEMINI_API_KEY` the rule-based classifier,
the full pipeline and keyword search all work exactly as before; description search
degrades to keyword-only rather than failing.

## What's here

```
docs/
  01-domain-model.md          File vs Document vs Version vs Metadata vs Identity
  02-terminology.md           Controlled vocabulary for the whole project
  03-taxonomy.md              Subject/Category/Subcategory + naming convention
  04-storage-architecture.md  Storage Location / Filesystem Agent design
  05-database-schema.md       ERD + rationale for the schema
  06-processing-pipeline.md   Stage sequence, idempotency, retry/failure rules
  07-supported-formats.md     What's actually extractable per format, and why
  08-api-contracts.md         Resource/endpoint map, permission per route
  09-ai-classification.md     The optional Gemini escalation tier
  10-email-inbox.md           Gmail triage design
  11-remote-access.md         Reaching it from other devices, and installability

backend/
  migrations/     35 numbered, forward-only SQL files. Each one opens with why it
                  exists -- these are the best explanation of the design decisions
  seeds/          Reference data (RBAC roles/permissions, starter taxonomy)
  scripts/        20 verify-*.js live end-to-end checks against real Postgres
  tests/          node --test, no new dependencies (see tests/README.md)
  src/
    config/       env validation, pg Pool
    db/           migrate.js / seed.js / resetData.js / Reclassify.js runners
    models/       enums.js -- JS mirror of the Postgres enum types
    repositories/ one file per entity group -- the only layer that talks to pg
    services/
      storage/      StorageService interface + LocalStorageService (direct)
                    + AgentStorageService (brokered through a Filesystem Agent)
      extraction/   per-format extractors (pdf/xlsx/docx/pptx/pbix)
                    + ole/ for legacy .doc/.xls/.ppt
                    + textQuality.js -- decides whether extracted text is usable
                    at all, which gates naming, classification and description
      ocr/          engine detection, PDF rasteriser, and the OCR pass itself
      email/        Gmail OAuth and API client (raw fetch, no SDK)
      ai/           geminiClassifier, geminiChatService, emailTriageClassifier,
                    imageDescriber (what a picture shows), mediaDescriber (video
                    and audio), textSummariser, embeddingService (search vectors),
                    rateLimiter -- ONE outgoing-call budget shared by all of them
      preview/      LibreOffice-backed thumbnails
      descriptionService.js        every file gets a description, from whichever
                                   evidence it offers
      descriptionSearchService.js  meaning + wording + content, fused by RRF
      pipelineState.js             the file lifecycle as an explicit state machine
      similarityService.js  shingle/Jaccard engine for duplicates + versions
      agentService.js       Filesystem Agent lifecycle and operation brokering
      hashingService.js, namingService.js, authService.js, and one service
      per API resource
    utils/        fileSignature.js, cfb.js (OLE container), pathSafety.js,
                  tokenCrypto.js, jwt.js, passwords.js, pagination.js, ...
    middleware/   authenticate.js (user JWT), authenticateAgent.js (agent JWT),
                  requirePermission.js (RBAC), rateLimiters.js, asyncHandler.js
    controllers/  thin HTTP-shaping layer, one per resource
    routes/       one file per resource, mounted in app.js under /api/*
    queues/       enqueueJob() + pgQueue.js -- the queue IS the processing_jobs row
                  (migration 040; no Redis, no broker)
    jobs/         job_type -> processor registry, runProcessingJob() lifecycle wrapper
      processors/ scan, hash, extract_metadata, extract_text, classify, ocr,
                  describe, detect_duplicates, detect_versions, generate_names,
                  bulk_rename, bulk_delete, auto_resolve_duplicates,
                  email_sync, sync_mirror, reindex
    workers/      runner.js -- separate worker process, `npm run worker`

frontend/         React 18 + Vite + Tailwind v4 SPA
  src/
    services/apiClient.js   thin fetch wrapper, attaches JWT, retries once on 401
    context/                AuthContext, ToastContext
    components/             TopNav, Layout, Modal, ConfirmDialog, preview and
                            folder-import components, AssistantPanel, SearchSnippet,
                            MoveFileModal / MoveManyModal, DuplicateFindings, ...
    pages/                  Login, Register, Dashboard, Files, Photos, Documents,
                            Subjects, Triage, DuplicateGroups, RenameProposals,
                            ProcessingJobs, StorageLocations, Devices, AuditLog,
                            Users, Inbox

desktop-agent/    Electron Filesystem Agent (Phase 12) -- see its own README
  src/            main/preload/renderer + the poll-execute-report runner
  tests/          path-guard and operation tests (no Electron needed)
```

## Running it

Two processes: the API and the worker pool. Both need Postgres reachable -- and only
Postgres: the job queue lives in `processing_jobs`, so there is no Redis to install
(migration 040).

```bash
cd backend
cp .env.example .env         # DATABASE_URL, JWT secrets
npm install
npm run db:migrate           # applies backend/migrations/*.sql
npm run db:seed              # loads backend/seeds/*.sql (idempotent)

npm run dev                  # terminal 1: API on :5000, GET /api/health checks the DB
npm run worker               # terminal 2: starts every job worker against Postgres
```

**`npm run dev` only watches the API.** The worker is not under nodemon, so after
changing anything it runs — extraction, OCR, classification, naming, description —
restart it by hand or it keeps running the old code.

```bash
cd frontend
npm install
npm run dev                  # terminal 3: UI on :5173, proxies /api to :5000 in dev
```

Register through the UI at `/register`. A brand-new database has no users with
elevated permissions — the first registered user gets the `User` role only. To grant
`Admin`, run once against your database:

```sql
INSERT INTO user_roles (user_id, role_id)
SELECT '<your-user-id>', id FROM roles WHERE name = 'Admin';
```

**Seeds are not auto-applied on migrate.** Permissions added after your database was
first seeded — `subject.manage`, `email.manage`, `agent.manage` — require re-running
`npm run db:seed` before the corresponding nav items and endpoints become reachable.

To try the pipeline end to end through the API (see `docs/08-api-contracts.md` for
the full route list):

```bash
curl -X POST http://localhost:5000/api/storage-locations \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"name":"My Repo","type":"local","rootPath":"/path/to/folder","accessMode":"direct"}'

curl -X POST http://localhost:5000/api/storage-locations/<id>/scan \
  -H "Authorization: Bearer <token>"
# -> discovers files, which cascade through hash -> metadata/text extraction (or
#    OCR for scans and photos) -> duplicate + version detection -> classification
#    -> naming proposal -> description
```

Then find something without knowing what it is called:

```bash
curl -G http://localhost:5000/api/files \
  -H "Authorization: Bearer <token>" \
  --data-urlencode "q=the photo of a kid blowing out birthday candles"
# -> each result carries match_reasons ("by meaning" / "in its description" /
#    "in content") and, for a semantic hit, a 0-1 similarity
```

Files that predate the describe stage need one backfill pass:

```bash
cd backend && node scripts/backfill-descriptions.js
```

## Reaching it from another device

The API serves the built UI, so on the host machine Atlas is one address and one
double-click (`scripts/install-autostart.ps1` registers a logon task and a desktop
shortcut). Other devices were told to open `http://192.168.1.101:5000`, which moves
with the DHCP lease, only works on that LAN, and — because it is not a secure
context — prevents the service worker from registering at all, so Atlas can never be
installed on a phone.

`tailscale serve` fixes all three: a stable name with a real certificate, reachable
from any device on the tailnet, nothing exposed to the public internet.

```powershell
.\scripts\install-tailscale-serve.ps1          # prints https://<machine>.<tailnet>.ts.net
```

Requires Tailscale installed and signed in, with MagicDNS and HTTPS Certificates
enabled for the tailnet — the script checks each precondition separately and names
the one that failed. Full rationale, including why this is not solved by becoming a
desktop app, is in `docs/11-remote-access.md`.

Once it is served over HTTPS, Atlas is installable: Chromium offers *Install app*,
iOS Safari offers *Add to Home Screen*, and both run it in its own window with no
URL bar.

## Tests

```bash
cd backend && npm test          # 281 tests
cd desktop-agent && npm test    # 16 tests
```

Node's built-in runner, no new dependencies. All pure unit tests — no live Postgres,
or network — so they run in about a second and can't fail for environmental
reasons. `backend/tests/README.md` explains what's covered, what deliberately isn't
(the AI tiers, repositories, the job pipeline, the frontend), and why.

Beyond those, 19 `verify-*` scripts drive the real services, because the bugs that
matter most here are silent: a query missing its owner predicate, a search that
returns confident nonsense, a retried file that quietly returns to triage. None of
those throw, so only an end-to-end assertion catches them.

```bash
cd backend
node scripts/verify-ownership.js            # two accounts, zero leakage
node scripts/verify-descriptions.js         # every file describable and findable
node scripts/verify-triage.js               # the triage queue's reasons
node scripts/verify-duplicate-compare.js    # duplicate group inspect/compare
node scripts/verify-search-filters.js       # filters agree across all four query paths
node scripts/verify-known-content-skip.js   # a second overlapping folder is cheap
npm run verify:agent                        # full Filesystem Agent loop
```

The newer scripts pause the queue while they set fixtures up
(`scripts/_fixtureQueue.js`) and resume on the way out — without that, a live worker
processes the fixtures out from under the assertions. Run the older ones with the
worker stopped.

## What was verified against real services

Nothing here was verified in the abstract — everything was run against real
PostgreSQL, not mocks:

- All migrations apply cleanly on an empty database; re-running is a no-op. Seeds are
  idempotent (this caught a real bug: a `UNIQUE(parent_id, slug)` constraint doesn't
  dedupe root-level taxonomy rows, since SQL never treats two `NULL`s as equal —
  fixed with a partial unique index in `005_taxonomy.sql`).
- Every repository was smoke-tested through a realistic flow.
- All content extractors were run against real generated files. This caught a real
  bug: `pdf-parse` failed with "bad XRef entry" on a perfectly valid PDF; swapped to
  `pdfjs-dist` directly.
- The legacy `.doc`/`.xls` extractors were verified by round-tripping the *same*
  document through both the modern and legacy paths — 99% word-level recall for
  `.doc`, 100% for `.xls`. That comparison caught a real bug: dropping Word's `0x07`
  cell mark fused adjacent table cells into invented tokens (`DateÉvénementSection`).
- The full pipeline was run end-to-end against a test repository: one `scan`
  fanned out to 41 downstream jobs across all queues, zero failures.
- `bulk_rename` was verified by approving a real proposal and confirming the physical
  file was renamed on disk through the `StorageService` abstraction.
- The full HTTP API was exercised with real `curl` requests, including RBAC denials
  (401/403) at every step.
- Probable-duplicate detection was validated against this repository's real content:
  34 comparable files, two genuine near-duplicate pairs found (0.99 and 0.93), zero
  false positives.
- The Filesystem Agent protocol was verified end-to-end (`npm run verify:agent`):
  every operation type through `AgentStorageService`, plus confirmation that path
  traversal and out-of-scope paths are refused on both sides.
- Per-user isolation was verified with two real accounts driving the real services
  (`verify-ownership.js`), because an unscoped query returns another account's rows
  with no error, no empty list and no 403 — it looks exactly like the feature working.
- The Gemini request/response shapes were established by calling the live API and
  trying the alternatives, not by reading for them. This mattered: referencing an
  uploaded video from the Interactions endpoint takes `uri`, while the documented-
  looking `file_uri` and `file_data: { file_uri }` are both rejected outright. Same
  for the embedding model — its 768-dimension output comes back *un-normalised*
  (measured ‖v‖ = 0.59), so anything comparing those vectors without normalising
  first is ranking partly by vector length.
- Description search was validated against real content: a rough phrase sharing
  almost no words with a description finds the right file (0.74–0.79), a French
  description matches an English query (0.72), and a phrase matching nothing returns
  nothing rather than the closest thing — the case that catches a broken threshold,
  since two unrelated texts still score ~0.55 with this model.

## Frontend verification

- `npm run build` produces a clean production bundle. This caught a real Tailwind v4
  incompatibility: `@apply` cannot reference another custom component class defined
  in the same `@layer components` block — fine in v3, rejected by v4 as an "unknown
  utility class". Fixed by inlining the shared utility list into each variant.
- A corrupted `node_modules` from an interrupted install caused a raw `Bus error` on
  `vite build`; isolated by testing a bare Vite install elsewhere, then fixed by a
  clean reinstall.
- `npm test` runs the service worker's routing rules against a fake worker global
  (`frontend/tests/sw.test.mjs`, 9 tests). A worker cannot be checked by looking at
  the app — it sits *between* the app and the network, runs only in a production
  build, and fails as stale data rather than as an error. The first test asserts the
  rule that matters: `/api` is never intercepted.
- `npm run verify:pwa -- <url>` checks the install metadata is actually installable:
  required manifest fields, icons measured from their PNG headers rather than trusted
  (a 150%-scaled display silently yields a 288px file labelled 192x192, which Chrome
  rejects without explanation), and live content-type / cache-control headers.
- No automated component tests exist yet — `npm run build` remains the only automated
  check on the React components themselves.

## Known gaps (documented, not hidden)

- **`bulk_move`** is the one `job_type` with no processor — superseded by
  `bulk_rename`, which already carries a new folder via `proposed_relative_dir`
  (docs/06 §6.1).
- **Version detection suggests, never applies.** It records a `version.suggested`
  audit entry rather than writing `document_versions` rows, because docs/01 §1.3
  forbids resolving a Version relationship without a human confirming.
- **Probable duplicates are capped at MEDIUM confidence** and are excluded from
  auto-resolve for the same reason. HIGH is reserved for provable hash matches.
- **Similarity candidate selection is bounded** (300 same-extension files per check),
  a deliberate recall/cost trade-off documented in `fileRepository`.
- **The desktop agent has no installer**, no code signing and no auto-update, and
  transfers file bytes base64-encoded in one operation result (64 MB cap) rather than
  in chunks. See `desktop-agent/README.md`.
- **The AI tiers have no unit tests** — they need a live `GEMINI_API_KEY`. Only the
  free rule tiers are unit-tested; the paid paths are covered by the `verify-*`
  scripts instead, which is a deliberate trade rather than an oversight.
- **pbix data models are not parsed** — the xVelocity blob would need the Analysis
  Services engine (docs/07).
- **Plain text has no extractor.** `.txt`, `.csv`, `.md`, `.json` and `.xml` are not
  registered in `services/extraction/index.js`, so their text is never read — they
  are invisible to content search and fall back to a facts-only description. The
  easiest format in the archive is the one that is missing.
- **Description search does not apply inside a subject branch.** Searching from the
  Subjects page still uses the older content-only ranking; only the Files page and
  the assistant get meaning-matching.
- **`pipelineState.markNeedsUser` discards its reason.** `transition()` only persists
  `failure_reason` for the two failure states, so the specific "why does this need
  me" messages never reach the database and the UI shows a generic fallback.
- **Video and audio description is capped by file size** (`AI_MEDIA_MAX_BYTES`,
  default 200 MB) as a proxy for duration, since video is billed per second of
  content. Longer recordings get a facts-only description.
- **93 mirror shortcuts fail on Windows MAX_PATH** — `WScript.Shell` refuses paths
  over 260 characters. Needs either a canonical-name length cap or `\\?\` extended
  paths.
