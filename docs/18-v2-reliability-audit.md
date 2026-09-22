# 18. V2 reliability audit (Phase 0)

**Audit date:** 2026-09-22, at commit `d668ddd` (branch `v2`). **Scope:** `v2/` only. The V1 `backend/` and `desktop-agent/` are not covered.

**Method:** I read every source file on a write path, traced each call chain, and wrote one probe script per open question:

- a worker running out of memory;
- a write to a dead OCR helper's pipe;
- whether Node's `renameSync` overwrites an existing file on Windows;
- a read-only pass over the live dev database (281 MB, 7,057 files).

**Test baseline:** `npm test` gives 56 passing, 0 failing. `bench/crash.ts` already exists: it kills the engine hard during a scan, restarts it, and compares the end state against a clean run.

References are `file:line` inside `v2/`.

---

## 0. The contradiction to settle first

**Atlas V2 never changes a user's file.** The plan's Phases 6 to 8 assume operation states called PLANNED, STARTED, DONE, FAILED and UNDONE. Those exist only as a comment on the `ops.state` column (`src/db/schema.ts:88-102`). No code writes to `ops`; the table is empty in the live database.

Every "move" or "rename" in the product today is plan-only: it writes `files.pin` or `files.pinname`.

So the filesystem-mutation part of this audit comes in two halves:

- **What exists:** Atlas only writes inside its own home folder (§3).
- **What doesn't exist yet:** Apply. For Apply, the crash matrix in §8 is a **specification** the future code must meet, not a description of current behaviour.

---

## 1. Architecture and code-path map

```
main.ts
 ├─ Db (db/db.ts): ONE node:sqlite connection on the main thread. It is the only writer.
 ├─ Engine (pipeline/engine.ts): a scheduler loop; each tick is synchronous
 │   ├─ maybeScan ─► scanRoot (scan/scanner.ts), one root at a time
 │   │     └─ walk (scan/walker.ts) ─► child process bin/atlas-walk.exe (native/walk.cs)
 │   │           streams "V/D/F/E/Z" lines; each batch of 2000 is one db.tx upsert
 │   │     after the walk, one db.tx: markMissing ─► adoptKnown ─► roots.gen++
 │   ├─ dispatch ─► AnalyzePool (pipeline/pool.ts): N worker_threads, one job each
 │   │     worker.ts: open ─► read all ─► sha256 ─► compare size+mtime before/after
 │   │                ─► "hash" ─► main decides (is this content new?) ─► "go"
 │   │                ─► analyze (only new content) ─► "done" | "err"
 │   │     pool: one 180 s deadline per job; on expiry terminate + respawn; a crash also respawns
 │   ├─ flush: one db.tx: contents upsert, texts, fts_text, link files (NEW→IDENT), failures
 │   ├─ dispatchOcr ─► OcrService (ocr/ocr.ts) ─► WinRt helper processes (atlas-winrt.exe)
 │   │     120 s deadline per call; on expiry kill + respawn on the next call
 │   ├─ flushOcr: one db.tx: texts 'o', fts_text, dtype, re-plan (DONE→IDENT)
 │   └─ planBatch (plan/planner.ts): one db.tx per 1,000 IDENT rows ─► DONE with plan
 ├─ HTTP (server/http.ts): same thread, same connection; the write routes are
 │     plan/move, plan/pin, plan/rename, roots add/patch/delete, scan, auth
 ├─ Thumbs (thumbs.ts): 2 more WinRt helpers; on demand; cache under <home>/thumbs
 └─ timers: rescan every 60 min (main.ts:32); @@alive every 10 s to AtlasService.exe
AtlasService.exe (native/AtlasService.cs): restarts the engine with backoff (1 s → 60 s)
     and kills it after 120 s without @@alive
```

**Worker ⇄ database:** workers never open the database. Everything goes through `postMessage` to the main thread. There is exactly one writer, so SQLite concurrency is never a factor.

---

## 2. State machines (as implemented)

### `files.state`: NEW 0 · IDENT 20 · DONE 50 · MISSING 70 · FAILED 90

