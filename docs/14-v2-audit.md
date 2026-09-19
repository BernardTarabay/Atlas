# 14. V1 Audit and V2 Architecture

Status: **audit complete, nothing rewritten.** Written 2026-09-19 against the
working tree on `main` (commit `3a350ac` plus 134 uncommitted changes) and the
live development database.

## 0. Summary

**The core question:** what is the simplest production architecture that can
ingest, deduplicate, OCR, rename and organize hundreds of GB reliably, cheaply,
securely and with remote maintenance?

**The answer:**

- **One local engine process** runs as a Windows service on the machine that
  owns the disks. It uses an embedded SQLite database, bundled Tesseract, and a
  local web UI.
- **A small outbound-only cloud control plane** handles updates, heartbeats,
  logs and allowlisted remote commands.
- **AI is off by default.** When enabled, it is a budgeted, cached, optional
  step that no file ever has to pass through.

That removes, from the client machine:

- the separate PostgreSQL server;
- the 20-type job queue and its three recovery sweeps;
- the Electron agent;
- Tailscale as a requirement;
- every mandatory AI call.

It keeps V1's best engineering: the extractors, text-quality gating, placeholder
detection, atomic name reservation and the SHA-256 streaming code.

### What the audit found, in one paragraph

V1 is about 31k lines of backend, 16k of frontend and 10k of verification
scripts, not thousands of files. It is carefully commented and has many
individually well-reasoned parts. The problems are structural:

- **AI is inside mandatory stages.** It runs about 2.2 paid calls per file, with
  no budget and pacing turned off.
- **Each document is read three times.**
- **Orchestration is spread across 20 queued job types.** About 30 job rows and
  about 13 audit rows are written per file.
- **Four contradictory organization mechanisms exist.**
- **The design documents assert invariants the code no longer keeps.** The
  database shows 7,606 on-disk renames and 756 on-disk deletions, against docs
  that say originals are never touched.
- **There are two real paths to deleting the wrong file.** One of them has
  already been exercised in this database (§11).

### Urgent: do these on the client's V1 install now, regardless of V2

1. **Stop AI spend. The existing switch does not do it.**
   `AI_CLASSIFICATION_ENABLED=false` does not stop the folder planner, the
   hourly unfiled organizer, the consolidator, the chat assistant or email
   triage. Those only check whether a key exists.
   - Remove `GEMINI_API_KEY` and set `ORGANIZE_UNFILED_AUTO=false`, then
     restart **both** the API and the worker.
   - Independently, in Google Cloud, set a per-key requests/day quota and a
     billing budget alert. Provider-side limits are the only ones a bug in the
     app cannot bypass.
2. **Disable redundant-copy deletion** (`POST /api/duplicate-groups/redundant-copies/delete`)
   until the fix in §24 lands. It never re-reads the file it deletes (§11, R1).
3. **Commit or tag the working tree.** 134 uncommitted changes include
   migrations 043–046, which are already applied to this database. V2 needs a
   reproducible V1 baseline to compare against.
4. **Apply the two host fixes** that are already written:
   `configure-server-power.ps1 -Apply` and an elevated
   `install-autostart.ps1`. The host sleeps after 25 minutes and has no boot
   trigger.

---

## Method and evidence

Every claim here comes from one of these sources:

- **Code** that was read and traced. Paths are given, and every `enqueueJob`
  call was followed to the next stage.
- **The live development database**: row counts, audit-log action counts and
  joins.
- **A measurement on this machine**: SHA-256 runs at ~330 MB/s per core on the
  i7-1165G7 with Node 24.

The dev corpus is **7,262 files totalling 108 MB** (about 15 KB average,
synthetic). That makes it good evidence for pipeline *shape* and per-file
*ratios*. It is **no evidence at all for throughput**, so every hundreds-of-GB
number below is labelled as an estimate.

I could not inspect the client's production machine. Anything about it is
flagged as unknown.

---

## 1. Current architecture

```text
 Client office PC (Windows 11 Home, the "Atlas host")
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Scheduled tasks: autostart at logon + 5-min watchdog (start-atlas.bat)   │
 │                                                                          │
 │  API process (Express 5, :5000)          Worker process (runner.js)      │
 │   ├ serves built React SPA                ├ 2 pools × 4 lanes           │
 │   ├ ~20 route groups, JWT + RBAC          │   fast: 18 job types         │
 │   ├ storage watcher (fs.watch) + hourly   │   slow: describe, ocr        │
 │   │   rescan scheduler                    ├ stale-job sweep (60 s)       │
 │   ├ email / trash / retention /           ├ stranded-file sweep (2 min)  │
 │   │   organize-unfiled schedulers         └ LISTEN/NOTIFY + advisory lock│
 │   └ direct fs access to C:\ D:\                                          │
 │                    │                              │                      │
 │                    └──────── PostgreSQL 18 ───────┘                      │
 │                     (40 tables; processing_jobs IS the queue)            │
 │                                                                          │
 │  External binaries: tesseract, pdftoppm/ImageMagick, soffice,            │
 │                     powershell.exe (WScript.Shell .lnk writer)           │
 └───────────────┬─────────────────────────────────────┬────────────────────┘
                 │ tailscale serve (HTTPS on tailnet)   │ outbound HTTPS
                 ▼                                      ▼
   Phones / other PCs (PWA)             Google Gemini: Interactions, Files,
                                        Embeddings APIs; Gmail API (OAuth)

 Optional, never used on this install: Electron "Filesystem Agent" on a remote
 laptop. It polls the API for typed operations and ships file bytes base64
 over HTTP.
```

**The key correction to the brief.** Electron was *not* what gave V1 access to
C: and D:. The Node backend runs on the same machine and reads the disks
directly (`access_mode = 'direct'`). The Electron agent exists only for a
storage location on a *different* machine. None has ever been registered:
`filesystem_agents` has 0 rows and `agent_operations` has 0 rows.

---

## 2. Current ingestion pipeline (as implemented)

The pipeline is choreographed: each processor enqueues the next job.

```text
scan (per storage location; pg advisory lock; watcher + hourly rescan)
 │  per file: lookup → insert → markScanned → audit row → enqueue(hash) + NOTIFY
 ▼
hash ─┬─ cloud-placeholder check (skip if the content isn't local)
      ├─ quick identity: same owner+size+mtime? → read 64 KB head+tail → match?
      │     → ADOPT the twin's SHA-256 without reading the file ("inferred")
      ├─ else stream full SHA-256 (+ head/tail fingerprint in the same pass)
      ├─ byte-identical twin already processed? → copy its metadata, text,
      │     classification and AI fields → detect_duplicates → DONE
      └─ route by extension/mime:
          image ──▶ extract_metadata + detect_duplicates + ocr
          │           ocr = Tesseract (fra+ara+eng) + Gemini VISION call
          │           → describe (adopt vision text) + EMBEDDING call
          media ──▶ extract_metadata + detect_duplicates + describe
          │           (Gemini watches/listens: upload ≤200 MB) + EMBEDDING
          document ▶ extract_metadata  (reads the whole file again)
                     detect_duplicates (exact: SHA-256 group → auto-pick canonical)
                     extract_text      (reads the whole file a third time)
                       ├ detect_duplicates(probable)  shingle/Jaccard, 300 candidates
                       ├ detect_versions              suggestions nobody applies
                       └ classify: keyword rules → Gemini (ALWAYS, per .env)
                           ├ generate_names → proposal → auto-decide ≥0.90
                           │   or "vetted title" → bulk_rename: file RENAMED AND
                           │   MOVED ON DISK if the location is writable
                           │   (or canonical name + .lnk mirror if read-only)
                           └ describe → text summary call (unless the classifier's
                                        summary is adopted) + EMBEDDING call
Scheduled: organize_unfiled (Gemini planner INVENTS folders and files things;
           hourly, ≤8 runs/day, ON by default), purge_trash, purge_operational,
           email_sync, stale-job sweep, stranded-file sweep
Manual:    redundant-copy delete (typed phrase) → fs.unlink + hard row delete;
           relocate-into-organized.js (moves every file into one tree)
```

### 2.1 Deduplication and hashing: answers to §4.1 of the brief

