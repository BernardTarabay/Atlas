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

## Not built yet

Thumbnails, local semantic search, mirror mode (links), journaled apply, the AI
gateway, the control plane (updates, heartbeat, logs), and re-analysis on demand
(today a better extractor or dictionary only applies to files that are read again).