| From → To | Where | Guard |
|---|---|---|
| (none) → NEW, or IDENT for a cloud placeholder | scanner UPSERT insert (`scanner.ts:29-30,71`) | none |
| any → NEW/IDENT, with content = NULL and tries = 0 | UPSERT (`:37-38,42-43`) | size, mtime or the placeholder bit changed |
| MISSING → IDENT (content known) or NEW | UPSERT (`:39`) | the file is seen again at the same path |
| **FAILED → NEW, tries = 0** | UPSERT (`:40,43`), and the "unchanged" shortcut deliberately skips FAILED rows (`:66`) | **none: this happens on every scan** |
| any except MISSING → MISSING, plan = NULL, name released | markMissing (`:119-122`) | complete walk, root present, ≤100 unreadable folders, not under an unreadable folder |
| NEW → IDENT, content adopted | adoptKnown (`:141-145`) | same fid, size and mtime as a known row |
| MISSING row → **deleted** | adoptKnown (`:148-151`) | its fid is now on a live row |
| IDENT/DONE → NEW, content = NULL | adoptKnown hard links (`:155-160`) | a sibling name of the same fid changed |
| NEW → IDENT | flush `link` (`engine.ts:413`) | `state = NEW` |
| NEW → NEW or FAILED, tries+1 | flush `fail` (`:414`) | `state = NEW`; FAILED at tries ≥ 3 |
| **any → MISSING** | flush `gone` on ENOENT (`:415,455`) | **no guard: plan and name index are kept** |
| DONE → IDENT | replanGroup, replanTitle, flushOcr, releaseName, replanRep | `state = DONE` |
| IDENT → DONE | planBatch setPlan/clearPlan (`planner.ts:66-67`) | none |
| **any → IDENT, plan = NULL** | planBatch `evict` (`planner.ts:70,126`) | **none** |
| DONE → IDENT (pin set) | `/api/plan/move`, `/api/plan/pin`, `/api/plan/rename` | **`state = DONE` only: see §5** |
| DONE → IDENT | PATCH root role (`http.ts:394`) | `state = DONE` |

**Crash safety.** Every transition is a single SQL statement inside a transaction. Work in flight lives only in memory, so a crash replays it: rows below DONE are picked up again, and contents are keyed by SHA-256 so replay is idempotent. That core claim holds.

**Transitions that can leave an ambiguous or wrong state:**

1. **FAILED is never terminal.** Every hourly scan resets it, so a poison file costs up to 3 × 180 s of a worker per hour, forever.
2. **ENOENT → MISSING skips markMissing's rules.**
   - It happens even when the whole drive has vanished: a removed drive letter typically surfaces as ENOENT, so a USB drive unplugged mid-queue can turn queued files MISSING one by one.
   - The row keeps `plan` and its `fts_name` entry. Library listings (`library.ts:33-35`, filtered on `plan` only) and search (`search.ts:37-38`) then show a **ghost file**.
   - Nothing re-plans its duplicate group.
   - The rows do come back on the next scan.
3. **`evict` can turn a NEW row into IDENT.** A file that was edited keeps its old `plan` while it is NEW. If another file sorts ahead of it and claims that name, evict sets it to IDENT with `content = NULL`. The planner then files it with no analysis, and it is **never hashed** until it changes again.
4. **FAILED(TIMEOUT) is the normal fate of large files on slow disks.**
   - The 180 s deadline covers read + hash + analyze, whatever the file size (`pool.ts:61`, `config.ts:56`).
   - Largest file that can ever finish: about 18 GB on a 100 MB/s disk, 5 GB on USB 2, and around 1.8 GB on a 10 MB/s network share.
   - Anything larger is re-read 3 times per scan, every hour.
5. **A continuously written file is re-read every minute.** An UNSTABLE result sets an in-memory `retryAt` of 60 s with no escalation (`engine.ts:456`). The file stays NEW and is re-read in full every minute for as long as it keeps changing: a growing log, an Outlook `.ost`, a VM disk.

### `contents.ocr`: NA 0 · PENDING 1 · DONE 2 · FAILED 3 · NO_ENGINE 4

- PENDING is set by analysis (`analyze.ts:72,127`). PENDING → DONE or FAILED happens in flushOcr.
- **FAILED is terminal whatever the cause** (`engine.ts:353-357`): an unplugged drive, a locked file, a helper crash or timeout, or genuinely unreadable content. Only an analyzer-version bump puts it back to PENDING, through `upsertFull`, and even that only when some copy is re-hashed.

### `ops.state`: PLANNED 0 · STARTED 1 · DONE 2 · FAILED 3 · UNDONE 4

Schema only; no code. The schema cannot yet support recovery: it records no expected SHA-256, no temporary path and no volume. See §8.

---

## 3. Filesystem mutation map

**User files: none.** Atlas opens user files only to read them:

| Reader | How it opens files | Effect on the user |
|---|---|---|
| Node worker (`worker.ts:54`) | `fs.openSync(path, "r")`; libuv shares read, write and delete | none; the user can save, rename or delete meanwhile |
| Second read for files over 32 MB (`worker.ts:100`) | `readFileSync` by **path** | none |
| Walker (`walk.cs:61,75`) | directory handle, `FILE_LIST_DIRECTORY`, share all | none; no file is opened |
| WinRT OCR, thumbnails (`winrt.cs:76-77,129,142,168`) | `StorageFile.OpenAsync(Read)` | **INVESTIGATE:** the default WinRT share mode may refuse writers, so a user's save could fail with "in use" during a page OCR (seconds) |