| Question | Finding |
|---|---|
| Algorithm | SHA-256, streamed ([hashingService.js](../backend/src/services/hashingService.js)). A second SHA-256 over size + first 64 KB + last 64 KB is computed in the same pass as a "quick fingerprint". |
| Cryptographically appropriate? | **Yes, keep it.** MD5 and SHA-1 have practical collisions (two different PDFs with the same SHA-1 are public), and a dedup that deletes on hash equality must not use them. |
| Unnecessarily expensive? | **No.** Measured ~330 MB/s per core on this laptop: 4 lanes is about 1.3 GB/s, faster than a SATA SSD (~500 MB/s) or HDD (~150 MB/s). Hashing is disk-bound. The expense is *reading files three times* and *hashing files that cannot have duplicates*. |
| Partial hashing? | Used, but **in the wrong direction.** V1 uses a head/tail match to *conclude* identity (`hash_source='inferred'`). A partial hash may only *exclude* identity. |
| Size as a first filter? | Only as a candidate filter for the inference. There is no size-uniqueness short-cut: every file is fully hashed even when no other file has its size. |
| Collisions | Not handled, which is fine for SHA-256. The real "collision" risk is the inferred hash, and nothing downstream reads `hash_source`. |
| Representation | `files.sha256_hash` (plus a redundant `file_hashes` table). `duplicate_groups` is keyed on the hash, with a unique index to prevent races. A canonical member is picked by heuristic (has an AI title +10, not "(2)"-like +5, earliest import). |
| Original preserved? | Group resolution deletes nothing. **Redundant-copy deletion does delete**: `fs.unlink`, no recycle bin, and a hard `DELETE FROM files`. |
| Safe? | **No.** See R1 and R2 in §11. It re-hashes the survivor but never the victim, and it has no physical-identity check. |
| Faster? | Yes. Group by size first, then partial hash to exclude, then a full hash only for size collisions or files already being read, then a byte-level check before any removal. See §23. |

### 2.2 OCR: answers to §5 of the brief

| Question | Finding |
|---|---|
| Engine | **Local Tesseract binary** ([ocrEngine.js](../backend/src/services/ocr/ocrEngine.js)), languages `fra+ara+eng`. PDFs are rasterized by pdftoppm, falling back to ImageMagick. |
| Why chosen | Native beats tesseract.js WASM on speed and needs no runtime language download. Windows OCR was rejected for being platform-specific. |
| AI/API usage | OCR itself: none. **But the OCR stage bolts on a Gemini vision call for every image** (`ocrService.describeImage`), and `describe` then adds an embedding call. |
| Accuracy / cost | Not measured on real scans here. Average OCR job time is **5.7 s** (runner.js comment). Running three languages on every page is a known slowdown. |
| Local replacement | Already local. Candidates to benchmark in V2: Tesseract (current) vs Windows.Media.Ocr (built in, good on photos, Windows-only, which is now acceptable). |
| Only when appropriate? | Partly. Every image is OCR'd. PDFs are OCR'd only when the text layer is unusable (good). There is no "does this image contain text" gate. |
| Cached? | Yes, effectively: `file_ocr` per file, and byte-identical twins adopt results. |
| Skipped when useless? | No. Camera photos of scenes are OCR'd *and* sent to the vision model. |

### 2.3 Renaming: answers to §6 of the brief

- **Name source priority** ([namingService.js](../backend/src/services/namingService.js),
  [generateNamesProcessor.js](../backend/src/jobs/processors/generateNamesProcessor.js)):
  1. embedded title (if usable and not boilerplate);
  2. Gemini `short_title`;
  3. AI entities;
  4. last resort `Subject_DocType_Year`.
- **AI is the default naming path for any file without a good embedded title.**
- **The proposal/approval workflow still exists structurally** (`rename_proposals`
  has 8,479 rows) but now decides instantly. A "vetted" AI title is always
  applied. Anything else is applied at confidence ≥ 0.90, otherwise rejected.
- **On writable locations, the real file is renamed and moved into the subject
  folder, unattended** (7,991 `rename.auto_applied`, 7,606 `file.renamed`).
