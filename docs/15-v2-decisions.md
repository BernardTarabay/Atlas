# 15. V2 Decisions

This record settles five questions left open by [14-v2-audit.md](14-v2-audit.md)
§16–§19: application form, data architecture, processing model, minimum
pipeline, and the fate of every V1 subsystem. Each decision states what would
make it wrong, so it can be revisited on evidence rather than preference.

> **Revision 2 (2026-09-19):** your answers to docs/14 §28 changed several of
> these decisions. The changed rows below are marked **(rev. 2)**. The new
> designs are in [16-v2-revisions-and-research.md](16-v2-revisions-and-research.md):
> remote access, preview/mirror modes, AI features, search, and the research.

---

## A. What the local application is

**Decision:** Option 5 (a local engine with a hosted control plane), built as
Option 3 (a Node service with a browser UI). In one sentence:

> **Atlas Engine** is a Windows service written in TypeScript on Node. It owns
> all filesystem work, serves its own UI on `127.0.0.1` (opened from the Start
> menu as an Edge app window), and reports to your control plane over outbound
> HTTPS.

Options 1–3 are ways to *package the local program*. Options 4–5 are about
*where the UI, database and control live*. So the real question has two parts,
answered below.

| | 1. Native / Tauri | 2. Electron | 3. Node service + browser UI | 4. Web app + "lightweight" local agent | 5. Local engine + hosted control plane |
|---|---|---|---|---|---|
| **What it is** | Rust core, WebView2 window | Node + Chromium in one app | A Windows service; UI is a local web page | UI and DB in the cloud; an agent on the PC | A topology: any of 1–3 locally, plus an outbound ops channel |
| **Runs unattended for hours, at boot, with nobody logged in** | Only with a separate service; a window app stops at logoff | Same | **Yes**; that's what a service is | Agent: yes | Yes (via 3) |
| **Reuses V1's JS** (extractors, OLE parser, naming checks) | No; Rust rewrite, or a Node sidecar (two runtimes) | Yes | **Yes** | Yes | Yes |
| **Folder selection** | Native picker returns paths | Native picker | The engine's own folder browser in the UI (V1's `filesystemBrowseService`). A browser drag-drop gives file contents, never a path | Must be the agent's browser too; the cloud UI can't see paths | Via 3 |
| **Updates** | Built-in signed updater (updates the window, not a service) | electron-updater (mature) | One self-built updater; **the UI ships inside the engine, so one update covers both** | UI instant; the agent still needs its own updater | Via 3, driven by the control plane |
| **Install size** | ~10 MB (+~40 MB with a Node sidecar) | ~100–150 MB | ~40–60 MB + Tesseract | Agent same as 3 | Same as 3 |
| **Security surface** | Small, allowlisted IPC | Chromium + Node in-process; must track Electron releases for Chromium CVEs | A localhost HTTP server must be defended (below) | Plus a public multi-tenant SaaS holding filenames and OCR text | Same as 3; no inbound ports |
| **Remote maintenance** | Needs a control plane anyway | Needs a control plane anyway | Needs a control plane anyway | Built in (you run the cloud) | **Built in** |
| **Works with no internet** | Yes | Yes | Yes | **No UI without internet** | Yes; telemetry buffers |
| **Verdict** | Good *UI shell* later (tray, native picker, notifications). Wrong home for the engine now | **Reject.** It pays Chromium's size and patch cadence to show a page the system browser already shows, and still needs a service to run unattended | **Build this** | **Not now.** The agent can't be "lightweight" because processing must be local, so it *is* the engine. What you'd add is a SaaS. Reachable later from 5 if Q2 (multi-device) says yes | **Adopt** as the topology |

**Why this is decisive:**

- **Hours-long unattended processing forces a service.** Once there's a
  service, 1 and 2 are only window frames around it.
- **Remote maintenance forces a control plane** whichever frame is chosen.
- **What's left is reuse and simplicity**, which favour 3.