**Atlas's own home folder:**

| Path | Operation | Crash behaviour |
|---|---|---|
| `atlas.db`, `-wal`, `-shm` | SQLite | see §4 |
| `logs/atlas-YYYY-MM-DD.log` | append with `writeSync`; delete files older than 14 days (`log.ts:18-31`) | torn last line at worst; errors swallowed |
| `thumbs/ab/<sha>-<size>-v2.img` | helper writes `<out>.<pid>.tmp`, then Node `renameSync` (`thumbs.ts:98-101`); `rmSync(tmp)` on failure | a crash leaves `.tmp` litter that is never cleaned. The rename is not fsynced, so after a power loss the final name can hold unflushed garbage, served as immutable **forever** |
| `setup-code.txt` | write on first run; delete after setup (`auth.ts:26,37`) | harmless |

**An Apply prerequisite, verified on this machine:** `fs.renameSync(a, b)` onto an existing `b` **succeeds and silently overwrites `b`**; Node passes `MOVEFILE_REPLACE_EXISTING`. By contrast, `copyFileSync(…, COPYFILE_EXCL)` and `linkSync` both refuse with EEXIST, including for a name that differs only in case. **Apply must never use `fs.rename` onto a destination it has not proven absent.** A no-replace move needs `MoveFileExW` without that flag, called from a native helper, or `link` + `unlink`.

---

## 4. Database transactions and durability

**Configuration** (`db.ts:18-26`): WAL, `synchronous=NORMAL`, `temp_store=MEMORY`, `cache_size` 64 MB, `mmap_size` 256 MB, `busy_timeout` 5 s. Foreign keys are off and none are declared. `durable()` (`db.ts:75-82`) switches to FULL for one transaction, but **nothing calls it**.

**Write paths:**

| Write | Boundary | Crash before commit | Power loss after commit (NORMAL) |
|---|---|---|---|
| Scan batch upsert, 2000 rows | `db.tx` (`scanner.ts:62`) | rolled back; next scan redoes it | may be lost; next scan redoes it |
| Scan finalize: missing + adopt + gen | one `db.tx` (`:90`) | rolled back; nothing marked missing | may be lost; redone |
| Worker results | one `db.tx` per flush (`engine.ts:424`) | rows stay NEW and are re-read | re-read (hash again) |
| OCR results | one `db.tx` (`:343`) | stays PENDING; OCR again | OCR again (expensive) |
| Planning | one `db.tx` per 1,000 (`planner.ts:76`) | re-planned; deterministic | re-planned |
| **Pin, folder move, rename** (user intent) | `db.tx` / autocommit (`http.ts:259,268,344`) | the UI gets an error | **silently lost after the UI said "done"** |
| **Add or delete a root** (user intent) | autocommit / `db.tx` | error returned | **silently lost** |
| **PATCH root role** | **two autocommits** (`http.ts:393-394`) | role changed but files not re-planned | same |
| Sessions, password | autocommit | sign in again | sign in again |
| Migrations | one tx each, together with the `schema` meta row (`db.ts:98-107`) | clean | clean |

**The durability policy doesn't separate what matters.** Everything is NORMAL: a user's decision is as durable as a cache entry.

