# 13. Things That Will Bite You

Facts about this codebase and this corpus that are not derivable from reading
the code, each one learned by getting it wrong first. Kept as documentation
rather than as commit messages because every one of them will cost somebody a
day if they meet it fresh.

For running and recovering the server, see `docs/12-server-operations.md`.

---

## 13.1 The corpus

**It is French and Arabic.** Any text handling has to survive both, and several
real bugs came from exactly this: OLE titles decoded as latin1 rather than the
declared code page, PowerShell treating U+2019 as a string delimiter,
`WScript.Shell` refusing non-ANSI paths, NUL bytes killing Postgres inserts.
Nothing that touches a filename or extracted text should be tested only against
ASCII.

**Boilerplate titles are everywhere.** 403 files carry the organisation's name
as their embedded document title. A title shared by five or more files is
ignored for naming — otherwise hundreds of documents end up with the same name.

**Most filenames mean nothing.** Camera and WhatsApp exports dominate
(`WhatsApp Image 2026-07-29 at 20.17.33.jpeg`). This is why the AI assistant
matches on the *description* before the filename, and why an interface that
only lets you search names is not usable on this archive.

## 13.2 The database runs in `Asia/Jerusalem`

`document_date` is `timestamptz`. A date-only source — EXIF, a PDF header —
normalises to **local** midnight, which is 22:00 the previous day in UTC.

So any date comparison must go through `::date`, never a pinned UTC instant, or
it silently drops the whole first day of a range. 232 real files sit in that
window. This is already handled in `repositories/fileFilters.js`; the trap is
live for anything else that filters or buckets by date.

## 13.3 Rules the pipeline will not break

- **Originals are never renamed, moved or deleted.** Canonical names live in
  the database; the shortcut mirror is disposable and regenerable. The one
  exception is §13.5.
- **Never let the AI name a file from unreadable text.** `textQuality.js`
  decides; `generateNamesProcessor` keeps the original filename when it says no.
- **A rejected rename is a FINISHED state, not a problem.** Rejecting means
  "the name this file already has is the right one". The file is still filed
  under its subject and still appears in the mirror under its original name.
  The Files page labels it *original name kept* — do not reintroduce anything
  that sends the user back to re-decide it.
- **"Location" means storage location and folder path, not EXIF GPS.** GPS is
  on phone photos and essentially absent from scanned documents, so a GPS
  filter over this corpus would match nothing. If it is ever wanted it is a
  second filter, not a reinterpretation of this one.

## 13.4 What the AI actually costs

`AI_ESCALATE_BELOW_CONFIDENCE=always`, so every file with usable text calls
Gemini unless it has a byte-identical twin.

Measured on the real corpus: **516 calls, ~$0.12, ≈$0.00023 per call.** A full
9,398-file run is about **$2.20**.

**There is no artificial cap, and that is deliberate.** `AI_DAILY_CALL_CAP` was
removed, and the reason is worth knowing before anyone reintroduces one: it was
a single env var enforced three different ways. `classifyProcessor` counted only
`ai_classification.called`, `ocrService` counted only
`ai_image_description.called`, and `descriptionService` counted the sum of all
three. A "500-call cap" therefore let through 1,003 calls in a day — each stage
correctly reporting it had stayed inside the limit — while the description
stage, the only one measuring the true total, starved four seconds into a scan
and left **6,953 files undescribed**.

The fix was not a fourth counting rule. A cap that silently converts "your files
are being processed" into "6,953 files failed" is worse than no cap: the work
still needs doing, and the failure surfaces as a broken pipeline rather than as
a budget decision.

So the real quota belongs to Google and Google enforces it — a 429 comes back
carrying `Please retry in 25.054123681s`, and every AI caller honours that hint
and retries (`services/ai/rateLimiter.js`). That is backpressure measured
against the actual limit instead of a guess at it.

**Spend is visible rather than restricted.** Every billed call is written to the
audit log (`BILLED_AI_ACTIONS` in `services/descriptionService.js`);
`node scripts/measure-ai-cost.js` summarises it. Watch the number rather than
capping it. `GEMINI_RATE_LIMIT_PER_MINUTE` exists for a deliberately
constrained key and defaults to `0` (no throttle).

## 13.5 Deleting originals — the client's request, and why it is not built

The client wants files deleted from their source folder once Atlas has
organised them. **This is data loss, and the reason is stronger than "what if
the pipeline has a bug".**

Atlas holds no bytes. `getDownloadStream` streams from the *original* file
where it lies, and the organized folder is `.lnk` shortcuts pointing at it.
Delete the source and the document is gone: the shortcut dangles, download and
preview 404, and the name, subject and description survive describing a file
that no longer exists. A file can complete every pipeline stage perfectly and
still be destroyed this way, because finishing the pipeline never produces a
second copy. This codebase deliberately moved *away* from holding bytes —
`folderImportService` and the upload zones were removed for exactly that reason.

