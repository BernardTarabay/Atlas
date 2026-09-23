# Atlas V2

A local engine that scans your folders, reads every file once, deduplicates by
SHA-256, extracts text and metadata, reads scans and photos with local OCR, and
organizes a virtual library you can browse and search from this machine or your
phone. The engine never moves, renames or deletes a file: V2 runs in **preview
mode**. Moving files into the library is a separate command you run by hand
([Apply](#moving-files-into-the-library-apply)); so far it has only been run on
test folders. Design record: [docs/14](../docs/14-v2-audit.md), [15](../docs/15-v2-decisions.md),
[16](../docs/16-v2-revisions-and-research.md), [17](../docs/17-ocr.md).

```
AtlasService.exe (Windows service: boot start, restart, keep-awake, job object)
  └─ node src/main.ts ── one process
       scanner ── bin/atlas-walk.exe (bulk directory reads: size, times, attributes, file IDs)
       engine  ── per-file state in SQLite; bounded worker threads read+hash+analyze each file once
       ocr     ── bin/atlas-winrt.exe (Windows OCR + PDF rendering), per unique content
       planner ── deterministic rules → one library path per unique content
       http    ── 127.0.0.1:7717: UI + API (remote access via `tailscale serve`)
       ui      ── a file manager over the planned library (ui/explorer.js)
```

## Run it (development)

```bash
npm install
npm run build:native      # compiles bin/atlas-walk.exe and bin/AtlasService.exe with Windows' own csc.exe
npm start                 # http://127.0.0.1:7717; data in %LOCALAPPDATA%\AtlasDev
```

First run: the setup code is written to `<data dir>\setup-code.txt` (and logged).
Enter it in the UI with the owner password you want. Then add folders under
**Folders**.

## Install as a Windows service

From an **elevated** PowerShell:

```powershell
.\scripts\install-service.ps1                  # install, or update an existing install
.\scripts\install-service.ps1 -Action Status
.\scripts\install-service.ps1 -Action Uninstall
```

The app is copied to `C:\Program Files\Atlas` (never run from a OneDrive
folder), data lives in `%ProgramData%\Atlas`. The service starts at boot with
nobody signed in, restarts on failure, and holds a Windows power request only
while it is busy. For an always-on host also run the repo's
`scripts\configure-server-power.ps1 -Apply` (no sleep on AC).

## Remote access

```powershell
tailscale serve --bg 7717
```

The engine stays bound to loopback; Tailscale publishes it on your tailnet with a
real certificate. Disable key expiry for the host in the Tailscale admin console.
Setup and host-folder browsing are refused through the tunnel.

## How a file is processed

| state | meaning |
|---|---|
| `NEW` (0) | discovered or changed: read once → SHA-256 → analyze if the content is new |
| `IDENT` (20) | linked to its content (cloud placeholders skip reading entirely) |
| `DONE` (50) | placed in the library, or recognized as a copy/alias of a placed file |
| `MISSING` (70) | not found by two complete scans of its folder, at least 10 minutes apart (see below) |
| `FAILED` (90) | unreadable after 3 attempts; kept, **not** retried by scans (below) |

There is no job table: in-flight work lives in memory, and after a crash every
row below `DONE` is simply picked up again. Everything is idempotent.

**When a file counts as gone.** One scan that doesn't see a file isn't proof: a drive may have blinked, a share may have answered empty once, or an editor may have been saving by delete-and-rename.

- **The first time**, the file becomes SUSPECT (`files.missed`). It keeps its state and its place in the library.
- **It becomes MISSING** only when a *later* complete scan, at least 10 minutes on, still doesn't see it.
- **Nothing is concluded** from an incomplete listing, from a folder that couldn't be read, or from a root that isn't reachable.
- **A worker that finds a file gone** makes it SUSPECT, and the next scan decides.
- **A listing that produces nothing for `ATLAS_SCAN_STALL_S` (120 s)**, such as a hung share, is abandoned as incomplete, so it can't hold up the other folders.

**Drives are disks, not letters.** Each folder records the serial number of the disk it's on.

- **A different disk at the same path** isn't scanned as that folder. The Folders page offers **Use this disk** for when it really is the same data, for example on a new disk.
- **A drive that comes back as another letter** (E: yesterday, F: today) is found within minutes and followed: same files, same choices.
- **An offline folder** is checked every minute, so a drive plugged back in is scanned straight away, not at the next hourly scan.

**Moves Atlas can't follow by file ID** are followed by content, but only when that's certain. This covers another drive, FAT/exFAT, or a network share. The choice goes to the one file with the same bytes that appeared when the original vanished. A copy that was always there is never it, and two candidates are never guessed between: the Status page counts those for you.

**Files still being written** (modified in the last `ATLAS_SETTLE_S`, 10 s) are left to settle without being read, and looked at again after 15 s, 30 s, 1 min, and so on.

**When a failed file is tried again.** A failure has a kind (`files.fclass`):

- **content**: the bytes defeat the reader. A parser ran past `ATLAS_JOB_TIMEOUT_S` (180 s), or a worker crashed. It stays failed until:
  - the file changes (size, modified time or file ID);
  - the analyzer or its limits change (`fsig`, checked at startup);
  - someone presses **Try again now** on the Status page (`POST /api/retry`).
- **access**: the file couldn't be reached. It was locked, access was denied, it was still being written, or a read stopped making progress for `ATLAS_STALL_S` (60 s). It's tried again at `fnext`: after 1 h, then 6 h, then daily. A change to the file, or the button, also brings it back sooner.

Reading has no deadline, only a stall clock: a 40 GB video on a USB 2 disk reads for as long as it takes. OCR follows the same split, per content. If the file it read from has since changed or become unreachable, the reading is deferred (`onext`). Otherwise the content is marked as failed OCR until `OCR_VERSION` changes or someone retries.

## What you decided, and getting it back

Almost everything in the database can be rebuilt by rescanning. It's worked out from the files: hashes, text, OCR, the plan, the search index. A few things can't, because a person decided them:

- which folders are roots, and their roles;
- a folder or name chosen by hand in the library (`files.pin`, `files.pinname`).

Those are treated differently:

- **Saved safely.** They're committed with `synchronous=FULL` (`Db.durable`), so a power cut straight after you move a file in the library doesn't undo it. A safe save costs about 1 ms; everything else keeps the 0.04 ms fast save.
- **Attached to the file, not its path.** Rename or move a file in Explorer and its chosen folder and name follow it. The NTFS file ID identifies it, so this isn't a guess.
- **Exported beside the database.** `<home>/intent/latest.json` is rewritten a couple of seconds after each change and after each scan, atomically (temp file, fsync, rename).
  - Before it's replaced by a version that drops or changes a decision, the old one is kept in `intent/history/` (newest 50).
  - A database with no roots never overwrites it.

```powershell
npm run intent -- list              # the export and its history, with counts
npm run intent -- export            # write it now
npm run intent -- import [file]     # after losing the database; Atlas must be stopped
```

`import` does three things:

1. Re-adds the roots.
2. Lists them (no file is read).
3. Puts each choice back on its file:
   - by path;
   - then by file ID (the file was renamed or moved since);
   - then by SHA-256, only when exactly one file has those bytes.

The database's own newer choices win. Anything ambiguous is listed, never guessed. Choices that can only be found by content need the files read first: start Atlas, let it finish, stop it, and run the same import again. It's safe to repeat.

## The database itself: checks, backups, restore

- **Checked at startup.** `quick_check` runs on a background thread with its own read-only connection: 0.8 s warm and 3.5 s cold on a 281 MB database, so startup isn't held up.
  - If it fails, nothing is repaired automatically. Atlas stops changing the database: the engine stops, and moving, renaming and folder changes are refused with 503. Reading still works.
  - The Status page shows a banner explaining how to recover.
- **Backed up daily.** `VACUUM INTO` a new file, from a read-only connection on a background thread. It's a consistent snapshot even while Atlas keeps writing, and a single compact file.
  - Every copy passes the full `integrity_check` before it's kept.
  - A database that fails its own check is never copied, so it can't push a good backup out of the rotation.
  - The newest 7 are kept in `<home>/backups`. Each is about the size of the database; most of that is extracted text and OCR, which can be rebuilt but takes hours.
  - Settings: `ATLAS_BACKUP_DIR` (another disk, if there is one), `ATLAS_BACKUP_KEEP` and `ATLAS_BACKUP_HOURS`.
- **The Status page header** shows "Database checked · backed up 3 h ago (280 MB, 7 kept)".

```powershell
npm run db -- check            # full integrity check; Atlas may be running
npm run db -- backup           # a verified backup now; Atlas may be running
npm run db -- list
npm run db -- restore [file]   # Atlas must be stopped; newest backup by default
```

`restore` does four things:

1. Verifies the backup, and refuses one that's damaged or made by a newer Atlas.
2. Moves the current database into `<home>/replaced-<time>/`. It never deletes it.
3. Copies the backup into place and opens it (a backup from an older Atlas is migrated forward).
4. If your decisions were exported after the backup was made, prints the one command that brings them back **before** Atlas starts: `npm run intent -- import --exact "<copy>"`. `--exact` makes the database's folder and name choices exactly the export's, including ones undone since the backup.

Measured on the development database (280 MB):

| Operation | Time |
|---|---|
| Full check | 0.75 s |
| Verified backup | 2.3 s |
| Restore | 1.8 s |

**The sanity check** (`npm run db -- sanity`, or **health check** in the Status page header) asks the database whether it agrees with itself, with the disk, and with the rules of this code. It runs daily after the backup, on a background thread with a read-only connection, so it can change nothing. It checks:

- **Rows that point at nothing:** files of an unregistered folder, links to missing content, search entries for nothing.
- **States that can't happen:** a missing file still in the library, a file filed without being read, two files in one place, a group of identical files with no copy (or two) in the library.
- **Names that would collide on disk:** names that differ only in capitals.
- **Folders:** offline, a different disk found, or not scanned for long; files suspected gone for over a day.
- **Your decisions:** whether the export is up to date, and choices waiting on missing files.
- **Backups:** whether a recent verified one exists.
- **Leftovers:** temporary files, and thumbnails that aren't pictures.
- **A sample of files read again:** up to 100 files and 512 MB are re-hashed, which catches bytes that changed while size and date didn't. That's the one change Atlas's scans can't see.

It **repairs nothing**: each finding says what it means and what a person can do. The newest 30 reports are kept in `<home>/sanity/`. On the development database it takes 2.5 s warm, 33 s from cold caches.

## Moving files into the library (Apply)

Apply makes the disk look like the plan: each file the library shows goes to that place, inside a folder you registered with the role **library**. It's the only code in Atlas that moves a person's files, so it runs **by hand, with Atlas stopped**, and nothing moves without `--yes`.

```powershell
npm run apply -- preview --to <root id>        # what would move; writes nothing
npm run apply -- plan --to <root id> [--limit N]   # writes a batch to the journal; no file moves
npm run apply -- run <batch> --yes             # moves that batch's files
npm run apply -- undo <batch> --yes            # puts them back (as a new batch)
npm run apply -- list | show <batch> | cancel <batch>
npm run apply -- recover [--yes]               # settle what a crash interrupted
npm run apply -- settle <op> --yes             # "I have looked": stop waiting for me
```

**Planning** writes one journal row per file (the `ops` table) with everything the move must prove: the file's ID, size, date and SHA-256, and its creation time. It leaves out, and says why:

- cloud-only files;
- files the last scan didn't see;
- files whose folder is offline;
- a place in the library that another file already holds;
- two files planned to one place.

Only one copy of a set of identical files is moved. The others stay where they are.

**Running** takes one file at a time:

1. The row is marked *started*, durably, before the file is touched.
2. The file must still be exactly the one on record, and the destination must be free: on disk, and in the index.
3. Moving it:
   - **Same disk:** a rename that can never replace anything (`MoveFileExW` without `REPLACE_EXISTING`). The destination must then be that same file, by its ID.
   - **Another disk:** a copy to a temporary name beside the destination, flushed and hashed; it must match the recorded SHA-256. It gets the original's creation time and is renamed into place, again never replacing. The original is deleted only if it's still exactly the file that was copied.
4. The index row follows the file, and the op is marked *done*: one durable transaction.

If anything fails before the disk changed, the op is *failed* and there's nothing to undo. If anything unexpected happens after, it's *for review*: `show` says which file and why, and nothing is guessed. A file waiting for another file of the same batch to move out of its way runs in a later pass. Two files that would have to swap places fail, and neither moves.

**Never:**

- replace a file;
- delete an original that hasn't been copied and verified;
- move a duplicate.

**One writer.** The engine, Apply, `intent import` and `db restore` all take `<home>/atlas.lock`, a file held open without sharing. So Apply refuses to start while Atlas runs, and Atlas refuses to start while Apply runs. Windows releases the lock however the process ends, so a crash never leaves a stale one.

**After a crash.** A file operation that was in flight stays *started*, and nothing else moves until it's settled. Because Apply wrote down what had to be true before it touched anything, the disk itself answers what happened:

| What the disk says | What happens |
|---|---|
| The file is still at its source, unchanged | it simply runs again |
| The file is at its destination (same file ID), or a copy is there and its SHA-256 matches | the operation is completed: the index follows, and a copy's original is deleted last, exactly as the move would have |
| The file is still at its source but changed | abandoned; nothing moved, so plan again |
| Anything else - a stranger's file at the destination, the file at neither end, an original edited since it was copied | **for review**: nothing is touched, and you decide |

`npm run apply -- recover` prints that verdict for every interrupted operation and changes nothing until you add `--yes`. When you've looked at one marked *for review*, `settle <op> --yes` stops it holding up the rest; the next scan puts the index right.

Atlas itself says the same at startup, from the same reading of the disk, but never acts on it: the engine doesn't move, delete or finish anything - Apply does, when you run it.

## Tests and benchmarks

```bash
npm test                          # unit + integration (pipeline, OCR, HTTP security)
npm run typecheck
npm run bench:gen -- --files 5000 # synthetic corpus in ~/AtlasBench (outside the repo)
npm run bench                     # scan → hash → analyze → plan, with a main-thread profile
npm run bench:crash               # 7 hard kills, then proves the result equals a clean run
npm run bench:apply-crash         # Apply killed at every point of a move, then recovered
npm run bench:apply -- --files N  # how fast Apply moves files, on folders it makes itself
npm run bench:soak -- --minutes N # the engine against a folder that will not hold still
npm run bench:scan -- "C:\Some\Big\Folder"
npm run bench:ocr:corpus          # render the ground-truth OCR set with Edge (~7 min)
npm run bench:ocr                 # OCR engines vs ground truth, in 3 languages
npm run bench:rvl                 # document typing on 3,200 real labelled scans
npm run bench:robust -- <dir>     # what breaks on real files, and how fast the rest goes
npm run intent -- list            # your decisions, exported (see above)
npm run db -- check               # the database's integrity, backups, restore (see above)
npm run db -- sanity              # the report-only sanity check (see above)
npm run apply -- list             # Apply's batches and their outcome (see above)
```

Measured on this development machine (i7-1165G7, 4 cores/8 threads, NVMe, 12 GB):

Two synthetic corpora: **5,103 files (0.7 GB)** and **204,004 files (6.0 GB, 163,868
unique contents, 40,136 exact duplicates)**.

| | 5,103 files | 204,004 files |
|---|---|---|
| scan, first pass (walker + SQLite) | ~51,000 files/s | ~22,500 files/s (9.1 s) |
| rescan, nothing changed | ~70,000 files/s, zero database writes | 39,000–48,000 files/s |
| read, hash, analyze, plan (no OCR) | ~1,700 files/s, ~250 MB/s | 646 s end to end: every byte read and hashed by 245 s, the rest is placing files |
| the library itself | 21 MB database | 653 MB database, 983 MB peak memory while building it |
| engine startup | ~56 ms | 169 ms |
| search (EN/AR/FR) | 9–18 ms | 14–61 ms (median) |
| health check | 2.5 s | 3.7 s |
| verified backup | 2.3 s (280 MB) | 8.5 s (567 MB) |

| | result |
|---|---|
| Apply, 20,000 files | plan 0.02 ms/file; move on one disk 3.2 ms/file; undo 3.1 ms/file; copy across disks 7.0 ms/file |
| crash recovery | 11/11 invariants after 7 hard kills; resumes < 1 s after restart |
| Apply killed mid-move | 7/7 kill points recover and end where an uninterrupted run ends |
| OCR (Windows OCR, 4 in parallel) | ~20 images/s; 97–99% word recall on Latin, 66–97% on Arabic ([docs/17](../docs/17-ocr.md)) |
| PDF text layers | Arabic recall 94%, French/English 100% |
| document typing, real scans (RVL-CDIP) | 39% of invoices/letters/resumes/reports found; 3% false typing on the rest ([docs/17](../docs/17-ocr.md)) |

The synthetic corpora measure the machinery. Representative numbers (real PDFs,
photos, scans, OCR) come from the real corpus in the next milestone.

Reading a library is a one-time cost, and the rate is an average, not a promise: the
same run moves at 1,500 files/s through a stretch of duplicates and 100/s through
unique documents that each have to be analysed, indexed and given a place. Per file,
the cost also grows with how much is already filed. What made it *fall off a cliff*
were three bugs at scale, all fixed in Phase 9 of
[docs/18](../docs/18-v2-reliability-audit.md): numbering files that want the same name
asked the database once per attempt, every pass of the loop read the whole file table
because a partial index could not be used, and giving up a name re-planned an entire
crowd instead of the files numbered after it.

## Browsing the library

The library is a file manager, deliberately shaped like Windows File Explorer:
navigation tree, command bar, address bar, status bar, and eight view modes
(extra large / large / medium / small icons, list, details, tiles, content).
Sorting, grouping, filtering, multi-selection (click, Ctrl, Shift, rubber band,
type-ahead), sortable and choosable detail columns, a preview pane, properties,
and light/dark that follows Windows. `ui/explorer.js`, no framework, no build.

Double-click opens a folder or a file; **Reset to default** at the bottom of the
View, Sort and Group menus puts every display setting back at once.

Sorting and grouping only offer what Atlas actually extracts - name, dates, type,
size, category, title, language. Explorer's Authors and Tags are absent because
nothing fills them yet.

The commands that would change your disk - paste, rename, delete, new folder -
are present and correctly enabled, and refuse with an explanation. The library is
a **plan**: `files.plan` is where each file would go. Carrying it out needs the
journalled apply step, which is not built. Cut and Copy do work: they fill an
in-app clipboard, so you can see what a move would consist of.

**Thumbnails** come from Windows itself - the same shell thumbnails Explorer
shows, so photos, video frames and (with a handler installed) Office documents
all work - with PDFs drawn from their first page and other images decoded
directly. They are cached by content hash in `<home>/thumbs`, so every copy of a
file shares one and moving or renaming never invalidates it, at three sizes
(128/256/512) chosen by view and screen density. JPEG unless the picture really
has transparency. A screenful of photos is ~300 KB instead of ~13 MB of
originals; files Windows cannot draw show their type badge. URLs carry a
generator version, because they are cached as immutable.

**Search results are a place in the explorer**, not a separate page: the same
rows, selection, views and context menu, plus a Folder column and the snippet
that matched. Two questions are answered separately - the engine decides which
files are *relevant*, and the rows that literally contain what you typed are
marked and walkable with next/previous (Enter and Shift+Enter in the search box,
F3 in the list). The walker counts snippet matches too, because an Arabic search
finds files whose names are entirely Latin.

**Search is scoped to where you are.** From inside a folder it searches that
folder and everything under it; from the top of the library it searches
everything, and results offer "Search everywhere" to widen. Results arrive
ranked by best match and ungrouped, whatever the folder behind them was sorted
or grouped by - and sorting or grouping the results never disturbs the folder's
own arrangement.

**Photos** is a page of its own, for the reason V1 gave: a photograph is
identified by looking at it, and a filename says nothing about a picture of a
receipt called IMG_4821.jpg. Big tiles, three or four to a row, the whole
library at once, tabs for what OCR made of them, and a viewer - arrows to walk,
+/- to zoom, Escape to leave - with the OCR reading beside the picture.

**Dragging files onto a folder moves them** - in the library, which means it sets
`files.pin` and re-plans them. Naming and collision handling stay with the rules,
so a moved file is numbered against its new neighbours; the rule becomes
`manual`. Nothing on disk moves. Ctrl+Z, or the Undo in the status bar, puts the
plan back, and "Let the rules decide where this goes" hands a file back for good.

## OCR

Scans, photographs of documents and image-only PDFs are read locally by Windows
OCR through `bin/atlas-winrt.exe`; PDF pages are rendered by Windows too, so there
is nothing to install and nothing GPL to ship. The engine was chosen by measurement
against a rendered ground-truth set in English, Arabic and French — see
[docs/17-ocr.md](../docs/17-ocr.md) for the numbers and the decisions that came out
of them.

OCR runs per unique content on its own bounded pool, so it never starves reading
and hashing, and its state lives on the content row: a crash leaves it PENDING and
it runs again. `ATLAS_OCR_WORKERS=0` turns it off; without the helper, contents
simply stay "waiting for OCR".

## The status page

Cards, and they are yours: drag one by holding the left button and the others
slide out of its way; change what a breakdown splits by from its menu; make it
wide or narrow; remove it; add one from the presets. The headline cards are
files in the library, waiting, photos, duplicates resolved (with what would be
freed - and a line saying nothing was deleted), and files that could not be
read. One "By type" card turns through PDF, Word, Excel, PowerPoint, images and
the rest instead of taking a card each.

The **live pipeline** card shows every reader and OCR slot and the file each is
on, how long it has been on it, files/s and MB/s over the last minute, an ETA,
and what finished in the last minute - which lingers so a fast file does not
flash past unseen.

Cards come in six sizes, from the menu or by pulling the corner grip, and a
bigger card shows more: Files lists what the library is made of, Photos shows
the newest pictures, Duplicates lists the groups that waste the most space,
Could-not-read lists the files and why, By type charts that type by year, and
breakdowns show more rows. Dragging lifts a card like an icon on a phone: it
turns to clear glass you can see the other cards through, the rest shiver, and
everything springs into place.

A card is data - what to count, split how, narrowed how - so the assistant can
design one from a sentence ("Arabic invoices by year"). That costs **one**
request, once; the card then keeps itself current from the local database for
free. The free Gemini tier is for asking, not for keeping numbers up to date.

Every figure is a `GROUP BY`, true at any size. The page polls fast only while
something is happening and stops when the tab is hidden.

**Motion** is one policy in `ui/motion.css`: what appears eases in, what you
point at responds at once, only `transform` and `opacity` ever animate, sections
cross-fade and folder-to-folder browsing stays instant. Long lists never
animate row by row. All of it turns off under "reduce motion".

## The assistant

A panel in the bottom-right corner that does what the toolbar does, by
conversation: go somewhere, find things by property or by words, arrange what is
shown, select, move, rename. `GEMINI_API_KEY` in `v2/.env` (gitignored) turns it
on; without one the panel never appears.

It is not a tool-execution loop. The model returns a reply plus a list of
PROPOSED actions, and the browser decides what to do with them - the same shape
V1 used, for the same reason. Actions that only change what is on screen run
immediately; **move** and **rename** are drawn as a card and wait for a click,
then are undoable like any other plan change. Deleting and copying are not in
its vocabulary at all, so it cannot propose what it cannot name.

**One call per message you type.** Never per file, never in the pipeline, never
on a timer - that is what made V1 expensive. What leaves the machine is your
message, where you are, and a sample of up to 60 rows (names and metadata, never
file contents).

## Not built yet

Thumbnails, local semantic search, mirror mode (links), fault injection against Apply
(Phase 8), the AI gateway, the control plane (updates, heartbeat, logs), and
re-analysis on demand (today a better extractor or dictionary only applies to files
that are read again).
