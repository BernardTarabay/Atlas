# Atlas V2

A local engine that scans your folders, reads every file once, deduplicates by
SHA-256, extracts text and metadata, reads scans and photos with local OCR, and
organizes a virtual library you can browse and search from this machine or your
phone. Nothing is moved, renamed or deleted: V2 runs in **preview mode**. Design
record: [docs/14](../docs/14-v2-audit.md), [15](../docs/15-v2-decisions.md),
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
| `MISSING` (70) | not found by the last complete scan of its folder |
| `FAILED` (90) | unreadable after 3 attempts; retried on the next scan |

There is no job table: in-flight work lives in memory, and after a crash every
row below `DONE` is simply picked up again. Everything is idempotent.

## Tests and benchmarks

```bash
npm test                          # unit + integration (pipeline, OCR, HTTP security)
npm run typecheck
npm run bench:gen -- --files 5000 # synthetic corpus in ~/AtlasBench (outside the repo)
npm run bench                     # scan → hash → analyze → plan, with a main-thread profile
npm run bench:crash               # 7 hard kills, then proves the result equals a clean run
npm run bench:scan -- "C:\Some\Big\Folder"
npm run bench:ocr:corpus          # render the ground-truth OCR set with Edge (~7 min)
npm run bench:ocr                 # OCR engines vs ground truth, in 3 languages
```

Measured on this development machine (i7-1165G7, 4 cores/8 threads, NVMe, 12 GB):

| | result |
|---|---|
| scan, first pass (walker + SQLite) | ~51,000 files/s |
| rescan, nothing changed | ~70,000 files/s, zero database writes |
| full pipeline, synthetic mixed corpus | ~2,100–2,250 files/s, ~310 MB/s, 6 workers |
| engine startup | ~56 ms |
| crash recovery | 11/11 invariants after 7 hard kills; resumes < 1 s after restart |
| search (EN/AR/FR) | 9–18 ms |
| OCR (Windows OCR, 4 in parallel) | ~20 images/s; 97–99% word recall on Latin, 66–97% on Arabic ([docs/17](../docs/17-ocr.md)) |
| PDF text layers | Arabic recall 94%, French/English 100% |

The synthetic corpus measures the machinery. Representative numbers (real PDFs,
photos, scans, OCR) come from the real corpus in the next milestone.

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

Icon views show real thumbnails by loading the original image, because there is
no thumbnail service yet - fine on this machine, heavy over a tunnel. That is the
next milestone.

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

Thumbnails, local semantic search, mirror mode (links), journaled apply, the AI
gateway, the control plane (updates, heartbeat, logs), and re-analysis on demand
(today a better extractor or dictionary only applies to files that are read again).