**Required defences for a localhost server** (Electron and Tauri avoid these
by construction):

- bind to `127.0.0.1` only;
- a local owner password with an `HttpOnly`, `SameSite=Strict` session cookie
  (not `localStorage`);
- a **Host-header allowlist**, which blocks DNS-rebinding attacks from web
  pages;
- an **Origin check** on every state-changing request (CSRF);
- no CORS.

**What would change this:**

- If the client needs a tray icon, native notifications or a native folder
  picker, add a ~10 MB **Tauri shell** that only displays the engine's UI. The
  engine doesn't change.
- **(rev. 2) Q2 says remote browsing is core.** It is served by the engine
  itself through a Tailscale tunnel (docs/16 §2). **Not** a cloud copy: the
  files live on the host, so a cloud index would show files nobody can open.

---

## B. Data architecture

**Decision:** **SQLite** (better-sqlite3, WAL) is the engine's system of
record. The control plane has its own small managed Postgres for fleet data
only (devices, heartbeats, releases, commands). No file metadata leaves the
machine by default.

| | SQLite | PostgreSQL (local) | PostgreSQL (cloud) + local cache | Something else |
|---|---|---|---|---|
| **Install/admin on the client PC** | None; it's a file in `%ProgramData%\Atlas` | A server: service, port, password, major-version upgrades (`pg_upgrade` on client PCs), VACUUM/bloat. V1 had 39 MB for 472 rows, and a timezone trap | Local cache (≈SQLite) + cloud DB + sync protocol | — |
| **Fit to the workload** (one machine, one engine process, ≤ a few million rows) | **Exact**: one writer, many readers | Over-fit; multi-process concurrency goes unused | The local journal must stay authoritative for crash safety, so the cloud is a *replica* | — |
| **Durability of the file-operation journal** | WAL + `synchronous=FULL` on journal commits | Excellent | Local part as SQLite; the cloud can't be in the critical path of a file move | — |
| **Throughput** | 100k+ inserts/s in one transaction; point reads are µs | Network round trip per statement (V1: ~150 statements per file) | Adds sync traffic | — |
| **Multilingual full-text search** | **Weakest point.** FTS5 has no French or Arabic stemmers. Needs engine-side normalization (Arabic alef/ya/ta-marbuta variants, tashkeel; French accents) plus JS snowball stemming into extra FTS columns, and/or the `trigram` tokenizer for substrings | **Strongest point.** V1's migration 020 unions the `simple`, `english`, `french` and `arabic` snowball configurations out of the box | Postgres-grade search in the cloud (so the text lives in the cloud) | — |
| **Backups** | `VACUUM INTO` nightly and before migrations | pg_dump + scheduled task (V1's scripts) | Two things to back up | — |
| **Remote diagnosis** | Diagnostics bundle (canned queries) over the command channel; no network port | Remote SQL needs inbound access, which is the V1 problem | Cloud side is queryable | — |
| **Privacy** | Stays on the machine | Stays on the machine | Names, paths and OCR text in your cloud | — |
| **Verdict** | **Adopt** | Acceptable fallback (the persistence layer sits behind repositories); not chosen | **Only if Q2 = yes**, and then prefer an off-the-shelf SQLite-sync product over hand-built sync | See below |

**The "something else" options:**

- **SQLite with an encrypted snapshot upload:** opt-in. It gives disaster
  recovery for the index and lets you inspect a client's state without a
  shell. **Adopt, as an optional feature.**
- **libSQL/Turso** (SQLite with replication): the first thing to evaluate if
  Q2 ever needs a cloud copy.
- **DuckDB:** analytics engine, wrong for transactional writes.
- **LMDB/RocksDB:** no SQL, no FTS.
- **JSON files:** no transactions.
- **Rejected:** DuckDB, LMDB/RocksDB and JSON files.

**What would change this:** if Phase 8 shows SQLite search quality on real
French and Arabic queries is materially worse than V1's, and normalization +
stemming can't close the gap, move the engine to local Postgres. The schema
and repositories are designed so this is a contained change.

**Details decided with this:**

- Identify roots by **volume GUID/serial, not drive letter**. External drives
  change letters.
- Keep the DB outside any OneDrive-synced folder and exclude it from antivirus
  real-time scanning if needed.
- Keep write transactions short, because a long one blocks the single writer.

---

## C. Processing model

**Decision:**

- **per-file durable state**
- **executed by bounded worker pools, one per resource**
- **with a batch barrier before any decision**
- **and filesystem events used only as hints**

No job table for pipeline stages.

| Model | What it's good at | What it costs *here* | Verdict |
|---|---|---|---|
| **One job per stage** (V1) | Independent retry and scaling when stages run on different machines | ~30 job rows per file. Files strand between stages, which needed three recovery sweeps. Stages race on the same row. No global view. 5.2 GB of job and audit history for 48 MB of documents | **Reject** |
| **One job per file** | One durable unit, easy to reason about, resume from a checkpoint | As a *scheduling* unit, a file holds its slot for its whole life, so a 60 s OCR blocks disk reads. No global view for dedup | **Adopt as the unit of state**, not of scheduling |
| **Bounded worker pool** | Matches hardware; natural backpressure | A single pool lets slow OCR starve fast I/O. One pool per job type recreates V1's lanes | **Adopt, one pool per resource:** disk I/O, CPU, OCR, AI |
| **Filesystem-event-driven** | Low latency on new files | Events are lost (sleep, buffer overflow during bulk copies, service down, USB unplugged), duplicated, fired mid-copy, and self-triggered (V1: 1,549 scans in one day) | **Adopt only as a hint** that schedules a reconciliation of a subtree. The scan is the truth. v2.1 |
| **Batch processing** | Global view. Dedup's survivor choice needs *all* copies; size-uniqueness needs a *complete* scan; name collisions need *all* destinations. Deterministic plans, sequential I/O, honest progress | Latency to the first organized file | **Adopt for deciding and applying** |

**Why dedup forces a barrier.** If duplicates were acted on as files arrived,
the kept copy would depend on scan order. The same folder scanned twice could
keep different files. Deciding after all copies are known makes the outcome
deterministic and explainable: "kept this one because it is already in the
Library."

**The shape of a run** (a full run or an incremental one; same code, different
scope):

```text
scan(scope) ─▶ analyze each file (pooled, resumable, per-file state) ─▶ ║ barrier ║
           ─▶ decide globally (dedup, names, destinations) ─▶ plan ─▶ apply (journal) ─▶ index
```

**Answers to the brief's §12:**

| Work | Bound by | Parallelism | Ordering | Retries | Idempotent? | Durable in |
|---|---|---|---|---|---|---|
| Scan | filesystem metadata | one per root; roots on different disks in parallel | none | restart the scan | yes (upsert) | `files` |
| Read + hash | disk | per-device pool: HDD 1–2, SSD 4–8 | none | 3× on EBUSY/EIO, then needs attention | yes | `files.sha256` |
| Extract | CPU | worker threads = cores − 1, with memory/time limits | none | 1 (a parser crash is permanent) | yes (pure) | `contents` |
| OCR | CPU | processes = cores ÷ 2 | none | 1 | yes, cached by hash | `contents` |
| AI (optional) | money, network | 1–2 | none | 1 | cached by hash + prompt version | `ai_calls` |
| Decide / plan | CPU, global | single | deterministic sort | re-run | yes (re-plan after apply = ∅) | `plans`, `ops` |
| Apply | disk metadata | sequential per volume; volumes in parallel | directories before files; verify before quarantine | resume from the journal | yes, keyed by file ID | `ops` (journal) |
| Index | DB | single writer | after apply | re-run | yes | FTS tables |

No queue broker and no job rows. Periodic work (rescan, quarantine purge,
backup, update check, heartbeat) is in-process timers.

---

## D. Minimum V2 pipeline

Your sketch was close. This version makes four structural changes, explained
after the diagram.

```text
RUN  (scope = a root, or the new/changed files of an incremental run)

 1  SCAN             enumerate; size, mtime, attributes, volume + NTFS file ID
                     skip: reparse points, cloud placeholders, system dirs, junk, ~$ lock files
                     per-directory errors recorded, never fatal
 2  IDENTITY FILTER  unchanged (same file ID + size + mtime)            → stop
                     moved/renamed (same file ID, new path)             → update path, stop
                     size-unique and no content needed (e.g. video)     → defer hash
                     ↳ may SKIP work; never concludes two files are identical
 3  READ ONCE        one stream → SHA-256 + head/tail fingerprint + type sniff
                                  + header metadata (EXIF, PDF/Office properties)
 4  CONTENT CACHE    sha256 already analyzed → adopt everything, skip 5–7
                     ↳ this is where DEDUP DETECTION saves work
 5  EXTRACT          text + document metadata (re-read hits the OS page cache)
 6  OCR?             only if gated in; detect script → one language set; cached by hash
 7  CLASSIFY         ordered deterministic rules; store rule id + matched evidence
                       │
                       └─ no confident rule? ──▶ AI FALLBACK (optional, see below)
                                                    │ yes → category/title hint
                                                    │ no  → "Unsorted" (a normal state)
 ══════════════ barrier: every file in scope analyzed ══════════════
 8  DEDUP DECIDE     groups by full sha256 → keep policy → quarantine list
 9  NAME + PLACE     one target path per kept file (template → folder + name, collisions resolved)
10  PLAN             nothing on disk has changed yet; summary shown or auto-applied
11  APPLY            journaled: re-verify → quarantine duplicates → move/rename
12  INDEX            final paths + FTS → complete
```

**The four changes to your sketch, and why:**

1. **METADATA moves into READ ONCE.** Header metadata and EXIF come from the
   same stream as the hash. As a later stage, it re-reads the file, which is
   V1's 3× read. Only heavy text parsing is separate, and its re-read is served
   from the OS page cache, so physical disk reads stay at about 1×.
2. **DEDUPLICATION splits in two.**
   - **Detection** is immediate (step 4): a known hash skips extraction, OCR
     and classification.
   - **Decision and action** wait for the barrier (steps 8 and 11), because
     choosing the survivor needs every copy *and* every destination ("prefer
     the copy already in the Library"). Removal also belongs inside the
     journaled, byte-verified apply, not in an analysis stage.
3. **RENAME and ORGANIZE become one computation and one operation.** The
   target is a single path, and collision resolution needs the folder and name
   together. On disk it's one `MoveFileEx`. Two steps would mean two journal
   entries and a half-done state in between.
4. **PLAN/APPLY is the safety boundary.** Everything before step 11 is
   read-only. That's what makes a run previewable, verifiable and undoable
   without a per-file approval workflow.

**AI is a fallback, never a stage.** Step 7's branch is taken only when
**all** of these are true:

- no rule matched confidently;
- the file has usable text;
- AI is enabled (locally and remotely);
- the root isn't excluded from AI;
- the budget reservation succeeds;
- the cache misses.

The result may only pick an *existing* category and suggest a title. It
creates no folders and never touches the disk; it feeds the same plan. **Any
failure means "Unsorted", which is a finished state, not an error.** No file
ever waits on AI.

**Inside v2.0 (rev. 2):**

- steps 1–12, with step 11 in **preview or mirror mode only**;
- the V1 extractors and EXIF;
- **thumbnails and local embeddings** (added to steps 3–5; CPU pool);
- OCR gating and the rule set;
- FTS + vector search;
- the AI features in docs/16 §4, behind the gateway;
- periodic and manual rescans;
- remote access through Tailscale.

**Deferred:**

- **destructive apply** (moves and verified quarantine), until a deletion
  policy is set (Q6);
- filesystem-event hints;
- near-duplicates;
- local image-text search (spike S8 decides);
- NTFS USN-journal scanning.

---

## E. What happens to V1

The five verdicts, with one-line meanings:

| Verdict | Meaning |
|---|---|
| **REUSE** | Port the code into the engine, with its tests, and adapt at the edges |
| **REWRITE** | The capability stays; the V1 implementation is replaced (its ideas may carry over) |
| **REMOVE** | The capability is not in V2 |
| **MIGRATE** | Data or configuration carried from V1 into V2 at cutover |
| **DO NOT TOUCH** | Leave exactly as is, for the stated period and reason |

Where code and data differ, both verdicts are given.

### Core file processing

| Subsystem | Verdict | Notes |
|---|---|---|
| Extractors: `extraction/*` (pdf, docx, xlsx, pptx, pbix), `ole/*`, `utils/cfb.js` | **REUSE** | Hard-won legacy Office and code-page handling; tested |
| `textQuality.js`, `documentDate.js` | **REUSE** | The gate against naming from garbage; date resolution |
| `fileSignature.js`, `mimeGuess.js`, `imageDetection.js` | **REUSE** | Type sniffing and routing |
| `cloudPlaceholder.js` | **REUSE** | Critical: prevents OneDrive/iCloud mass hydration |
| `pathSafety.js`, `pathOverlap.js`, `filenameSafety.js`, `resolveAvailableFilename.js` | **REUSE** | Extend with file-ID identity and bidi-control stripping |
| `hashingService.sha256AndFingerprint` | **REUSE** | Single-pass hash + fingerprint; the semantics change (below) |
| `quickIdentityService` (inferred hashes) | **REWRITE** | The fingerprint may only *exclude* identity, never conclude it |
| `knownContentService` (twin adoption) | **REWRITE** | Becomes the content-addressed `contents` cache |
| `scanProcessor` | **REWRITE** | Keep the `SYSTEM_JUNK` list and one-scan-per-root. Add batching, file IDs and error tolerance |
| `LocalStorageService` | **REWRITE** | Keep the O_EXCL name reservation. Add the journal, a verified cross-volume path, and quarantine instead of unlink |
| Exact-duplicate detection + auto-resolve | **REWRITE** | Global keep policy after the barrier |
| `redundantCopyService` (on-disk deletion) | **REWRITE** · V1: **disable now** | Verified quarantine: distinct file IDs + byte comparison of both copies. **(rev. 2)** Designed, but not enabled in v2.0: no destructive dedup until the policy is set |
| `ocrEngine.js`, `pdfRasterizer.js` | **REUSE** | Engine detection and invocation. Bundle Tesseract; prefer PDFium over poppler |
| OCR gating and language choice | **REWRITE** | Script detection → one language set; gate by image kind |
| Classification (`classifyProcessor`) | **REWRITE** | Ordered deterministic rules with stored evidence |
| `taxonomyMatcher.js` | **REUSE** | Becomes the rule engine's keyword condition |
| Title vetting: `isUsableTitle`, `isBoilerplateTitle`, `looksLikeMojibake`, `sanitizeTitle`, `capFilenameLength` | **REUSE** | The best part of V1 naming |
| Name builder (`namingService.buildCanonicalName`) | **REWRITE** | Deterministic templates; keep the original name when it's already meaningful |
| Near-duplicates (`similarityService`), `detect_versions` | **REMOVE** | Optional later; the code is parked in git history |

### AI

| Subsystem | Verdict | Notes |
|---|---|---|
| `geminiClassifier` | **REWRITE (rev. 2)**, in v2.0 | Becomes the organization assistant: **one call per cluster** of unsorted files, proposing a *rule* (docs/16 §4) |
| Vision / media / summary describers, `descriptionService` | **REMOVE** | ~2 paid calls per file for a non-core feature |
| `embeddingService`, `descriptionSearchService` (semantic search) | **REWRITE (rev. 2)** | A local multilingual embedding model with no API cost. **REUSE** V1's RRF fusion and its query/description asymmetry lesson |
| `folderPlanner`, `folderConsolidator`, `unfiledOrganizer` + scheduler | **REMOVE** | The AI invented folders; replaced by rules |
| Chat assistant (`geminiChatService`, `AssistantPanel`, `ai_*` tables) | **REWRITE (rev. 2)** | Becomes "ask about this file" and "ask the library": user-initiated, budgeted, on locally retrieved snippets |
| `rateLimiter.js` | **REMOVE** | Replaced by the gateway's budget ledger and circuit breaker |
| Gemini API key | V1: **revoke at cutover** | V2 gets a new per-install key with provider-side quotas, if AI ships at all |

### Orchestration and persistence

| Subsystem | Verdict | Notes |
|---|---|---|
| `workers/runner.js` + 20 processors | **REWRITE** | The per-file orchestrator with resource pools |
| `pgQueue.js` | **REMOVE** from the engine | Sound design; keep it as the reference if the control plane ever needs a queue |
| `fileRecovery`, `pipelineState`, stale-job sweep | **REMOVE** | Nothing strands when a file's pipeline is one resumable unit |
| Schedulers: trash purge, retention, email, organize-unfiled | **REMOVE** | Replaced by in-process timers for rescan, quarantine purge, backup and update |
| `storageWatcher` | **REWRITE** (v2.1) | Hints only, with suppression of the engine's own writes |
| PostgreSQL schema (40 tables, 46 migrations) | **REWRITE** as SQLite (~8 tables) | |
| V1 Postgres database | **DO NOT TOUCH** until cutover · then **MIGRATE** a subset (below) and archive | Read-only source for migration. It contains every document's text, so archive it securely |
| `audit_logs` | **REWRITE** · history **MIGRATE** (subset) | Journal + structured logs replace it |
| Trash / archive (`lifecycleService`) | **REWRITE** | Becomes the file quarantine |
| Triage, Failed page, `needs_user` flows | **REWRITE** | A plain "needs attention" list |
| `config/env.js` `secret()` validation | **REUSE** | Refuses placeholder and short secrets |
| Search filters (`fileFilters.js`), multilingual search (migration 020) | **REWRITE** | On FTS5 with engine-side normalization and stemming. Keep migration 020's lessons and the `::date` timezone lesson |
| Dashboard, `pipelineHealth` | **REWRITE** | Progress view + heartbeat metrics |

### Product surface, access and operations

| Subsystem | Verdict | Notes |
|---|---|---|
| Express API, ~20 route groups, controllers | **REWRITE** | About 10 local endpoints |
| JWT, refresh tokens, RBAC, per-user ownership | **REWRITE** | One owner, session cookie. **(rev. 2, Q3)** RBAC and ownership removed. An optional support account sees diagnostics only, unless the owner grants time-boxed access |
| Users, roles, permissions data | **REMOVE** | Nothing to carry into a single-owner engine |
| React frontend (13 pages) | **REWRITE** | Port the `react-window` virtualized library list, `ConfirmDialog`, `Modal`, toasts, `lib/fileType.js`, and `utils/format.js` |
| PWA, service worker, mobile gestures | **REUSE (rev. 2)** | Remote browsing is core: `sw.js` and its tests, `touchGestures`, `MobileLibrary`/`MobileRow`, `shareFile`, `openFile` |
| Photos workspace | **REWRITE (rev. 2)** | Becomes a thumbnail grid organized by date, the main remote photo view |
| Shortcut mirror (`mirror/*`, PowerShell .lnk writer) | **REWRITE (rev. 2)** | Becomes mirror mode (docs/16 §3): a native `.lnk` writer with no PowerShell, plus opt-in hard links with divergence detection. **REUSE** the MAX_PATH and quote-character lessons |
| `relocate-into-organized.js` | **REMOVE** | Its *result* on disk is DO NOT TOUCH (below) |
| LibreOffice thumbnails | **REWRITE (rev. 2)** | Images via `sharp`, PDF page 1 via PDFium; cached by content hash; no LibreOffice |
| Email inbox (Gmail OAuth, triage, sync) | **REMOVE** | V1: **revoke the OAuth tokens at cutover** |
| Devices, `file_replicas` | **REMOVE** | 1 device, 0 replicas |
| Electron desktop agent + `agentService`, agent routes and tables | **REMOVE** | Never registered. Its error-tolerant `walk()` is **REUSED** in the scanner |
| `start-atlas.bat`, `restart-atlas.bat`, `run-hidden.vbs`, `install-autostart.ps1`, watchdog | **REMOVE** from V2 · **DO NOT TOUCH** on the V1 host until cutover | Replaced by the service + installer |
| `configure-server-power.ps1` | **REUSE** | Becomes an installer step (never sleep on AC) |
| `atlas-doctor.ps1` | **REWRITE** | Becomes the diagnostics bundle |
| `backup-database.ps1`, backup schedule, restore check | **REMOVE** from V2 · **DO NOT TOUCH** on the V1 host until cutover | V1's backups must keep running while V1 is live |
| `install-tailscale-serve.ps1`, `enable-remote-admin.ps1` | **REUSE (rev. 2)** | `install-tailscale-serve.ps1` is now the remote *user-access* path (Q2). `enable-remote-admin.ps1` stays optional break-glass. Maintenance still runs over the control plane |
| Unit tests for reused modules | **REUSE** | |
| `verify-*` scripts | **REWRITE** | As V2 integration and fault-injection suites; keep their philosophy |
| `generate-pilot-corpus.js` | **REWRITE** | It must produce real-sized bytes |
| docs/01–13 | **DO NOT TOUCH** | Historical record of V1. Add only a "describes V1; see docs/14" banner. Don't "fix" them into describing V2 |

### Data carried across at cutover (MIGRATE)

| Data | Rule |
|---|---|
| Storage locations | → V2 roots. The writable "Organized" location → the Library root. Read-only sources → source roots. A backup folder → `backup` role (never deduplicated) |
| SHA-256 hashes | **Only `hash_source = 'computed'`**, and only where the file on disk still matches V1's size + mtime. **Never inferred hashes.** |
| OCR text (`file_ocr`) | Seeds the `contents` cache by sha256. Saves the most expensive recomputation |
| Previous filenames (`file.renamed`, `file.canonical_name_set` audit rows) | → searchable aliases, so a file can still be found by the name it had before V1 renamed it |
| User-created subjects (`origin = 'user'`, 7 here) | → seed rules / folder names |
| V1 deletion records (`file.redundant_copy_deleted`) | → a read-only archive, the only record of what V1 removed from disk |
| Not migrated (cheaper and safer to recompute) | extracted text, document dates, classifications, duplicate groups, AI titles and summaries (the titles already *are* the filenames), AI-created subjects as rules, users, secrets |

### DO NOT TOUCH, consolidated

- **The client's running V1 install:** until V2's shadow run passes. The only
  exceptions are the urgent actions in docs/14 §0 (AI off, redundant delete
  off, host power and boot fixes).
- **The client's files as V1 organized them:** V2 adopts the existing tree in
  place and organizes only what's new or unsorted, unless the client asks for
  a reorganization.
- **The V1 database:** read-only, used as the migration source, then archived.
- **V1's backup schedule and host scripts:** until cutover.
- **The V1 codebase:** V2 lives in a new `engine/` package. V1 changes only
  for the urgent fixes.
- **docs/01–13:** historical record.