- **Good, reusable logic:**
  - `isUsableTitle` (junk-title and mojibake rejection);
  - `isBoilerplateTitle` (a title shared by 5+ files is the template's);
  - the rule that unusable text never produces a name;
  - Unicode-preserving sanitization;
  - length capping;
  - the O_EXCL name reservation.
- **Missing, deterministic sources that V2 should use:**
  - EXIF capture time;
  - dates embedded in camera/WhatsApp/screenshot filenames;
  - the largest-font line of page 1;
  - regex-extracted document numbers and dates;
  - a "keep the original name if it is already meaningful" test.

### 2.4 Organization: answers to §7 of the brief

V1 has **four organization mechanisms**, and they contradict each other:

| Mechanism | What it does | State |
|---|---|---|
| Classification = filing | a `classification_results` row ("latest row wins") places a file under a subject | live |
| AI folder planner | `organize_unfiled` sends batches of 120 unfiled files to Gemini, which **creates folders** (67 AI-created vs 7 user-created here) | live, scheduled, paid |
| Physical move via rename | `generate_names` sets `proposed_relative_dir` = subject path, and `bulk_rename` moves the file within its location | live on writable locations |
| Shortcut mirror | `.lnk` tree under `MIRROR_ROOT`, written through PowerShell/WScript.Shell | superseded; files were relocated instead |
| One-shot relocation | `scripts/relocate-into-organized.js` moves every file into one tree and empties the sources | **has been run here**: all 7,260 files are now in "Organized" |

- **How categories are determined:** keyword matches of the filename and body
  against the subject names and descriptions ([taxonomyMatcher.js](../backend/src/services/taxonomyMatcher.js)),
  then Gemini picks from the closed list. The document type comes from the
  extension or a filename keyword only.
- **Ambiguous files:** they go to "Unfiled", which the AI planner then empties.
- **Conflicting destinations and filenames:** resolved with `name (n).ext`,
  using an atomic O_EXCL reservation (good).
- **Rollback:** the audit log records previous paths, but no undo tool exists.
- **Atomicity:** a same-volume move is atomic, but the disk move and the DB
  update are not journaled together (§11, R4).
- **Speed:** organization is bottlenecked on classification, which is
  bottlenecked on AI.

---

## 3. Complete component inventory

The verdict column uses: **K** keep/port, **S** simplify, **R** rewrite,
**X** remove.

| Component | Responsibility | Depends on | Size | Verdict |
|---|---|---|---|---|
| `queues/pgQueue.js` | SKIP LOCKED claim, retry, stale recovery, pause lease | Postgres | 386 | S: the pattern is sound; V2 needs no job table |
| `workers/runner.js` | 2 pools × N lanes, LISTEN, sweeps | pgQueue | 350 | R → in-process orchestrator |
| `jobs/processors/*` (20) | one stage each; each enqueues the next | everything | ~3,300 | R → one per-file pipeline function |
| `services/fileRecovery.js`, `pipelineState.js` | rescue files stranded between stages | queue | ~550 | X: unnecessary once a file's pipeline is one call |
| `services/extraction/*` incl. `ole/`, `utils/cfb.js` | PDF/DOCX/XLSX/PPTX/PBIX + legacy .doc/.xls/.ppt with code pages | pdfjs-dist, exceljs, adm-zip | ~2,000 | **K**, tested, hard-won |
| `extraction/textQuality.js`, `documentDate.js` | usable-text verdict; document date resolution | none | ~340 | **K** |
| `utils/fileSignature.js`, `mimeGuess.js`, `imageDetection.js` | magic bytes, routing | none | ~260 | **K** |
| `utils/cloudPlaceholder.js` | skip OneDrive/iCloud placeholders without hydrating them | fs attributes | 271 | **K**, critical |
| `utils/pathSafety.js`, `pathOverlap.js`, `filenameSafety.js`, `resolveAvailableFilename.js` | root confinement, overlap, reserved names, collision-free names | none | ~340 | **K**, extend with file-ID identity |
| `storage/localStorageService.js` | walk, read, rename (O_EXCL), unlink | fs | 147 | R: keep the O_EXCL idea; add a journal, error-tolerant walk, file IDs |
| `storage/agentStorageService.js`, `agentService.js` | broker ops to the Electron agent | agent protocol | ~460 | X |
| `hashingService.js`, `quickIdentityService.js`, `knownContentService.js` | hash, fingerprint, twin adoption | db | ~400 | K the mechanics; R the semantics (partial excludes only) |
| `duplicateGroupService.js`, `redundantCopyService.js` | groups, canonical pick, deletion | storage | ~430 | R, unsafe as is (§11) |
| `similarityService.js`, `detectVersionsProcessor.js` | near-duplicates, version suggestions | text | ~390 | X from core (optional later) |
| `ocr/*` | engine detection, rasterize, recognize | tesseract, poppler | ~880 | K the engine wrapper; R the gating; X the vision call |
| `namingService.js` + naming processor | names | classification, AI | ~710 | R deterministic; port the title vetting |
| `taxonomyMatcher.js`, `subjectService.js` | keyword match; subject tree CRUD | db | ~700 | S → rule engine conditions |
| `unfiledOrganizer.js`, `ai/folderPlanner.js`, `ai/folderConsolidator.js`, `folderConsolidation.js` | AI invents folders | Gemini | ~1,220 | X |
| `descriptionService.js`, `descriptionSearchService.js`, `ai/{textSummariser,imageDescriber,mediaDescriber,embeddingService}.js` | describe every file and semantic search | Gemini | ~1,960 | X (optional later with local embeddings) |
| `ai/geminiClassifier.js` | LLM classification | Gemini | 336 | S → optional fallback behind the gateway |
| `ai/geminiChatService.js` + `AssistantPanel.jsx` | chat assistant with tools | Gemini | ~1,650 | X |
| `email/*`, `emailAccountService`, `ai/emailTriageClassifier`, Inbox page | Gmail triage | Google OAuth | ~780 | X, out of scope |
| `mirror/*` | .lnk shortcut tree | PowerShell | ~520 | X |
| `photoService.js`, Photos page | photo review workspace | db | ~1,160 | X / S into the library view |
| `triageService`, `triageRepository`, Failed page | stuck-file workspace | pipelineState | ~1,100 | S → "needs attention" list |
| `lifecycleService.js`, trash/archive | DB-level trash of index rows | db | ~370 | R → file quarantine |
| devices, `file_replicas` | cross-device model | db | ~320 | X (1 device, 0 replicas) |
| auth, RBAC, ownership, refresh tokens | multi-user JWT | bcrypt, jwt | ~900 | S → local single-owner auth |
| `storageWatcher.js` | fs.watch + rescans | queue | 336 | R, with self-event suppression (see the 1,549-scans/day incident) |
| `preview/*` | LibreOffice thumbnails | soffice | ~210 | X / defer |
| `desktop-agent/` | Electron FS broker | Electron | 1,450 | X (reuse the walk logic) |
| `frontend/` | React SPA, 13 pages | Vite, Tailwind | 16,131 | R small; port selected components (virtualized table, filters) |
| `scripts/*.ps1` | autostart, watchdog, power, backup, Tailscale, doctor | Windows | ~2,200 | S → installer steps (power config, diagnostics ideas) |
| `backend/scripts/verify-*` | live end-to-end assertions | Postgres | ~10,000 | S → V2 integration-test philosophy |
| `backend/tests/` | 363 pure unit tests | node:test | 3,880 | K the ones for retained modules |

---

## 4. AI dependency map

| # | Caller | Model | Purpose | Input sent | Frequency | Required? | Replaceable by | Cached? | Audited per call? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `geminiClassifier` | flash-lite | subject + type + title + summary + entities | filename, ≤6,000 chars of text, embedded title, **the whole folder list** | **every file with usable text** (`always`) | no | rules + deterministic naming | by SHA-256 twin only | yes |
| 2 | `imageDescriber` (via OCR) | flash-lite | caption, summary, folder suggestion | **the full image** | **every image** | no | EXIF/OCR rules; local model later | twin only | yes |
| 3 | `imageDescriber` (via describe) | flash-lite | same, if 2 didn't run | full image | images without OCR | no | same | twin only | yes |
| 4 | `mediaDescriber` | flash-lite | watch/listen to video/audio | **the file uploaded, up to 200 MB**, billed per second | every video/audio file | no | container metadata | twin only | yes (as describe) |
| 5 | `textSummariser` | flash-lite | 1–2 sentence description | document or OCR text | every doc not already summarized by 1 | no | not needed | twin only | yes |
| 6 | `embeddingService` | gemini-embedding-001 | 768-d vector for semantic search | description | **every file** + every semantic search query | no | local multilingual embedding model | twin only | **no** |
| 7 | `folderPlanner` | flash-lite | invent folders and file 120 files | titles and descriptions of 120 files + the tree | **hourly**, ≤5 batches × ≤8 runs/day | no | rule engine | no | **no** (run-level only) |
| 8 | `folderConsolidator` | flash-lite | merge AI folders | the tree | manual | no | not needed | no | **no** |
| 9 | `geminiChatService` | flash-lite | assistant with tool calls | conversation + file listings | per chat turn, multi-step | no | remove | no | **no** |
| 10 | `emailTriageClassifier` | flash-lite | junk/important | email headers and snippet | per synced message | no | remove | no | **no** |

**Measured on this database:**

- ~8,900 audited billed calls (6,478 describe, 1,912 classify, 519 vision).
- About 7,300 unaudited embedding calls.
- Together that is **≈2.2 paid calls per file**. On 2026-08-26 alone there
  were 7,485 audited calls.
- docs/13 §13.4 measured a text call at ≈$0.00023. That price cannot by itself
  explain a drained balance. The mechanisms that can are in §10.

---

## 5. Worker and queue architecture

**What exists:**

- **20 job types in one `processing_jobs` table**, claimed with `FOR UPDATE SKIP LOCKED`.
- **Two pools**:
  - fast: 18 types × 4 lanes;
  - slow: describe and ocr × 4 lanes.
- **Retries:** 3 attempts with exponential backoff from 5 s.
- **Stale recovery:** any job `running` for more than 10 minutes is requeued.
- **Recovery layers:** a per-file retry budget of 3 per stage in
  `pipelineState`, a file-recovery sweep every 2 minutes, and scan-time
  reconciliation of unprocessed files.
- **Liveness:** a shared advisory lock, used by `/api/health`.

**The design flaw** is that stages are *choreographed*: each job enqueues the
next. Any failure between two jobs strands the file, which is why three
recovery mechanisms were added, one after each incident:

- Redis dying unnoticed for two days;
- 5,730 files stranded for 13 hours;
- a failed-retryable state that nothing consumed.

**Side effects of that design:**

- about **30 job rows per file** historically (237,500 for 8,001 files);
- `processing_jobs` + `audit_logs` grew to **5.2 GB of a 5.4 GB database**
  holding 48 MB of documents (migration 045's own comment).

**A double-execution risk:** the 10-minute stale threshold is shorter than a
large video's upload and processing time. A still-running describe job can be
re-run concurrently, and billed twice.

**The answers to §12 of the brief** are the V2 design in §19–§23:

- nothing per-file needs a *queue*;
- it needs a durable per-file *state* and bounded concurrency pools;
- file operations need a *journal*.

---

## 6. Database architecture

- **40 tables.** 14 have **zero rows**: `documents`, `document_versions`,
  `document_subjects`, `document_tags`, `tags`, `related_documents`,
  `agent_operations`, `filesystem_agents`, `file_replicas`, `email_accounts`,
  `inbox_messages`, `ai_conversations`, `ai_messages`, `duplicate_dismissals`.
- **`files` has 52 columns and 25 indexes.** Pipeline stages issue many
  single-column `UPDATE`s, and each one maintains 25 indexes.
- **Several facts are stored twice** and the comments document races between
  the copies:
  - OCR status in `file_ocr.status` and `files.ocr_status`;
  - the hash in `files.sha256_hash` and `file_hashes`;
  - the description in `file_descriptions` and `files.ai_summary`.
- **`classification_results` is append-only**, with "latest row wins": 14,506
  rows for 7,262 files.
- **The audit log is used as telemetry**: about 13 rows per file.
- **The database runs in `Asia/Jerusalem`**, a documented date-filter trap.
- **Size:** 282 MB of metadata for 108 MB of files. `processing_jobs` is 39 MB
  for 472 rows (bloat).

The V2 schema is in §19. It has about 8 tables.

---

## 7. Electron analysis

**What it provides that the browser and backend don't:** only the ability to
reach files on a *different* machine that the backend can't see, via
poll-execute-report.

**Why it is not worth keeping:**

- It has never been used on this installation.
- It splits the work the wrong way. The agent ships whole files, base64-encoded
  in one POST (about 3× the file size in memory on each side, 200 MB cap, no
  resume), so the *server* can hash and extract them. For hundreds of GB that
  means uploading hundreds of GB.
- `list_directory` pages by skip-count, re-walking the tree for every page:
  O(N²) stat calls, about 90M for 300k files.
- Its security model is good: typed ops only, path checks on both sides, and a
  sandboxed renderer.
- **Verdict:** remove it. The V2 engine runs where the files are, so no broker
  is needed. If a second machine ever needs indexing, it gets its own engine,
  not a broker.

## 8. Tailscale analysis

- **Code dependencies:** none. The only mentions in `app.js`, `openFile.js` and
  `shareFile.js` are comments and HTTPS detection.
- **Operational dependencies:**
  - `install-tailscale-serve.ps1` publishes `https://atlas.<tailnet>.ts.net`,
    which gives the PWA a secure context and gives phones and other PCs access;
  - `enable-remote-admin.ps1` plans OpenSSH bound to the Tailscale IP (not
    applied). Tailscale's own SSH server doesn't run on Windows, and Windows 11
    Home can't host RDP.
- **What problem it solves:** it is solving *"the server is a desktop behind
  NAT that people and I must reach inbound."*
- **In V2 it becomes optional.** Maintenance goes over an outbound-only channel
  (§21), and the UI is local. Keep it only for two cases:
  - a break-glass remote shell;
  - if the client really needs to browse the library from other devices (open
    question Q2).
- **Security if retained:** use tailnet ACLs and never `funnel`. Its reasons to
  exist are convenience, not security.

---

## 9. Performance bottlenecks (V1)

Ranked by expected impact at hundreds of GB. Estimates are marked "est.".

1. **Mandatory AI in the critical path:** 2.2 calls per file, with media
   uploads of up to 200 MB. It is latency- and quota-bound, not CPU-bound.
2. **OCR on every image with three languages.** 5.7 s average per job.
   *est.* 150k photos ÷ 4 slow lanes ≈ 59 hours of OCR alone.
3. **Read amplification.**
   - Documents are read in full three times (hash stream, metadata buffer,
     text buffer) and parsed twice.
   - Images are read four times (hash, metadata, Tesseract, vision).
   - Redundant deletion re-reads the kept file.
4. **Whole-file buffering** (`streamToBuffer`, 256 MB cap). Two copies are
   held transiently, on two queues at once. The code documents a real OOM risk.
5. **DB write amplification:**
   - about 30 job rows and 13 audit rows per file;
   - roughly 150+ statements per file;
   - a 25-index hot table;
   - per-new-file sequential round trips during the scan (≈5 statements plus a
     NOTIFY).
   - *est.* for 300k files: about 9M job rows and 45M statements.
6. **The watcher feedback loop:** 1,549 scans in one day while watching the
   folder the app writes into (see `pathOverlap.js`).
7. **Agent transport:** O(N²) listing and base64 whole-file transfer. It hasn't
   been hit only because the agent has never been used.
8. **Scan fragility:** the backend walk has no per-directory error handling,
   so one unreadable folder (such as `System Volume Information` on a drive
   root) aborts the whole scan.

Not a bottleneck: SHA-256 CPU (measured) and Postgres read performance at this
scale.

## 10. Cost bottlenecks

1. `AI_ESCALATE_BELOW_CONFIDENCE=always`: one classifier call per text file.
2. The describe stage: vision per image, video/audio per media file (billed
   per second), a summary per document, and an embedding per file.
3. `organize_unfiled`, **on by default**: hourly, 120-file prompts, up to 8
   runs per day. The same unfiled files are re-sent until they are filed
   (`organize_attempts` was only added in uncommitted migration 044).
4. **No budget at all.** The daily cap was removed (it was enforced three
   inconsistent ways and turned "over budget" into "6,953 files failed").
   Pacing defaults to 0, and the only backpressure is Google's 429.
5. **Retry multiplication:** up to 3 HTTP attempts × 3 queue attempts × 3
   file-stage recoveries per stage, plus stale-job double execution.
6. **Spend blindness:** embeddings, the planner, the consolidator, chat and
   email triage are not in `BILLED_AI_ACTIONS`, so `measure-ai-cost.js`
   under-reports.
7. **Operational multipliers:** running two workers (warned about in the old
   session notes) doubles the rate. `AI_CLASSIFICATION_ENABLED=false` doesn't
   stop callers 7–10.

The root cause behind all seven is that **AI was made a stage files must pass
through.** That forced the cap to fail files, which forced the cap's removal.
In V2, AI is never mandatory, so a strict cap costs nothing.

## 11. Reliability and data-loss risks

| ID | Severity | Risk | Evidence |
|---|---|---|---|
| **R1** | Critical | **Redundant-copy deletion never re-reads the file it deletes.** It verifies only the survivor. A copy whose SHA-256 was *inferred* from size + mtime + 128 KB, or whose bytes changed since hashing without a detectable mtime change, is `unlink`ed as a "redundant copy" of a different file. | [redundantCopyService.js](../backend/src/services/redundantCopyService.js). **This has happened here**: 6 distinct files had inferred hashes and were then deleted from disk (audit join `file.hash_inferred` × `file.redundant_copy_deleted`). They were almost certainly true copies (the "test2" / "test2 - Copy" folders), but nothing proved it. |
| **R2** | Critical (committed V1) | **Overlapping storage locations mean one physical file appears as two rows.** The same-file guard compares paths only when both rows share a location ID, so deleting "the copy" deletes **the only copy**. The "≥2 active rows with this hash" check passes, because both rows are the same file. | The overlap guard exists only in *uncommitted* `storageLocationService.js`, only at registration, only for the same user's active locations. `deleteRedundant` has no physical-identity (file ID) check. |
| R3 | High | Deletion is permanent: `fs.unlink` plus a hard row delete. There is no quarantine, recycle bin or undo. | `localStorageService.remove` |
| R4 | High | A rename or move is not journaled. A crash or power loss between the disk rename and the DB commit leaves the DB wrong. The file is later re-ingested as new (history lost), and the old row is marked missing. | `bulkRenameProcessor.js` (only DB *errors* are reverted) |
| R5 | High | Relocation's cross-volume fallback runs `copyFile` then `unlink` with no content verification or fsync. It must be run with the app stopped, but nothing enforces that. | `relocate-into-organized.js:187–193` |
| R6 | High | Unattended on-disk renames from AI titles on writable locations. There is no undo tool; recovery means reading the audit log by hand. | 7,606 `file.renamed` |
| R7 | Medium | The stale-job threshold (10 min) is below the length of the longest job, so a still-running job runs twice (double billing; double side effects where a job isn't idempotent). | `pgQueue.STALE_RUNNING_MS` |
| R8 | Medium | Duplicated state (OCR status, hash, description) with documented races. | comments in `hashProcessor.js`, `ocrService.js` |
| R9 | Medium | One unreadable directory aborts the scan. | `localStorageService._walk` |
| R10 | Medium | **Docs assert false invariants**: README and docs/13 §13.3 say originals are never moved or deleted. Operators will make safety decisions on a false premise. | audit log vs docs |
| R11 | Medium | "Duplicates" can be backups. Deduplicating a backup folder against the working folder silently removes the backup. V1 has no concept of a root that must never be deduplicated. | design gap |
| R12 | Medium | Host availability: sleeps after 25 minutes, no boot trigger, Windows Home. | memory, docs/12 |

## 12. Security risks

| Risk | Detail |
|---|---|
| Filesystem-wide reach | The API and worker run as the logged-in user with full filesystem access. Any account holding `storage.manage` (which the default `User` role has) can register **any directory on the host** and read it. The code logs this warning itself. Registration defaults to first-run only, which is the one containment. **A compromised API or worker process can read or destroy anything the user can.** |
| History | JWT secrets ran in production for months as `change-me-…` (env.js comment). Registration was open to anyone who could reach the port. Both are fixed, but they show that a network-reachable server on a client desktop is an ongoing liability. |
| Data to AI | Full images, whole videos and audio, document text (≤6k chars), filenames, and **the client's entire folder tree** in every prompt. There is no per-folder exclusion. |
| Token storage | Access and refresh tokens are kept in `localStorage`, so XSS means takeover (mitigated by the CSP). |
| Secrets at rest | Gemini key, JWT secrets and the Gmail token key are plaintext in `.env`. OAuth refresh tokens are encrypted with a key from the same `.env`. |
| Parsers | Untrusted DOCX/XLSX (zip), PDF and OLE files are parsed in-process in the worker, with no memory or time limits beyond the file-size cap. A zip bomb can take the worker down. |
| Filenames from AI | Names are applied to disk from model output. There's sanitization, but no bidi-override (U+202E) stripping. |
| Agent | Sound design, but path checks are lexical (no realpath/junction check). Moot, since it is unused. |
| Good, keep | argv-only `execFile` (no shell), `resolveWithinRoot`, O_EXCL writes, helmet/CSP, rate limits, placeholder rejection of secrets. |

---

## 13. What should be retained

Port these into V2, with their unit tests:

- **Extraction:** `services/extraction/*`, `utils/cfb.js`, `ole/*` (legacy
  Office with code pages), `textQuality.js`, `documentDate.js`.
- **File identity and safety:** `fileSignature.js`, `mimeGuess.js`,
  `imageDetection.js`, `cloudPlaceholder.js`, `pathSafety.js`, `pathOverlap.js`,
  `filenameSafety.js`, `resolveAvailableFilename.js`, and the O_EXCL
  reservation in `LocalStorageService.rename`.
- **Hashing:** `sha256AndFingerprint` (single-pass hash plus head/tail
  fingerprint), with changed semantics.
- **Work reuse:** the known-content principle ("identical bytes ⇒ identical
  analysis"). It becomes a content-addressed cache.
- **Naming logic:** `isUsableTitle`, `isBoilerplateTitle`,
  `looksLikeMojibake`, and Unicode-preserving sanitization.
- **OCR:** `ocrEngine.js` and `pdfRasterizer.js` (the invocation wrapper and
  engine detection).
- **Classification:** `taxonomyMatcher.js`, reused as the rule engine's keyword
  condition.
- **Scanning:** `SYSTEM_JUNK`, and the desktop agent's error-tolerant `walk`.
- **Host setup:** power configuration from `configure-server-power.ps1`, and
  the diagnostics checklist from `atlas-doctor.ps1`.
- **Testing:** the verify-script philosophy of end-to-end assertions against
  real filesystem state.
- **Queue pattern:** `pgQueue`'s SKIP LOCKED pattern, if Postgres is kept for
  the control plane.

## 14. What should be removed

- **AI features:**
  - all describe/summarize/vision/media/embedding AI;
  - semantic search;
  - the chat assistant;
  - the AI folder planner and consolidator.
- **Workflows:**
  - rename proposals and auto-decide;
  - triage and the photo review workspace;
  - version detection;
  - probable-duplicate similarity (core);
  - DB-level trash/archive (replaced by a file quarantine).
- **Organization:** the shortcut mirror.
- **Infrastructure:**
  - the Electron agent and its protocol;
  - the 20-type job queue and three recovery sweeps;
  - per-file audit telemetry.
- **Out-of-scope features:** Gmail inbox, devices/replicas, LibreOffice
  thumbnails.
- **Data model:** the 14 empty tables and the `documents` model.
- **Multi-user:** RBAC (54 role-permission rows) and per-user ownership,
  pending Q3.
- **Hosting:** PostgreSQL *on the client machine*, and Tailscale as a
  requirement.

## 15. What should be rewritten

- scanner;
- per-file orchestrator;
- dedup engine;
- file-operation executor with journal and quarantine;
- rename engine (deterministic templates);
- organization engine (rules, explainability, plan/apply);
- persistence (SQLite, about 8 tables);
- local API and a small UI;
- installer, updater, telemetry and command channel (new);
- the AI gateway (new, optional).

---

## 16. V2 architecture options

**A. Desktop-only.** A local engine plus UI on the client PC, with no backend.
Maintenance is by remote desktop or Tailscale.

**B. Local engine + outbound-only control plane.** The engine is a Windows
service next to the disks, with SQLite, bundled OCR and a local web UI. A
small hosted control plane handles updates, heartbeats, logs and allowlisted
commands. (This is your "desktop client + remote backend", with processing
staying local.)

**C. Cloud web app + local agent.** The UI, DB of record, auth and admin are
hosted. A local agent does the filesystem work and processing, and pushes
metadata up.

**D. Browser-only (File System Access API).** A deployed web app reads and
writes folders the user grants it.

*(Rejected outright: a desktop client that uploads files to a remote
processing backend. 100 GB at a 40 Mbit/s office uplink is about 5.5 hours
before any processing starts, and every document leaves the building.)*

**What a browser can and can't do (option D):**

It can:

- let the user pick a directory with `showDirectoryPicker`, in Chromium only
  (not Firefox; Safari has no directory picker);
- iterate the picked directory recursively;
- read `File` objects (streamed, so large files are fine) and write or remove
  entries;
- keep permission across visits: Chromium offers "allow on every visit" for
  granted sites;
- hash in Web Workers (streaming SHA-256 needs a WASM implementation; SubtleCrypto
  can't stream);
- run OCR through tesseract.js (WASM).

It can't:

- access arbitrary paths; system locations are refused by a blocklist, and
  drive roots may be;
- run in the background once the tab closes, so a multi-hour job is tied to an
  open tab;
- read NTFS file IDs, attributes or hard-link identity;
- detect cloud placeholders (reading one silently hydrates it);
- set timestamps;
- call native OCR;
- run as a service or survive a reboot.

Move and rename support varies by Chromium version. **It is fine for a UI and
unsuitable as the engine** for hundreds of GB where data loss is unacceptable.

## 17. Concrete tradeoffs

| | A. Desktop-only | **B. Local engine + control plane** | C. Cloud app + local agent | D. Browser-only |
|---|---|---|---|---|
| Filesystem access | full, native | full, native, OS-scoped by service account | full (agent) | only picked folders, Chromium only, no file IDs or attributes |
| Performance | disk-bound, local | disk-bound, local | local processing; UI latency over internet | WASM hashing/OCR, tab-bound |
| Deployment | installer | installer + small hosted service | installer + hosted app, DB, auth, agent protocol | none locally; hosted SPA |
| Remote maintenance | **poor**: needs inbound access (the V1 problem) | **good**: auto-update, heartbeat, logs, commands over outbound HTTPS | good, and it's also central admin | trivial to update, nothing to maintain locally, but also nothing robust running |
| Offline | full | full (telemetry buffers) | degraded: UI and DB are in the cloud | needs the site cached; FS works |
| Security | small surface; no remote visibility | no inbound ports; local UI on 127.0.0.1; files never leave | metadata, names and extracted text live in the cloud (sensitive); larger attack surface | sandbox is strong; the user grants folders |
| Complexity | lowest | low–medium | **highest**: you are building a SaaS | medium, with platform-limit workarounds |
| Running cost | none | small (object storage, uptime/logging tier, tiny API) | hosted DB + app + egress, per client | hosting only |
| Scalability | one machine | one machine per client; a fleet via control plane | fleet-native | per browser tab |
| AI dependency | optional | optional, gated in one module | optional | optional |
| Multi-device browsing | no | local LAN/Tailscale, or add a read-only cloud view later | yes | per device |

## 18. Recommended direction: Option B

**The reasoning, from the requirements:**

- **Processing must be next to the bytes** (performance, no data movement,
  privacy). That rules out remote processing and makes the engine local.
- **The engine must run for hours, survive reboots, see NTFS identity and
  attributes, and skip cloud placeholders.** That rules out the browser, and
  makes it a native process running as a service.
- **Remote maintenance must not depend on reaching the client's machine
  inbound.** That means outbound-only telemetry, updates and commands. It is
  the pattern backup and sync agents use, and it removes V1's travel problem
  without a VPN.
- **Nothing in the requirements needs the DB of record or the UI in the
  cloud** (unless Q2 says multi-device browsing is essential). So C's extra
  surface and cost buy nothing yet. C can be grown from B later: the control
  plane already exists, and a read-only cloud view is additive.

**Runtime choice: TypeScript on Node 24.** V1's most valuable code is
JavaScript: the extractors, the OLE parser, text quality and naming vetting.
Porting is cheap, and rewriting in Go or Rust would re-pay for bugs already
fixed. Node ships as one folder with the runtime, runs as a Windows service
via WinSW, uses `worker_threads` for CPU work, and runs child processes for
Tesseract. Go would be the pick for a greenfield single binary; reuse
outweighs it here.

**Database choice: SQLite (better-sqlite3, WAL) in the engine.**

- The workload is a single machine with a single engine process. The engine
  needs no multi-process queue or network DB. FTS5 covers search.
- Backups are `VACUUM INTO`.
- It removes a whole server to install, keep running, upgrade and back up on
  every client PC.
- It removes the timezone trap and the bloat/VACUUM maintenance.
- Postgres, if used at all, belongs to the hosted control plane.
- *Acceptable alternative:* keep Postgres locally if you want minimum change.
  The V2 design is DB-agnostic, but you keep the extra service.

**UI:** a local web UI served by the engine on `127.0.0.1`, with a Start-menu
shortcut that opens it in Edge app mode (a chromeless window; Edge ships with
Windows 11). No Electron, no Tauri for v2.0. Revisit a thin Tauri/WebView2
shell only if a tray icon or native notifications become important.

**Process identity:** run the service as a dedicated low-privilege local
account. The installer grants it Modify rights only on the roots the user
adds, which may prompt for UAC when a root is added. **This is what makes "a
compromised worker can destroy arbitrary files" false at the OS level**, not
just in application code.

Fallback: run as the owning user via the S4U boot task V1 already built.
That's simpler, with a weaker blast radius.

```text
 Client PC (Windows)                                        Hosted (yours)
 ┌──────────────────────────────────────────────────┐      ┌───────────────────────────┐
 │ Atlas Engine: Windows service, ONE process       │HTTPS │ Control plane (small)     │
 │  scanner → single-pass reader → analyzers →      │ out  │  device registry          │
 │  planner → executor (journal, quarantine)        │─────▶│  heartbeats + dead-man    │
 │  pools: io | cpu (worker_threads) | ocr | ai     │◀─────│  logs / crash reports     │
 │  SQLite (WAL) · bundled Tesseract · FTS5         │ poll │  signed release channel   │
 │  Local UI + API on 127.0.0.1 (Edge app window)   │      │  signed command queue     │
 └───────────────┬──────────────────────────────────┘      └───────────────────────────┘
                 │ NTFS, scoped by ACL                optional → AI provider,
                 ▼                                    ONLY via the engine's AI gateway
   Source folders · Library\ · X:\.atlas-quarantine\
```

**Engine layout:**

```text
engine/
  fs/        scanner (batched, file IDs, skips), reader (single pass, tee), executor (journal),
             identity (volume serial + file ID), guards (roots, reparse points, placeholders)
  analyze/   hash, sniff, exif, doc-metadata, extract (V1 extractors), text-quality, ocr (gate), dates
  decide/    dedup (keep policy), classify (rules), name (templates), place (rules → path), planner
  run/       orchestrator (per-file state machine), pools, timers (rescan, purge, backup, update)
  store/     sqlite schema + migrations + repositories + FTS
  ai/        gateway (ledger, cache, breaker, kill switch) + provider adapter   [optional]
  ops/       heartbeat, log shipper, command poller, updater, diagnostics bundle
  api/       127.0.0.1 HTTP API (Host/Origin checked) + static UI
```

---

## 19. Proposed V2 ingestion pipeline

```text
1  Discover     walk roots (fs.opendir streaming); per entry: size, mtime, ctime, attributes,
                volume serial + NTFS file ID (fs.stat bigint). Skip: reparse points, cloud
                placeholders, system dirs, SYSTEM_JUNK, Office lock files (~$*). Per-directory
                errors are recorded and skipped, never fatal. Upsert in batches of ~1,000 per txn.
2  Change-check same file ID + size + mtime as last scan → unchanged: skip everything.
                Same file ID at a new path → it was moved/renamed: update path, no re-read.
3  Size index   GROUP BY size among candidates → which files could possibly have a duplicate.
4  Read once    ONE streaming pass per file that needs reading, teed to: SHA-256, head/tail
                fingerprint, magic-byte sniff, EXIF/document metadata, text extractor
                (worker_thread, memory/time limits). Large media with a unique size and no
                content need: header-only read, full hash deferred until a size twin appears.
5  Content hit  sha256 already analyzed (contents table) → adopt all analysis, skip 6–8.
6  OCR (gated)  only if: a scan-like PDF with no usable text layer, a screenshot, a
                messaging/scanner-app image, or document-like image statistics; script
                detection first, then ONE language set (ara | fra+eng), downscaled.
                Cached by sha256 + engine version + languages.
7  Classify     ordered rules (type, EXIF, path, filename patterns, fr/ar/en keywords,
                dates). First match wins. Store rule id + the evidence that matched.
8  AI (opt.)    ONLY if AI is enabled AND no rule matched confidently AND the file has
                usable text AND the budget allows. Otherwise it stays in "Unsorted" — a
                normal state, not a failure.
9  Dedup plan   exact duplicates = same full sha256. Keep-policy picks the survivor
                (in Library > shorter path > oldest mtime > not "(2)"-like), never across a
                root marked "backup: never dedup".
10 Name         deterministic template per rule; keep the original stem if it is already
                meaningful; Windows-safe (reserved names, trailing dot/space, 255/260,
                NFC, strip bidi controls); collisions → "name (2).ext" via O_EXCL.
11 Place        destination from the rule template, e.g. Library\Photos\2026\2026-07\
12 Plan         a list of ops: move | rename | quarantine — nothing on disk has changed yet
13 Apply        executor runs the plan through the journal (§24); automatic, or one click
                for the first run on a folder
14 Index        commit paths + FTS5 (names, OCR text, extracted text) → Done
```

**How this differs from the brief's hypothesis:**

- Metadata, type detection and hashing are **one read**, not three stages.
- "Fast identification" means change detection and size grouping. It **never
  infers identity from a partial hash.**
- Duplicates skip analysis entirely through the content cache.
- **Destructive work is planned first and applied through a journal.** The
  whole run is then explainable, verifiable and undoable, with no per-file
  approval workflow.

**Default rules, illustrative only; the real set comes from the client's data:**

```yaml
- id: photo-camera
  when: { kind: image, exif: DateTimeOriginal }
  to:   "Photos/{taken:YYYY}/{taken:YYYY-MM}"
  name: "{taken:YYYY-MM-DD HH.mm.ss}"
- id: photo-messaging          # "WhatsApp Image 2026-07-29 at 20.17.33.jpeg"
  when: { kind: image, filename: '^WhatsApp (Image|Video) (\d{4}-\d{2}-\d{2}) at' }
  to:   "Photos/{fndate:YYYY}/{fndate:YYYY-MM}"
  name: "{fndate:YYYY-MM-DD HH.mm.ss} WhatsApp"
- id: screenshot
  when: { kind: image, filename: '^(Screenshot|Capture d.écran)' }
  to:   "Screenshots/{date:YYYY}"
- id: invoice
  when: { kind: document, text_any: [facture, invoice, "فاتورة"] }
  to:   "Documents/Invoices/{docdate:YYYY}"
  name: "{docdate:YYYY-MM-DD} Facture {number?} {party?}"
- id: document-fallback
  when: { kind: document }
  to:   "Documents/{doctype}/{docdate:YYYY}"
- id: unsorted
  to:   "Unsorted"
```

**Schema (SQLite), about 8 tables:**

| Table | Contents |
|---|---|
| `roots` | path, volume, role: source \| library \| backup (never dedup), settings |
| `files` | root, rel_path, size, mtime, volume serial, file ID, attributes, sha256?, state, attempts, last_error, rule_id |
| `contents` | sha256 PK: kind, mime, text, text_quality, ocr_text/conf/engine, exif, doc_meta, doc_date, classification + evidence, ai_result?, analyzer_version |
| `rules` | priority, conditions, destination template, name template |
| `plans` | scope, status, summary |
| `ops` | **the journal**: plan, file, type, src, dst, file ID, size, sha256, state, error, reason |
| `ai_calls` | the ledger: sha256, purpose, model, tokens, cost, status |
| `settings` | configuration |

## 20. Deployment strategy

- **CI:** GitHub Actions on a Windows runner. Unit tests, NTFS integration
  tests and fault-injection tests run, then the build is packaged.
- **Signing:** code-sign the installer and binaries. Azure Trusted Signing is
  the low-cost option; an OV/EV certificate also works. Signing is needed for
  SmartScreen and for update trust.
- **What one installer carries:**
  - the Node runtime and engine;
  - prebuilt better-sqlite3;
  - Tesseract with `fra`/`ara`/`eng` traineddata;
  - a PDF rasterizer (prefer PDFium, which is permissively licensed, over
    GPL poppler; Q12);
  - WinSW.
- **What the installer does:**
  - creates the service account and service, with restart-on-failure recovery;
  - sets "never sleep on AC" (V1's power script);
  - opens the UI.
  - There's nothing else to install: no Postgres, Redis, LibreOffice or
    PowerShell mirror writer.
- **Versioned install:** each release lives in
  `%ProgramFiles%\Atlas\versions\x.y.z\` with a `current` pointer, and the last
  two versions are kept.
- **Migrations:** run at startup, forward-only, after an automatic
  `VACUUM INTO` backup.

## 21. Remote maintenance strategy

| Need | Mechanism |
|---|---|
| Push updates | The engine checks a signed release manifest daily. It downloads, verifies signature and hash, and applies at idle (no journal ops in flight). It restarts, health-checks for N minutes, and **rolls back automatically** on failure. Channels: beta (your test PC), then stable (clients), with a per-install pin. |
| Know it's alive | A heartbeat every 5 minutes carries version, uptime, disk free, files by state, errors per hour, queue depths and the last scan. The dead-man alert catches sleep, power loss, crashes and network loss, which is V1's #1 unexplained outage. |
| Logs | Structured JSON logs, rotated locally. Warnings and errors are always shipped; info on demand. **Paths and filenames are redacted by default**, and a time-boxed "diagnostic mode" ships them with the client's consent. |
| Crash reports | Uncaught exceptions with a stack and redacted context. |
| Remote actions | The engine polls signed, **allowlisted** commands: pause/resume, rescan root, set log level, collect a diagnostics bundle (DB stats, config, recent logs), toggle AI, update or roll back, re-run failed files. **No remote shell** through this channel. |
| Break-glass | Tailscale + OpenSSH (V1's `enable-remote-admin.ps1`) or a remote-desktop tool, installed but used only when the engine itself is dead and an update can't fix it. |
| Honest limit | Hardware faults, BIOS "restore on AC power loss", and a machine that is switched off need someone on site, **once** at install, for the BIOS setting. |

**Build order for the control plane:**

1. Start off-the-shelf:
   - an object-storage release bucket and manifest;
   - an uptime/heartbeat monitor with a dead-man switch;
   - hosted error and log ingest;
   - a ~200-line command/config endpoint.
2. Build a custom fleet dashboard only once there are several clients.

## 22. AI minimization strategy

1. **Off by default.** The core pipeline (§19, steps 1–14 except 8) needs no
   AI and no network.
2. **Never a mandatory stage.** A file that AI didn't enrich is in a normal,
   finished state ("Unsorted" or "original name kept"). So a budget can be
   strict without failing anything, which fixes the reason V1's cap was
   removed.
3. **One chokepoint:** `ai/gateway`. Nothing else can reach a provider. The
   gateway enforces:
   - a global enable flag, also togglable remotely;
   - a **monthly $ cap and a daily call cap, reserved atomically in SQLite
     before each call** and reconciled from reported usage after;
   - per-file (1 call per content hash, ever, per prompt version) and per-run
     limits;
   - concurrency 1–2;
   - a timeout and one retry at most;
   - a circuit breaker (N consecutive failures opens it for M minutes);
   - a ledger row for **every** request, including failures;
   - a cache by `sha256 + purpose + prompt_version + model`.
4. **Narrow scope:** only low-confidence *documents* with usable text. Send the
   first ~3k characters and nothing else: no folder tree, no images, no video.
   Roots can be marked "never send to AI" (HR, legal).
5. **Provider-side limits as defense in depth:**
   - one API key per install;
   - a Google Cloud quota on requests per day;
   - a billing budget alert;
   - prepaid credit with auto-reload off.
6. **Future local-only options, zero API cost:**
   - a small multilingual embedding model (ONNX) for semantic search;
   - a text-detection model for OCR gating.

## 23. Performance strategy

- **Read each byte at most once.** Single-pass tee (§19 step 4). Target read
  amplification ≤ 1.1× the dataset, against V1's ~3× for documents and ~4× for
  images.
- **Don't read what can't matter:**
  - unchanged files: file ID + size + mtime;
  - size-unique large media: header only, lazy hash;
  - placeholders: skipped.
- **Dedup cascade:**
  - size, then head/tail fingerprint (**exclusion only**), then full SHA-256,
    then a byte comparison at quarantine time;
  - the fingerprint also serves as a free rename/move detector alongside the
    file ID.
- **OCR is the dominant cost, so gate it:**
  - script detection;
  - one language set, not three;
  - downscale;
  - cache by hash;
  - *est.* gating images to about 20% needing OCR, at about 2 s over 6 cores,
    turns V1's ~59 hours for 150k images into **about 3 hours**. It must be
    validated in Phase 0 and Phase 11.
- **Resource pools, not job types:**
  - IO pool sized per device (HDD 1–2, SSD 4–8; parallel reads on an HDD are
    slower than serial);
  - CPU pool of `worker_threads` = cores − 1;
  - OCR pool = cores ÷ 2;
  - AI pool = 1–2.
- **Backpressure:** the orchestrator pulls the next N pending files, so memory
  is bounded by pool sizes, not by corpus size.
- **Batched writes:** ~1,000 rows per transaction for the scan. One
  transaction per file for analysis results. Only ops rows and their state
  changes are written per operation.
- **Rescans are metadata-only.** *est.* minutes for 300k unchanged files.
  Later option: the NTFS USN change journal for near-instant incremental scans
  (needs elevated volume access, which is a security tradeoff).

## 24. Data-integrity strategy

1. **Plan, then apply.** Analysis is read-only. Every disk change is an `ops`
   row first.
2. **Write-ahead journal per operation:**
   - insert the op as `planned` and commit (synchronous=FULL for the journal);
   - mark it `in_progress`;
   - perform it;
   - verify;
   - mark it `done` and update `files` **in one transaction**.
3. **Crash recovery at startup:**
   - for each `in_progress` op, locate the file by **volume serial + file ID**
     (a same-volume rename preserves it) at the source or destination;
   - roll forward or mark it not started;
   - never guess.
4. **Moves:**
   - same volume: reserve the destination with O_EXCL (V1's technique), then
     rename over the reservation, then verify the file ID and size;
   - cross volume: copy to `dst.partial`, fsync, **re-hash both**, rename into
     place (O_EXCL), verify, then delete the source;
   - no cross-volume moves by default: each volume gets its own `Library\`.
5. **Duplicates are quarantined, not deleted.** A same-volume rename moves the
   copy into `X:\.atlas-quarantine\<plan>\<original relative path>`, which is
   instant and uses no extra space. It is auto-purged after N days
   (configurable), with one-click restore.
   The Recycle Bin is not used: it silently hard-deletes files larger than its
   quota.
6. **Before quarantining a duplicate**, all of these must hold:
   - the survivor and the victim are **different physical files** (different
     volume serial + file ID, which also catches hard links and overlapping
     roots);
   - **both** have unchanged size and mtime since hashing;
   - both are **byte-compared at that moment** (or both re-hashed);
   - the survivor is not itself queued for quarantine;
   - the victim is not in a `backup` root.
   Any failure means skip it and record why. **This closes R1 and R2.**
7. **Idempotency:**
   - analysis is a pure function of content plus analyzer version;
   - ops are idempotent by file ID;
   - re-planning after apply yields zero ops, and this is tested.
8. **Undo:** the journal is the undo log. "Undo this run" reverses ops in
   reverse order where files are unchanged.
9. **Locked or in-use files** (EBUSY/EPERM): retry later with the attempts
   counter, then list them in "needs attention". Never force.
10. **Backups:**
    - SQLite `VACUUM INTO` nightly and before migrations, keeping 7;
    - the installer should strongly recommend a file backup target, because
      after deduplication the library may be the only copy (Q15).

## 25. Migration plan

Each phase is shippable through the real updater once Phase 1 exists.

| Phase | Scope | New | Removed/retired | Tests | Main risks |
|---|---|---|---|---|---|
| **0 Stabilize and baseline** (≈1 wk) | Commit/tag V1. Urgent items from §0. Build the benchmark corpus and harness. Measure V1 with AI off and on. Get a read-only inventory of the client's data (extension and size histograms). | bench harness, corpus generator (real bytes) | V1's AI spend | V1 baseline numbers | client V1 version unknown |
| **1 Foundation + delivery skeleton** | `engine/` package, SQLite schema/migrations, config, logging, 127.0.0.1 API with Host/Origin checks, WinSW service, installer, **updater + heartbeat** (on a no-op engine) | engine, installer, control-plane v0 | none | install/upgrade/rollback tests | signing procurement |
| **2 Filesystem layer** | scanner, identity, guards, executor + journal + recovery, quarantine | fs/* | `localStorageService`, agent | NTFS edge cases, **kill-at-every-step fault injection** | Windows path edge cases |
| **3 Hash + dedup** | single-pass reader, size → fingerprint → full cascade, keep policy, verified quarantine | analyze/hash, decide/dedup | quick-identity inference, `redundantCopyService` | property tests (never quarantine the last copy), R1/R2 regression tests | keep-policy disagreements with the client |
| **4 Metadata + extraction + OCR** | port extractors and textQuality/documentDate, EXIF, OCR gating + script detection + cache, bundled Tesseract; **Tesseract vs Windows OCR benchmark** | analyze/* | vision/describe AI | golden corpus fr/ar/en | OCR gate accuracy |
| **5 Rename engine** | templates, meaningfulness test, Windows-safe names | decide/name | proposals, auto-decide | golden name tests on real samples | naming taste (Q7) |
| **6 Organization engine** | rule engine + defaults, "why here", plan generation, apply/undo, **adopt an already-organized tree without churn** | decide/place, planner | subjects/AI planner/mirror/relocation | plan invariants; re-plan = 0 ops | the client's V1 tree layout |
| **7 Orchestration** | per-file state machine, pools, backpressure, resume, watcher with self-event suppression | run/* | pgQueue, runner, 20 processors, 3 sweeps | crash/resume, throughput | HDD vs SSD tuning |
| **8 UI** | add folder, progress with ETA, run summary, apply/undo, needs-attention, search (FTS5), rules/settings, quarantine | small React app (port the virtualized table) | 13 V1 pages | Playwright smoke | scope creep |
| **9 Remote ops complete** | log shipping with redaction, crash reports, command channel, diagnostics bundle, rollout channels | ops/* | Tailscale serve, scheduled-task watchdog | chaos tests (network down, disk full) | privacy terms (Q13) |
| **10 Optional AI gateway** | ledger, cache, caps, breaker, kill switch, one provider adapter | ai/* | all Gemini callers | concurrent budget-exhaustion tests | whether to ship it at all (Q8) |
| **11 Scale test + shadow run** | 100/300/500 GB benchmarks; **dry-run on client data** (plan only) and compare with V1 | none | none | §26–27 | real-world surprises |
| **12 Cutover** | install V2, adopt the current tree, optionally import V1 hashes/OCR keyed by path+size+mtime, then decommission V1 | none | Postgres, V1 services and scheduled tasks; **revoke** the Gemini key and Gmail OAuth tokens; remove tailscale serve; archive the V1 DB dump securely (it contains extracted text of every document) | post-cutover verification | rollback path: keep V1 installable for 30 days |

The V1 repository stays untouched until Phase 12. V2 lives in a new top-level
`engine/` package, so both can be built side by side.

## 26. Testing strategy

- **Unit:** templates, rules, sanitization, date parsing, text quality, keep
  policy, gateway budget math. Port V1's tests for retained modules.
- **Property-based:** for any generated tree and plan:
  - no two ops target the same destination;
  - no op quarantines the last copy of a sha256;
  - every quarantined file has a verified distinct survivor;
  - re-plan after apply = ∅;
  - apply then undo restores the original tree snapshot (paths + hashes).
- **Integration, on real NTFS in CI:** scan → plan → apply → verify the tree
  snapshot against golden output, on a fixed mixed corpus.
- **Fault injection:** kill the process at every journal state transition
  (env-driven hook), restart, and assert that every original byte sequence
  still exists at ≥1 location and that the DB matches the disk.
- **Filesystem edge cases:**
  - paths over 260 characters;
  - `CON`/`NUL`;
  - trailing dots and spaces;
  - NFC vs NFD;
  - Arabic, RTL and U+202E;
  - case-only renames;
  - read-only, locked (open in Word), zero-byte and sparse files;
  - hard links, junctions and symlinks;
  - OneDrive placeholders;
  - a file modified mid-hash;
  - disk full mid-copy;
  - access-denied directories;
  - a USB drive unplugged mid-run.
- **Regression tests for this audit's findings:**
  - R1: an inferred or changed victim;
  - R2: overlapping roots / same physical file;
  - R4: a crash between move and commit;
  - the watcher self-loop.
- **AI gateway:** 50 concurrent callers can't exceed the cap; kill switch;
  cache hit; breaker.
- **Upgrade:** install N, then upgrade to N+1 with migrations, then force a
  failed health check and verify rollback.

## 27. Benchmarking strategy

**Datasets.** Use real bytes. V1's pilot corpus averages 15 KB and can't be
used for this.

| Set | Shape |
|---|---|
| tiny | 200k files × 1–10 KB |
| large | 200 × 1–4 GB video |
| photos | 50k JPEG/HEIC with EXIF; include WhatsApp and screenshots |
| documents | 20k PDF/DOCX/XLSX/legacy Office, fr/ar/en, 30% scanned |
| dup-heavy | a 20 GB set copied 3× with renames and moved folders |
| mixed-real | scaled to the client's measured distribution (Phase 0 inventory) at 100, 300 and 500 GB |

**Hardware:** internal NVMe, SATA SSD and an external USB HDD. Results differ
by about 10×, and IO pool sizes are tuned per device class.

**Measure, per stage and end to end:**

- files/s, and MB/s read;
- GB/min end to end;
- hash MB/s;
- OCR pages/s and the **percentage of images OCR'd**;
- CPU % per core, and peak RSS;
- **total bytes read ÷ dataset bytes** (read amplification);
- DB statements per file, and DB size per file;
- AI requests per file and $ per 1k files;
- time to resume after a kill;
- **rescan time for an unchanged tree**.

**How:**

- the engine emits per-stage timing histograms;
- Windows performance counters (`typeperf`) for disk;
- `process.resourceUsage()`;
- a runner that writes JSON and diffs against the V1 baseline from Phase 0.

**Targets are set after the baseline, not before.** Suggested starting points:

- read amplification ≤ 1.1;
- 0 AI calls with AI off;
- rescan of 300k unchanged files < 5 minutes;
- 100 GB mixed on SSD bounded by OCR count, not by stages that read or hash
  files.

## 28. Risks and unresolved questions

| # | Question | Why it matters |
|---|---|---|
| Q1 | Which V1 version runs at the client, with what data volume and mix, and was relocation run there? | Migration path, benchmark realism |
| Q2 | Do people need to browse or search the library from phones or other PCs? | Local UI vs a cloud view; whether Tailscale stays |
| Q3 | One user on that machine, or several accounts? | Whether any auth beyond a local owner is needed |
| Q4 | Organize each drive in place (fast renames), or consolidate into one library (slow cross-drive copies)? | Performance and risk profile |
| Q5 | Should the source folders end up empty (the client's request in docs/13 §13.5)? | Default apply behaviour |
| Q6 | Duplicate policy: quarantine window length; which copy wins; which folders are backups that must never be deduplicated | Data safety (R11) |
| Q7 | Naming convention and folder language (French? Arabic? English? date-first?) | Rename/organize defaults |
| Q8 | Ship AI at all in v2.0? If yes: provider, monthly ceiling, and client consent to send document text | Gateway scope |
| Q9 | Tesseract vs Windows OCR on the client's actual images | OCR quality and speed |
| Q10 | Node/TypeScript (recommended, for reuse) vs Go | Engine runtime |
| Q11 | Code-signing route and cost | Updates and SmartScreen |
| Q12 | Licensing of bundled binaries (Tesseract Apache-2.0 is fine; poppler is GPL, so prefer PDFium) | Distribution |
| Q13 | Telemetry privacy terms with the client (paths are sensitive) | Log design |
| Q14 | Windows 11 Home limits: no RDP; power and BIOS need one on-site visit | Ops runbook |
| Q15 | Where does the *file* backup live? After dedup, the library may be the only copy. | The biggest residual risk to the client's data |
| Q16 | Is "find a file by describing it" something the client actually uses? | If yes, plan local embeddings; otherwise drop it |

**Top risks of the V2 plan itself:**

- **Rule quality on a French/Arabic corpus.** Mitigation: shadow-run on real
  data before any apply.
- **Scope creep back toward V1.** Mitigation: every new component must name
  the requirement it serves.
- **Windows filesystem edge cases.** Mitigation: fault injection plus
  edge-case tests in CI on NTFS.
- **Underestimating OCR volume.** Mitigation: the Phase 0 inventory tells us
  how many images and scans there really are.