| User intent (must survive) | Derived (rebuildable) |
|---|---|
| `files.pin`, `files.pinname` | the rest of `files`: path, size, mtime, fid, state, content, plan, rule, tries, err |
| `roots` path, role, enabled | `contents`; `texts` (**expensive**: 3,936 OCR'd contents here); `fts_text`, `fts_name`; thumbnails |
| the future `ops` journal (history) | `roots.gen`, `scan_*`, `online`, `volume`, `fs`; logs |
| password hash (meta) | sessions (not intent) |
| undo stack: **browser memory only** | status-page layout: browser `localStorage` |

**A structural problem:** intent is stored *on* a derived row, keyed by `files.id`. If the database is rebuilt, the pins have nothing to re-attach to. And today they are deleted in the most common case, so this is not hypothetical (§5).

**Where the database can disagree with the disk:**

- stale `size`/`mtime` between scans (by design; up to an hour);
- ghost MISSING rows that keep a plan (§2 #2);
- IDENT rows with no hash (§2 #3);
- orphan rows from deleting a root mid-scan (§6);
- OCR text or thumbnails generated from bytes that changed after hashing (§6).

**Exception safety:**

- **Stuck in memory:** `flush` and `flushOcr` empty their in-memory queues *before* the transaction. If it throws (disk full, I/O error), the results are dropped, which is fine because they are redone. But the `inflight`, `extracting` and `ocrInflight` entries are never released, so **those files are stuck until restart**.
- **Error masking:** `db.tx` rolls back on error. If the ROLLBACK itself throws, it hides the original error.

---

## 5. Path versus identity

Atlas works with these identifiers:

| Concept | Stored as | Treated as |
|---|---|---|
| Root | `roots.path`, absolute, **drive letter included**, UNIQUE NOCASE | the root's identity. `roots.volume` (32-bit serial) is written every scan (`scanner.ts:95`) but **never read** |
| File instance | `(root, path)`: relative, `/`, original case; unique index is **case-sensitive** | the row's identity (and so intent's) |
| Physical file | `fid` = `volserial:FileId` (64-bit), NTFS/ReFS only (`walker.ts:36`) | "same file": used for adoption (moves) and aliases (hard links) |
| Change detector | size, mtime, placeholder bit | whether to re-read |
| Content | `contents.sha` (SHA-256) | byte equality: dedup, analysis reuse, thumbnails, OCR |

**Where the concepts are wrongly conflated:**

1. **Intent lost on every Explorer rename or move of a pinned file** (`scanner.ts:140-151`). Adoption gives the new row the old row's *content* but not its `pin`/`pinname`, then **deletes the old row**. The fid match proves it is the same physical file, so carrying the intent across is safe; it simply isn't done. **This is a certain loss on a common action.**
2. **Intent silently dropped by the API.**
   - `/api/plan/move`, `/api/plan/pin` and `/api/plan/rename` only update rows in `state = DONE` (`http.ts:257,266,344`).
   - A file in NEW or IDENT (being re-read, or re-planned for the 250 ms after an OCR result) is skipped.
   - `rename` returns success regardless; `pin` updates `pinname` without the guard (`:276`). That's inconsistent.
3. **The drive letter is the root's identity.**
   - **E: comes back as F::** the root reads as offline. Re-adding it creates a new root, and its pins are stranded.
   - **A different disk mounted as E: with the same folder name:** it is scanned *as the same root*. Every old row goes MISSING, and rows with equal size and mtime are silently assumed unchanged.
4. **Case-insensitive plan collisions** (`planner.ts:69`: `plan = ?` is a binary comparison, and Windows names are case-insensitive).
   - **One live instance:** GovDocs files 3092 and 3094 are planned as `Documents/Notes/2006/2006-03-28 WWL Data Point Analysis.txt` and `…WWL DATA POINT ANALYSIS.txt`.
   - That is the **same path on disk**, so Apply would collide. Harmless while Atlas is plan-only; **a blocker for Apply**.
5. **SHA-256 used as logical identity in planning.**
   - Byte-identical files collapse to one representative; the others are labelled `duplicate` with `plan = NULL`. That is fine for a view.
   - Apply must **never** read "duplicate" as "safe to delete": byte equality doesn't make two files the same document, for example the same blank form filed for two clients.
6. **ReFS file IDs are 128-bit;** the walker reads the 64-bit `FileId` field. Windows 11 Dev Drives are ReFS. **INVESTIGATE** whether that field is stable and unique there before trusting it for adoption.
7. **The fallback Node walker** (used only if `atlas-walk.exe` is missing):
   - It assigns a `fid` on FAT/exFAT, where it isn't stable.
   - It records a *file*'s `stat` error as a *directory* error, so a file whose `stat` fails (for example, access denied) is marked MISSING (`walker.ts:137` with `scanner.ts:115`).

---

## 6. Worker reliability

**Probed and found safe:**

- A worker that runs out of memory is contained (`ERR_WORKER_OUT_OF_MEMORY`; the main thread survives, with or without `resourceLimits`).
- Writing to a dead helper's stdin did not crash the process.
- Hash-during-write detection works (`worker.ts:79-84`).
- A parser exception becomes `a.error` and the file still completes (`analyze.ts:105`).
- One hung parser costs one worker for 180 s, then the worker is replaced.

**Failure modes found:**

| # | Problem | Consequence | Severity |
|---|---|---|---|
| W1 | Fixed 180 s deadline for read + hash + parse | big files on slow disks can **never** finish; re-read 3× per hour forever | High |
| W2 | FAILED reset every scan | a poison file costs up to 9 worker-minutes per hour, forever | High |
| W3 | UNSTABLE retried every 60 s, no escalation | a continuously written file is re-read in full every minute | Medium |
| W4 | ENOENT → MISSING directly | an unplugged drive turns queued files MISSING; ghost entries | Medium |
| W5 | OCR FAILED for transient causes | files on a drive that was offline during OCR are never OCR'd | Medium |
| W6 | OCR (`engine.ts:326`), second read (`worker.ts:100`) and thumbnails read **by path** without checking the bytes still match the hashed content | a file changed after hashing yields text, analysis or thumbnail stored **under the old SHA, permanently** | Low-medium |
| W7 | Ids are reused (no AUTOINCREMENT) and in-flight results are keyed by id | delete root → add root: a late result can link wrong content to a new row (self-heals next scan). A late OCR result can write text onto an **unrelated** content (permanent) | Low |
| W8 | In-flight bookkeeping leaks when a flush throws | affected files stall until restart | Low |
| W9 | A worker blocked in `readSync` on a hung share can't be interrupted | a thread leaks until the call returns; the pool keeps going | Low |
| W10 | Up to 256 MB second read per worker × 6 workers | about 1.5 GB of peak memory in the worst case | Low |

**Can one pathological file stall Atlas?**

- **Stall the main thread: no.**
- **Consume capacity forever: yes** (W1, W2, W3).
- **Stall scanning: yes, but through a hung *share* rather than a file.** Scans run one at a time with no watchdog (§7), so a network root whose server hangs blocks every other root's scans.

---

## 7. Scan scheduling and concurrency

- **Triggers:**
  - at startup (`main.ts:31`);
  - every `rescanMinutes` = 60 (fixed, `main.ts:32`);
  - `/api/scan`;
  - host `resume` after sleep;
  - adding a root.
- **No filesystem watcher exists.** "Events are hints, the scan is the truth" holds trivially.
- **No drive-arrival trigger.** A re-plugged USB drive waits up to 60 minutes.
- **Scans run one at a time and are de-duplicated** (`engine.ts:153-157`). A request for the root being scanned **is dropped**, not queued, so a change made behind the walker waits for the next hour.
- **No scan timeout or cancellation.**
- **Deleting a root while it is being scanned** keeps upserting rows for the deleted root id: orphan rows that stay NEW forever and inflate counts.
- **±25% jitter:** irrelevant with one engine on one machine; it prevents fleets from synchronising. Cheap to add, but low value.
- **Heavy synchronous database work on the main thread:**
  - `removeRoot` on a huge root;
  - a mass `markMissing`;
  - any future `VACUUM INTO`.

  All of these block the event loop. The host kills the engine after **120 s** without `@@alive`, which becomes a crash loop if the same transaction is retried each start.

---

## 7b. SQLite audit (measured on the live database)

**Is there a bottleneck?** No. Every current write is batched and on one connection. **Don't tune.**

| Item | Finding | Action |
|---|---|---|
| Size | 281 MB for 7,057 files: `texts` 223 MB (79%), `fts_text` 53 MB | backups will be about the size of the database, mostly rebuildable text |
| WAL | 16.8 MB now; `journal_size_limit` = −1, so the WAL stays at its high-water mark | set `journal_size_limit` (e.g. 64 MB) |
| Checkpoints | autocheckpoint every 1000 pages; single connection, so no reader ever starves it | fine |
| `quick_check` | **3.5 s cold**, 0.8 s warm | at startup, run it off the main thread on its own read-only connection |
| `integrity_check` | 0.8 s warm; cost is dominated by the text pages | run it on each backup copy, which validates the backup and the source together |
| Foreign keys | off; none declared | relationships are enforced by code, so orphans are possible → sanity checker |
| Indexes | `files_todo` (partial, state < 50) serves the queue; FAILED/MISSING queries are full scans | add a partial index once FAILED gets a retry sweep |
| FTS | contentless with `contentless_delete=1`; built-in `rebuild` can't be used | a "rebuild search index from `texts`/`files`" maintenance routine is needed for recovery |
| mmap 256 MB | on a failing disk, an I/O error becomes an access violation instead of an error code | acceptable for local disks; note only |
| Growth | MISSING rows and their contents are never pruned; `auto_vacuum` = 0 | a retention policy is a product decision (§9) |
| Single instance | only the HTTP port prevents two engines on one home | a lock file in the home folder is cheap insurance |

---

## 8. Crash and failure matrix

### 8a. What exists today

**Recovery is:** restart, replay every row below DONE, re-plan, and let the next scan correct stale rows.

| Window | Filesystem | Database | Recovery | Retry safe | Needs the user |
|---|---|---|---|---|---|
| Mid-walk | unchanged | some batches committed; gen not bumped | next scan redoes it; nothing is marked missing | yes | no |
| After the walk, before finalize | unchanged | not finalized | redone | yes | no |
| Worker mid-hash or parse | unchanged | row NEW | re-read | yes | no |
| Flush mid-transaction | unchanged | rolled back | re-read | yes | no |
| OCR mid-call | unchanged | PENDING | OCR again | yes | no |
| Plan mid-transaction | unchanged | rolled back | re-planned, deterministic | yes | no |
| Power loss after a pin or rename returned OK | unchanged | **the pin may be gone** | none | n/a | **the decision is silently lost** |
| Power loss after a thumbnail rename | a thumbnail with possibly unflushed data | n/a | none (served forever as immutable) | n/a | no; derived |
| A poison file | unchanged | FAILED, reset hourly | none | **it loops** | no |

### 8b. Apply specification (no code yet)

Apply does not exist yet, so this is the behaviour its code must produce. The protocol:

- **J1:** write an ops row, PLANNED, durably. It records src, dst, fid, size, mtime, **sha**, and the temp path.
- **J2:** mark it STARTED, durably.
- **V:** verify the source still has the expected fid, size and mtime, and that the destination is absent (checked case-insensitively).
- **M:** the move itself:
  - **same volume:** a no-replace move (`MoveFileExW` without REPLACE);
  - **cross volume:** copy to `dst.atlas-<opid>.tmp` (EXCL) → flush → hash equals sha → no-replace rename → delete the source.
- **V2:** verify the destination: the same fid for a same-volume move, the sha for a cross-volume one.
- **D + J3:** **one durable transaction** updates the `files` row and marks the op DONE.

Merging D with J3 is deliberate: it removes the "database committed but journal not DONE" windows (rows 6-8 below collapse into one).

| # | Crash window | Filesystem | Database / journal | Recovery at startup | Retry safe | Needs the user |
|---|---|---|---|---|---|---|
| 1 | before STARTED | untouched | PLANNED or no row | nothing to reconcile; still planned | yes | no |
| 2 | after STARTED | untouched | STARTED | src matches, dst absent → back to PLANNED | yes | no |
| 3 | just before the move | untouched | STARTED | same as #2 | yes | no |
| 4a | during a same-volume move | atomic: either before or after | STARTED | src present → #2; dst has the expected fid and src is gone → go to #5 | yes | no |
| 4b | during a cross-volume copy | partial `…tmp`; src intact | STARTED | delete **only** that op's own tmp name; → #2 | yes | no |
| 4c | after the copy, before the source delete | dst complete (sha ok); src intact | STARTED | dst sha ok and src still has the expected fid/size/mtime → delete src → #5. If src changed → **stop and flag** | yes | only if src changed |
| 5 | just after the move | dst present, src gone | STARTED | verify dst (fid or sha) → commit D + J3 | yes | no |
| 6 | before the database commit | same as #5 | STARTED | same as #5 | yes | no |
| 7 | after the database commit | same | DONE (atomic with D) | nothing to do | yes (a no-op) | no |
| 8 | before DONE | n/a; merged into #6/#7 | n/a | n/a | n/a | n/a |
| 9 | after DONE | same | DONE | nothing | yes | no |
| X | anything else: both src and dst match; neither exists; dst sha differs; dst appeared from elsewhere | ambiguous | STARTED | **stop Apply, mark the op FAILED/needs-review, touch nothing** | n/a | **yes** |

**Needed before any of this is possible:**

- an `ops` migration adding `sha`, `tmp`, the src/dst volume, and the case-folded dst;
- case-insensitive collision checks in the planner;
- a no-replace move primitive;
- "a duplicate is never deleted" as a rule.

---

## 9. Prioritized changes

Ranked by what can go wrong for a user today, then mapped onto the agreed phases. Items marked **(found)** were not in the plan.

| # | Change | Phase | Why |
|---|---|---|---|
| 1 | Carry `pin`/`pinname` across fid adoption before deleting the old row **(found)** | 2 | certain intent loss on any Explorer rename or move |
| 2 | Pin, move and rename apply to every non-MISSING row (DONE → IDENT, others keep their state); stop returning success for no-ops **(found)** | 2 | intent silently dropped while the UI says done |
| 3 | FAILED terminal until size, mtime, fid or placeholder bit changes, `fail_av` < ANALYZER_VERSION, or the user retries. Split failures into **content** (TIMEOUT, CRASH: terminal) and **access** (EBUSY, EACCES, EPERM, EIO, UNSTABLE: retried on a backoff of 1 h → 6 h → 24 h) | 1 | W2, W3 |
| 4 | Progress-based deadline: stall timeout while hashing, fixed deadline only for parsing **(found)** | 1 | without it, #3 would make every large file on a slow disk *permanently* FAILED |
| 5 | Explicit retry (one file or all failed) | 1 | the user's escape hatch |
| 6 | OCR FAILED gets the same content/access split | 1 | W5; same principle, small |
| 7 | Release in-flight bookkeeping when a flush throws **(found)** | 1 | W8 |
| 8 | Durable (FULL) transactions for intent: pins, renames, roots add/patch/delete. Root PATCH in one transaction | 2 | §4 |
| 9 | `intent.json` export: atomic write (tmp + fsync + rename) after each durable intent commit, debounced. Keyed by volume serial + root-relative path + rel path + fid + sha. Import command | 2 | intent must survive losing the database |
| 10 | `quick_check` at startup in a worker thread; result surfaced on the Status page | 3 | measured 0.8–3.5 s; must not block startup |
| 11 | Backups: `VACUUM INTO` **in a worker thread** → integrity_check the copy → rename → rotate. Restore command plus a round-trip test | 3 | on the main thread it would block and could trip the 120 s watchdog |
| 12 | `journal_size_limit` | 3 | WAL stays at its high-water mark |
| 13 | SUSPECT (60) before MISSING. ENOENT in a worker → SUSPECT only if the root is reachable; otherwise leave the row alone. Clear `plan`/`fts_name` consistently | 4 | W4, ghost entries |
| 14 | Volume identity: compare the walker's serial with `roots.volume`; a mismatch means "different disk", don't reconcile. Probe other drive letters for the serial and re-point | 4 | §5 #3 |
| 15 | One-to-one SHA match carries intent from MISSING/SUSPECT rows to new rows; ambiguous cases are listed, never merged | 4 | cross-drive moves, FAT, editors that replace the file |
| 16 | Pre-dispatch stability window (skip files with mtime < 10 s ago) | 4 | cheap; complements #3 |
| 17 | Planner `evict` / `releaseName` never turn NEW into IDENT **(found)** | 4 | §2 #3 |
| 18 | Scan watchdog (walker silent for N minutes → kill → incomplete) + a queued re-scan flag + removeRoot waits for or cancels that root's scan **(found)** | 4 | a hung share blocks all scans; orphan rows |
| 19 | Late results guarded: link/fail/gone also match root+path; OCR outcomes carry the sha and are dropped if it differs **(found)** | 4 | W7 |
| 20 | Verify size/mtime around OCR, the second read and thumbnails; discard on mismatch **(found)** | 4 | W6 |
| 21 | Sanity checker, report-only (the checks in §10) | 5 | |
| 22 | Planner: case-insensitive name collisions **(found; 1 live instance)** | 6 (prerequisite) | Apply blocker |
| 23 | Apply per §8b, with a no-replace primitive (never `fs.rename`), ops migration, recovery | 6–7 | |
| 24 | Fault injection: extend `bench/crash.ts` + kill points per §8b | 8 | |
| 25 | Performance measurement | 9 | |

**Deliberately not proposed:** jitter (no fleet to desynchronise), a watcher, the USN journal, a second database, a queue broker, or tuning SQLite.

## 10. Sanity-checker inventory (for Phase 5)

Every check below is an inconsistency this audit found possible:

- `files.root` not in `roots` (orphans);
- MISSING with `plan` not NULL;
- IDENT/DONE, not a placeholder, but `content` NULL;
- `files.content` pointing at no row;
- `contents` referenced by no file;
- `texts` or `fts_text` rowids with no content;
- `fts_name` rowids with no file;
- case-insensitive duplicate `plan`;
- `ops` in STARTED;
- zero-byte or unreadable thumbnails;
- `*.tmp` litter;
- a sampled re-hash of files whose size and mtime are unchanged;
- the `quick_check` result.

---

## 11. Progress

### Phase 1: failed-file retries (done 2026-09-22, commit `81a5aaf`)

Covers changes #3–#7 in §9.

| Change | Where |
|---|---|
| Migration 4 adds four columns to `files`: `fclass` (content or access), `fsig` (what a content failure was measured against), `fnext` (when an access failure is tried again) and `frounds` (how many times it has failed so far) | `db/schema.ts` |
| Migration 4 adds three columns to `contents`: `osig`, `onext`, `orounds`. Partial index `files_failed` | `db/schema.ts` |
| Rows already failed get one fresh attempt, since they have no kind yet | migration 4 |
| Scans no longer reset FAILED. A failed file is retried only when: the size, mtime or file ID changes; `FAILURE_SIG` changes (content failures, checked at startup); `fnext` passes (access failures, checked every minute); someone asks | `scan/scanner.ts`, `pipeline/engine.ts` |
| `failureClass()`: TIMEOUT, CRASH, ERR and ERR_* are **content**; every OS error, UNSTABLE and STALL is **access**. Backoff is 1 h, then 6 h, then daily | `pipeline/states.ts` |
| Two clocks. Reading has **no deadline**: the worker reports progress, and a read that stops moving for `ATLAS_STALL_S` (60 s) is STALL. Analysis keeps the 180 s deadline | `pipeline/pool.ts`, `pipeline/worker.ts` |
| UNSTABLE counts as a try, with 1 then 2 minutes between tries, then an access failure (was: re-read every 60 s forever) | `pipeline/engine.ts` |
| OCR: a failure is **deferred** (`onext`, same backoff) when the file read from has since changed or become unreachable, checked with an asynchronous stat so the main thread never waits on a disk. Otherwise the content is marked failed until `OCR_VERSION` changes. Offline roots are not attempted | `pipeline/engine.ts`, `ocr/ocr.ts` |
| `POST /api/retry` (by ids, or everything) plus a **Try again now** button on the Status page. The card now says which failures wait for what | `server/http.ts`, `ui/dashboard.js` |
| If a database write fails, the batch is released from memory and new work pauses for 60 s | `pipeline/engine.ts` |

**Verified:**

- `npm test`: 63/63 (7 new in `test/retry.test.ts`). Among them: a real exclusively locked file (EBUSY → access, survives a rescan, is read once due and unlocked), the pool's stall and deadline clocks with a deliberately misbehaving worker, OCR deferred versus failed, and a failed transaction releasing its batch.
- Reverting the scanner change makes 2 of the new tests fail: the tests do catch the old behaviour.
- `tsc` is clean.
- `bench:crash` (7 hard kills): 11/11 checks pass.
- Migration on a snapshot of the live database (7,057 files): 84 ms, counts unchanged, `integrity_check` ok, reopening is a no-op, and the retry query uses `files_failed`.
- Speed, from alternating runs against the previous commit with OCR off: no difference within noise (2.69/2.74, 2.63/2.70, 2.77/3.92, 3.43/3.42 s).

**Decisions:**

- `maxTries` stays at 3 for both kinds: tries close together absorb a passing lock.
- A different file ID at the same path, with the same size and mtime, retries a *failed* file only. Other rows keep today's behaviour.
- OCR content failures get no automatic second attempt; the button covers the rare transient helper crash.

### Phase 2: durable user intent (done 2026-09-22, not yet committed)

Covers changes #1, #2, #8 and #9 in §9.

| Change | Where |
|---|---|
| **Explorer rename or move keeps the choice.** Before a moved file's old row (MISSING) is deleted, its `pin`/`pinname` go to the live row(s) with the same file ID, where they have none of their own, newest first. This also works when the old row only goes MISSING on a *later* scan (after an incomplete one). `ScanStats.carried` counts it | `scan/scanner.ts` |
| **Choices made mid-processing are kept.** Move, pin and rename apply to every row still on disk: DONE is re-planned, NEW/IDENT/FAILED keep their state. Move reports `skipped` for files no longer on disk. Rename of a missing file returns 409 (it used to report success and do nothing) | `server/http.ts`, `ui/explorer.js` |
| **Durable writes** (`synchronous=FULL`, about 0.9 ms against 0.04 ms): plan move, pin, rename; root add, patch and delete; the owner password (hashed outside the transaction). Root PATCH is now one transaction. `durable()` refuses to run nested: SQLite rejects the change inside a transaction, and the commit that mattered would be the outer one | `db/db.ts`, `server/http.ts`, `server/auth.ts` |
| **Intent export**: `<home>/intent/latest.json`. Roots, plus every file with a choice, keyed by root + relative path with file ID and SHA-256 for moved files. Written at startup, after each scan and after each change (debounced 2 s), atomically (temp file, fsync, rename). Before an export that drops or changes a decision replaces it, the previous one goes to `intent/history/` (newest 50). A database with no roots never overwrites it | `intent.ts`, `main.ts` |
| **Import**: `npm run intent -- import [file]`. Refuses while Atlas is running (the single-writer rule). Re-adds and lists roots, then re-attaches by path, then file ID, then SHA-256 when exactly one file has those bytes. The database's own newer choice wins (reported as a conflict); ambiguity is reported, never resolved by guessing. Idempotent. It imports from a dated copy of `latest.json`, because `latest.json` is rewritten as soon as Atlas runs again | `intent.ts`, `scripts/intent.ts` |

**Verified:**

- `npm test`: 69/69, 6 new in `test/intent.test.ts`:
  - a real Explorer-style rename and move, including hard links;
  - the carry arriving after a later scan;
  - the HTTP plan routes on NEW, DONE and MISSING rows;
  - the export's atomicity, history and empty-database rules;
  - import by path, file ID and SHA-256, with ambiguity, conflict and idempotence.
- With the old carry and the old `state = DONE` guard put back, 3 of those tests fail.
- `tsc` is clean.
- `bench:crash`: 11/11 on two runs.
- Live: the startup export was written for the dev library (4 roots), `list` works, and `import` refuses while the engine runs.

**Decisions:**

- A choice on a hard-linked file goes to every live name that has none: one file, one decision, whichever name represents it.
- Choices on a missing file stay in the export (marked `missing`): the file may come back.
- The export is not written by `import` itself, so a partial import can't replace the complete file.