What exists instead is **redundant-copy deletion**, which is provably lossless:
it only ever removes a file whose exact bytes exist elsewhere, and only after
re-reading and re-hashing the survivor (`services/redundantCopyService.js`,
proved by `scripts/verify-redundant-copy-deletion.js`).

The full request needs one of:

| | |
|---|---|
| **vault** | Atlas copies each file into storage it owns, verifies by SHA-256, *then* deletes the source. `node scripts/vault-sizing.js` costs it out — 1.6–11 GB of vault for 9,398 documents depending on average size, ~1.2 GB of database, migration peak roughly raw + deduplicated. **Storage is not the reason to hesitate.** The real change is that the vault becomes the ONLY copy: today the client's own drives provide durability and the database is the sole irreplaceable thing; afterwards a failed disk loses the archive. |
| **export** | Atlas writes a real folder tree with real copied files, named and filed. The client inspects it and deletes the sources himself. No irreversible action taken by software. |

Note that `redundantCopyService` means the sentence "Atlas never modifies the
original files" is now *almost* true rather than true. If the vault option is
ever built it stops being true altogether, and the backup story stops being a
precaution and becomes the product working at all.

---

## 13.6 Verification scripts

`backend/scripts/` holds fifty-odd scripts. `npm test` (363 unit tests) does
not cover what they cover: these are integration checks against a real Postgres
and the real `.env`, which is the point of them and why they are separate.

```bash
npm run verify:all               # every script, alphabetically
npm run verify:all -- search     # only those whose name contains "search"
npm run verify:all -- --bail     # stop at the first failure
```

**Run the whole list after any change to ownership, filtering or search** — not
just the script whose feature you touched.

That instruction is not caution for its own sake. Three of these scripts were
dead and nobody knew: `verify-search-filters`, `verify-triage` and
`verify-duplicate-compare` all threw on their first line of setup, because the
per-owner ownership change made `ownerUserId` a required argument
(`repositories/ownership.js` throws rather than defaulting) and their fixtures
were never updated. They had been red long enough for two real bugs to
accumulate behind them. A verification script that is not run is not a
guardrail. Seven others exited `0` no matter what they found — including
`verify-agent-e2e`, the only one wired into `package.json`, so
`npm run verify:agent` could not fail.

### The shape that catches the bugs

**Two of them drive the REAL code with one collaborator stubbed**, rather than
reimplementing what they check:

- `verify-assistant-retrieval` stubs the Gemini call and drives the actual
  controller. It caught an ordering bug that the reimplementation it replaced
  had gotten *right* — a script that rebuilds the logic it checks passes
  happily while the shipped path is broken. It needs no API key and makes no
  model call.
- `verify-quick-identity` instruments the storage layer and counts bytes. It
  caught a "working" shortcut that read *more* than before.

Prefer this shape for anything whose failure mode is "it ran but did nothing".

### They touch the live queue

The newer scripts **pause** the queue while they set fixtures up
(`scripts/_fixtureQueue.js`) and resume on the way out. Without that a live
worker hashes the fixtures out from under the assertions — invisible while the
worker has a backlog, and broken the moment it is idle. The older scripts do
not do this yet; run those with the worker stopped.

### Not part of the suite

```bash
node scripts/backfill-fingerprints.js --apply   # catch up an existing corpus
node scripts/verify-inferred-hashes.js --apply  # prove the inferred hashes
node scripts/vault-sizing.js                    # cost the "Atlas keeps files" option
node scripts/generate-pilot-corpus.js --subjects 55000   # load-test the tree
node scripts/run-pilot.js                       # whole-pipeline timing
node scripts/measure-ai-cost.js                 # AI spend on a bounded sample
node scripts/preflight-dev.js                   # is anything on port 5000

cd frontend && node scripts/bench-subject-tree.mjs   # folder pane at 55k folders
cd frontend && node scripts/check-nav-layout.mjs     # header layout
cd frontend && npm run verify:pwa -- <url>           # install metadata over TLS
```

## 13.7 Backups

Nightly at 02:00 via the *Atlas Database Backup* scheduled task
(`scripts/install-backup-schedule.ps1`), into `Documents\Atlas Backups`, 14-day
retention. `scripts/verify-backup-restore.ps1` proves a dump actually restores,
which is the half people skip.

The database is the irreplaceable thing. It is also small — the documents
themselves are the client's own files, in the client's own folders, and Atlas
only ever points at them.
