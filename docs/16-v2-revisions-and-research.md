# 16. V2 Revisions and Research

This records your answers to the open questions in [14-v2-audit.md](14-v2-audit.md)
§28, what each answer changes in [15-v2-decisions.md](15-v2-decisions.md), and
the research you asked for (Q10–Q13, Q15). It ends with the Phase 0 plan.

Facts marked **measured** were measured on this machine on 2026-09-19. The
machine is an i7-1165G7 with 12 GB RAM, one 477 GB NVMe SSD (204 GB free),
Windows 11 Home.

## 1. The answers, and what each one changes

| Q | Answer | Consequence |
|---|---|---|
| Q1 | Develop and benchmark here, on representative data | This machine holds **no** representative data (§13.1), so the corpus has to be built |
| Q2 | Remote browsing and search are **core** | The engine serves remote clients through a private tunnel (§2). Adds thumbnails, range streaming, a mobile UI and availability requirements |
| Q3 | One primary user | One owner account, plus an optional, owner-controlled support account. No RBAC |
| Q4 | Benchmark in-place vs consolidation | Needs a **second volume**. There's only one internal disk (§13.2) |
| Q5 | Non-destructive mirror/preview first | Three explicit modes: preview, mirror, apply. Only the first two in v2.0 (§3) |
| Q6 | No destructive dedup during development | Dedup hides copies in the organized view; every copy stays on disk |
| Q7 | English + Arabic first-class, French third | Search normalization becomes a designed component with its own evaluation set (§5) |
| Q8 | AI stays, strictly cost-controlled | AI features are **user-initiated or per-cluster, never per-file** (§4) |
| Q9 | Best OCR by benchmark | Tesseract vs Windows OCR on real Arabic/French/English images (§6) |
| Q10 | Decide technically | **TypeScript on Node** (§7) |
| Q11–Q13 | Research required | §8–§10 |
| Q14 | Windows 11 Home is a constraint, not a blocker | One-time setup checklist (§11) |
| Q15 | Unanswered and important | Proposal in §12 |
| Q16 | Keep semantic search, local and cheap | Local multilingual embedding model; no API calls per file (§5) |

## 2. Remote browsing and search (Q2)

The files live on the office machine, so a remote user can't *open* anything
while that machine is off. A cloud copy of the index would only let them see
names they can't open, at the cost of sending names and text to the cloud.
**The engine stays the only server; the question is only how a phone reaches
it.**

| Option | How | Privacy | Client devices | Verdict |
|---|---|---|---|---|
| **R1. Tailscale** | `tailscale serve` publishes the engine's loopback port as `https://<host>.<tailnet>.ts.net` | End-to-end WireGuard; nobody else sees the traffic; no public surface | Tailscale app on each device | **Adopt for v2.0.** Already proven in V1, zero code, fits one user |
| R2. Cloudflare Tunnel + Access | an outbound `cloudflared` service and a public hostname behind a login | Cloudflare terminates TLS and can see traffic | Nothing to install | Fallback if a device can't run Tailscale |
| R3. Your own relay through the control plane | the engine holds a WebSocket to your relay | Depends on the build | Nothing to install | Most work; you'd also pay download bandwidth |
| R4. Cloud index replica | sync metadata, text and embeddings up | All of it leaves the building | Nothing | **Reject.** It shows files that can't be opened |

**Consequences built into the design:**

- **The engine still binds only to `127.0.0.1`.** Tailscale serve proxies to
  it, and the engine's Host allowlist gains the `ts.net` name. Tailscale
  forwards a user identity header, so the engine can map the tailnet user to
  the owner or support account; a password remains as a second factor.
- **Mobile-first remote UI.** Reuse V1's service worker (with its tests), touch
  gestures, mobile list and share code. PWA install works because `ts.net`
  names get real certificates.
- **Thumbnails** (images, and PDF page 1) are generated during analysis, while
  the file is already in the page cache. They're stored by content hash, so
  remote browsers can cache them forever. *est.* 10–15 KB each, so about 2 GB
  for 150k images.
- **HTTP Range streaming**, so video plays on a phone. Originals download on
  demand, limited by the office uplink.
- **Availability is now a product requirement.** The host must be always on
  (§11). The control plane's dead-man alert tells you, and can show the user a
  status page, when the host has been unreachable since a given time.
- **Tailscale's split role is now explicit.** Tailscale is the *user-access*
  transport. *Maintenance* still runs over the outbound control-plane channel,
  so a broken tunnel never prevents an update or diagnosis.
- **One operational trap:** Tailscale node keys **expire after 180 days by
  default**. Disable key expiry for the host in the admin console, or remote
  access silently dies.

## 3. Non-destructive modes (Q5, Q6) and the mirror

One planner produces one plan, which can be carried out three ways.

| Mode | What happens on disk | v2.0? |
|---|---|---|
| **Preview** (default) | Nothing. The organized, deduplicated library exists as a view in the UI (local and remote); files are served from their source paths | yes |
| **Mirror** | The organized tree is materialized under a mirror root **as links, never copies**. Duplicates are simply not linked | yes (opt-in) |
| **Apply** | Moves plus verified quarantine (docs/14 §24) | **no**, until the deletion policy is set |

**Dedup in these modes:** the organized view shows one representative per
content hash, marked "3 copies" with their locations. Every copy stays where it
is (Q6).

**The mirror link type.** Measured on this machine without admin rights:

| Link type | Result |
|---|---|
| Hard link | **5,631 per second** (300k files ≈ 1 min), zero extra space, looks exactly like a real file. **But when an edit saves by writing a temp file and renaming it over the original (as Word does), the edit lands only in the mirror** and the source keeps the old version (reproduced). Same volume only |
| Symbolic link | **EPERM**: needs Developer Mode or the `SeCreateSymbolicLinkPrivilege` privilege for the service account. Behavior under save-by-replace isn't yet tested |
| `.lnk` shortcut | Opening it opens the original, so edits go to the source. Works across volumes. It's a shortcut, though: attaching it to an email attaches the shortcut. V1 wrote these through PowerShell, which caused its MAX_PATH and quote-character failures |

**Direction:**

- **`.lnk` is the default mirror**, written by a native JS writer for the
  documented shortcut format with Unicode paths; no PowerShell.
- **Hard links are an opt-in "fast mirror"** with divergence detection: a
  mirror entry whose file ID no longer matches its source is flagged
  "edited in the mirror" and offered for reconciliation.
- Spike S3 (§13) confirms this with Word, Acrobat, Photos and Explorer.

**Q4 benchmark design:**

- *In place* means the mirror or the future apply stays on each file's own
  volume: hard links or renames, metadata-only, milliseconds per file.
- *Consolidated* means one library on one volume: links across volumes now,
  copy-verify-delete later, bounded by bytes per second.
- Both need a second volume. See §13.2.

## 4. AI in V2 (Q8)

The rule from docs/15 stands: **no file ever waits on AI, and nothing calls AI
per file by default.** Four features, all behind the single gateway:

| Feature | Trigger | What is sent | Cost shape |
|---|---|---|---|
| **Ask about this file** | the user asks a question on one file | the question plus the most relevant chunks of that file, picked locally by embedding similarity; capped at, say, 6k tokens in and 800 out | per question |
| **Ask the library** | the user presses "Ask AI" on search results (search itself is local and free) | the question plus the top-k snippets | per question |
| **Organization assistant** ("AI writes rules, rules move files") | the user presses it, or a capped schedule | **per cluster** of Unsorted files, clustered locally by embeddings: about 10 representative titles and snippets plus the existing tree. The model proposes a *rule* (folder plus conditions) that the deterministic engine applies to the whole cluster and to future files, and it's shown in preview first | **one call per cluster**, e.g. about 30 calls for 5,000 unsorted files, versus V1's per-file calls |
| **"Where should this go?"** | the user asks on a leftover file | the file's excerpt plus the tree | per question |

**Controls (from docs/14 §22, now concrete):**

- per-feature monthly budgets under one global cap;
- per-request token caps;
- atomic budget reservation in SQLite before each call;
- a cache by content hash, feature and prompt version;
- a circuit breaker, and concurrency of 1–2;
- a kill switch that works locally and remotely;
- **spend shown in the UI** ("AI this month: $0.42 of $10");
- provider-side key quota plus a billing alert;
- per-root "never send to AI" exclusions.

The provider is swappable behind an adapter; start with the key you have. A
local LLM (3–4B parameters on CPU) is too slow for interactive questions on
this hardware, but it's a later option for the batch organization assistant.

## 5. Search (Q7, Q16)

**Three signals, fused by Reciprocal Rank Fusion** (V1's `descriptionSearchService`
fusion logic is reused):

1. **FTS5 keyword search** over normalized text, with a stemmed variant.
2. **Trigram FTS over names and paths** (substrings: `INV-2023-00417`, partial words).
3. **Local vector search** over multilingual embeddings of the filename, path,
   title and text/OCR chunks. This is also what makes **cross-lingual**
   queries work, for example an English query finding an Arabic document,
   which FTS can't do.

**Normalization.** The same function runs at index time and query time.

| Language | Rules |
|---|---|
| **Arabic** | NFKC (folds the presentation forms and lam-alef ligatures PDF extraction produces); strip tashkeel (U+064B–U+0652, U+0670) and tatweel (U+0640); أ إ آ ٱ → ا; ى → ي; ة → ه; Arabic-Indic and Persian digits → 0–9, which matters for dates and invoice numbers. Stemming: a light stemmer (the "light10" prefix/suffix stripper, the standard for Arabic retrieval), not root extraction |
| **French** | fold accents; split elisions (l', d', qu', j'), including the typographic apostrophe U+2019; Snowball French stemmer |
| **English** | Snowball English stemmer |
| **Language detection** | Arabic by script; English vs French per document with a small detector |
| **Query side** | the same normalization; a deterministic parser turns dates and types in all three languages ("2023", "mars 2024", "مارس 2024", "invoice / facture / فاتورة") into filters |

**Local embedding model.** It runs on ONNX Runtime; the shortlist gets
benchmarked in spike S7:

| Model | Size | License | Note |
|---|---|---|---|
| multilingual-e5-small | 118M, 384-d | MIT | fastest; baseline |
| EmbeddingGemma-300m | 308M | Gemma Terms of Use (commercial use allowed, with use-policy obligations) | strong multilingual |
| Qwen3-Embedding-0.6B | 595M | Apache-2.0 | strongest candidate; ~5× slower than e5-small |
| BGE-M3 | 568M | MIT | also produces sparse vectors |

Vectors live in SQLite through `sqlite-vec`, with int8 or binary quantization
and exact rescoring.

**Photos with no text** ("the kid blowing out candles") need an image-text
model locally. SigLIP 2 (Apache-2.0) is the candidate. *est.* 0.1–0.3 s per
image on CPU, so 1–3 hours once for 150k photos. Arabic query quality is
unknown, so it's spike S8 and optional in v2.0.

**The decision rule for SQLite vs Postgres** (from docs/15 B), made concrete:

- Build **150–300 judged queries**, split between English and Arabic with
  French third, including cross-lingual ones.
- Run them against V1's Postgres search and against V2's SQLite search on the
  same corpus.
- If V2's recall@10 or MRR is materially worse and normalization can't close
  the gap, move the engine to local Postgres.

## 6. OCR (Q9)

**Measured here:**

- **Windows OCR** has recognizers for ar-SA, en-US and fr-FR installed. It
  ships with the OS and needs no redistribution.
- **Tesseract 5.4** is installed with **English only**. V1's `fra+ara+eng`
  default can't run here, and V1's 1,427 OCR results on this machine are all
  English, on synthetic PNGs. **V1's Arabic and French OCR has never been
  exercised here.**

**The spike S1 benchmark:**

- a quality set of real photographed documents, scans, screenshots and
  WhatsApp images in Arabic, French and English, some with ground truth;
- measure character and word error rate, seconds per page, script-detection
  accuracy, and behavior on mixed Arabic/Latin pages;
- also measure the **gate**: the share of images correctly skipped as "no
  text".

Candidates are Tesseract (with `ara` and `fra` models), Windows OCR, and a
router that uses each where it wins.

## 7. Runtime: TypeScript on Node (Q10)

Decided. The new requirements strengthened the case:

- local embeddings (ONNX Runtime has official Node bindings; transformers.js
  provides the tokenizers);
- thumbnails (`sharp`);
- PDF text and rendering (pdf.js; PDFium);
- EXIF (`exifr`);
- all of V1's extractors.

Go would have given a single static binary and simpler concurrency, but its
tokenizers, ONNX bindings and Office/PDF parsing are weaker and need cgo on
Windows.

**The risk accepted:** native modules (better-sqlite3, sharp,
onnxruntime-node, sqlite-vec) are pinned, taken as prebuilt binaries, and
tested in Windows CI. CPU work runs in `worker_threads`.

## 8. Code signing (Q11)

**Findings:**

- **An EV certificate no longer buys an immediate SmartScreen pass.** Microsoft
  removed that in 2024. Every signed publisher builds reputation through
  downloads, and Microsoft says paying extra for EV to avoid warnings "is no
  longer justified".
- **Artifact Signing** (formerly Trusted Signing) is Microsoft's recommended
  non-Store route: **$9.99/month**, no hardware token, integrates with GitHub
  Actions, identity validated by Microsoft. **Eligibility:** organizations in
  the US, Canada, EU, UK, Australia, New Zealand, Japan, South Korea,
  Singapore, Switzerland, Norway and **Israel**; **individuals only in the US
  and Canada**. It needs a paid Azure subscription.
- **Fallback outside that list:** a cloud-held OV certificate, such as Certum
  with SimplySign. Since June 2023 signing keys must live in certified
  hardware or a cloud HSM, so there are no exportable key files. Certum's
  cheap tier covers open-source projects only; proprietary software needs the
  standard certificate.
- **The Microsoft Store** avoids SmartScreen entirely, but packaging a
  background service as MSIX needs restricted capabilities. Not worth it for
  v2.0.

**Recommendation:**

- **Update integrity doesn't depend on any of this.** The updater verifies our
  own Ed25519-signed release manifests. Authenticode signing is about
  SmartScreen, Smart App Control (off here; verify at install) and antivirus
  false positives.
- **Sign every release** with Artifact Signing if you, or a company you own,
  is an organization in an eligible country. Otherwise use a cloud OV
  certificate.
- **Don't buy EV.**
- **I need from you:** will you sign as an individual or as a company, and in
  which country?

## 9. Licensing of what we'd bundle (Q12)

| Component | License | Obligation | Verdict |
|---|---|---|---|
| Node.js | MIT | notice | ok |
| better-sqlite3 / SQLite / sqlite-vec | MIT / public domain / MIT or Apache-2.0 | notice | ok |
| Tesseract + `tessdata` models | Apache-2.0 | notice | ok |
| Windows OCR | OS component | nothing shipped; language packs must be installed | ok |
| **Poppler** (V1's `pdftoppm`) | **GPL** | source offer; licensing entanglement | **avoid** |
| PDFium | BSD-style (Chromium) | notice | **use instead of Poppler** |
| sharp + prebuilt libvips | Apache-2.0 + **LGPL** libraries | keep the LGPL libraries as separate, replaceable DLLs (they ship that way); notice | ok |
| **HEIC decoding** | libheif/libde265 are LGPL; **HEVC is patent-encumbered** | sharp's prebuilt binaries don't include an HEVC decoder. Using the Windows HEIF/HEVC codecs avoids shipping a decoder | **spike S4** |
| ONNX Runtime; transformers.js | MIT; Apache-2.0 | notice | ok |
| Embedding models | e5 and BGE-M3 MIT; Qwen3-Embedding Apache-2.0; EmbeddingGemma **Gemma Terms** | Gemma passes its use-policy restrictions through to your terms | prefer MIT/Apache unless Gemma clearly wins on Arabic |
| exifr, pdf.js, exceljs, adm-zip, React | MIT / Apache-2.0 | notice | ok |
| WinSW | MIT | notice | ok |
| Kopia (§12) | Apache-2.0 | notice | ok |
| Tailscale client | BSD-3 (client) | none shipped; installed separately | ok |

**How this is enforced:** CI generates `THIRD_PARTY_NOTICES` from the npm
dependency tree plus a checked-in manifest for binaries and models, and **fails
the build on an unapproved license**.

## 10. Telemetry and privacy (Q13)

The data is classified before anything is collected:

| Class | Examples | Leaves the machine? |
|---|---|---|
| 0: operational | version, uptime, CPU and memory, free space per volume, files per state, stage timings, error counts by code, AI spend counters | **always**, over TLS |
| 1: diagnostic | stack traces, error codes, file extension, size bucket. Paths become a **per-install salted HMAC**, so repeated errors on one file correlate without revealing its name | always |
| 2: identifying | real paths and filenames | **only in a time-boxed "diagnostic mode" the owner switches on in the UI** (auto-expires, e.g. after 24 hours; every activation logged locally) |
| 3: content | text, OCR, thumbnails, AI prompts | **never** in telemetry. Content reaches an AI provider only through user-initiated AI features |

**Other rules:**

- **Support access:** the support account sees admin and diagnostics pages,
  not the library, unless the owner grants time-boxed full access. It can be
  disabled by the owner, and every support action is logged.
- **Retention and hosting:** raw logs 30 days, aggregated metrics 90 days.
  Choose a hosting region deliberately (EU or self-hosted), with data
  processing agreements from any vendor.
- **A one-page privacy notice for the client** stating exactly the above.
- **Jurisdiction:** the legal frame depends on where the client and their data
  subjects are, for example Israel's Privacy Protection Law (strengthened by
  Amendment 13 in 2025), Lebanon's Law 81/2018, or the GDPR where EU residents
  are involved. The minimization above is designed to meet the strictest of
  these, but **confirm the jurisdiction with the client.**

## 11. Windows 11 Home one-time setup (Q14)

Done once on site, then verified remotely by the heartbeat:

1. BIOS/UEFI: **restore power on AC loss**.
2. Power plan: **never sleep on AC** (V1's `configure-server-power.ps1`,
   reused).
3. UPS (recommended); wired Ethernet.
4. Windows Update: set active hours so restarts happen at night. The service
   starts at boot, so no sign-in is needed.
5. Tailscale runs as a service; **disable key expiry** for the host.
6. Exclude the Atlas data directory (DB, thumbnails) from Defender real-time
   scanning, **for performance only**. The document roots are never excluded.
7. Keep the Atlas data directory **outside** OneDrive.
8. Check the Smart App Control state and record it in the install report.

## 12. Backups (Q15): proposal

**The principle:** Atlas is not a backup. Quarantine, preview mode and mirror
mode protect against *Atlas's* mistakes. They do nothing against a dead disk,
ransomware or theft. **A document archive on one desktop disk is currently one
failure from total loss, whether or not V2 exists.**

**Proposal: 3-2-1 with an immutable offsite copy, run by an independent tool,
with Atlas as the watchdog and the gate.**

- **Engine: Kopia** (open source, Apache-2.0, Windows GUI and CLI). It gives
  encryption, block-level deduplication, compression, scheduled snapshots, and
  Windows volume shadow copy for open files.
- **Repository 1: an external USB drive** at the office, for fast restores.
- **Repository 2: an S3-compatible bucket with object lock** (for example
  Backblaze B2 or Wasabi) for off-site, ransomware-resistant copies. **The
  client owns the bucket.** *est.* a few dollars a month for 500 GB at
  B2-class pricing; confirm current prices.
- **Schedule and retention:** daily, plus on demand. Keep, for example, 14
  daily, 8 weekly and 12 monthly snapshots.
- **Atlas's role:**
  - read `kopia snapshot list --json`, and show "last successful backup" in
    the UI and the heartbeat, alerting you when it's stale;
  - **refuse any destructive apply unless a fresh snapshot covers the affected
    roots.** Atlas can trigger that snapshot itself and wait for it;
  - run a monthly automated restore test of a random sample (`kopia snapshot
    verify`), with the result in the heartbeat.
- **Alternatives considered:**
  - Backblaze Personal Backup: simplest, a flat fee, but no programmatic
    status for Atlas to gate on;
  - restic: CLI only;
  - Windows File History: no off-site copy;
  - OneDrive: sync is not backup, because deletions and encryption replicate.

**Decisions needed:** the budget, the off-site provider, the external drive,
and who holds the backup credentials (recommended: the client, with Atlas
holding only a repository password stored with Windows DPAPI).

## 13. Phase 0 plan

### 13.1 Why the corpus has to be built

**Measured:**

- The V1 dev corpus is 7,262 synthetic English files averaging 15 KB.
- Your own folders (OneDrive, Documents, Downloads, Videos) hold **35,476
  files, 1.9 GB, mostly Python environment files and one DB dump**, with no
  Arabic-named files and almost no photos or scans.
- Nothing on this machine represents the target workload.

### 13.2 Hardware

- One NVMe SSD with 204 GB free, so the on-disk corpus is capped at about
  100 GB, with headroom.
- **HDD numbers and every cross-volume test (Q4) need an external USB hard
  drive, 2 TB or more**, separate from any backup drive.

### 13.3 The corpus

| Set | Purpose | Source |
|---|---|---|
| Throughput sets (tiny files, huge files, duplicate-heavy, mixed) | files/s, GB/min, read amplification | **generated locally**; no downloads |
| Photos and videos with real EXIF, including HEIC and WhatsApp | EXIF naming, thumbnails, OCR gate, image search | **best: a copy of your own phone camera roll or WhatsApp media** (stays local); otherwise public-domain photos |
| Arabic/French/English scans and photographed documents | OCR accuracy, Arabic PDF extraction, naming | public-domain scans (Internet Archive, Gallica, Wikisource) plus **real samples you can provide** |
| Synthetic rendered text images with ground truth | exact OCR error rates in all three scripts | generated locally with open fonts |
| Search evaluation set | 150–300 judged queries (English/Arabic, French third, cross-lingual) | written against the corpus |

### 13.4 Spikes

Each spike is time-boxed and answers one question before Phase 1 code
depends on it.

| # | Question | Success criterion | Box |
|---|---|---|---|
| S1 | Tesseract vs Windows OCR on Arabic, French and English | a CER/WER and seconds-per-page table; a routing decision | 2 d |
| S2 | Can SQLite FTS5 + normalization match V1's Postgres search? | recall@10 and MRR on the query set, within an agreed margin | 3 d |
| S3 | Mirror link type | native `.lnk` writer at ≥5k/s; Word/Acrobat/Photos/Explorer behavior table; hard-link divergence detection works | 1 d |
| S4 | HEIC thumbnails and EXIF | a working decode path with an acceptable license | 1 d |
| S5 | Arabic text order in PDFs (logical vs visual, presentation forms) | correct extraction on real Arabic PDFs, or a known fix | 1 d |
| S6 | Remote access through Tailscale serve | PWA installs on a phone; video seeks; identity header maps to an account | 0.5 d |
| S7 | Local text embeddings | quality on the query set and ms per chunk on this CPU for the 4 shortlisted models | 2 d |
| S8 | Local image-text search (optional) | useful recall on photo queries in English and Arabic | 1–2 d |
| S9 | Baseline throughput: V1 (AI off) vs a prototype single-pass reader | files/s, MB/s, read amplification on the throughput sets | 2 d |

### 13.5 Permissions I need before starting

| Item | Detail |
|---|---|
| Commit the V1 working tree | 134 uncommitted changes, including migrations 043–046 already applied to the DB. Commit to a `v1-final` branch and tag |
| Downloads | Tesseract `ara` + `fra` models (github.com/tesseract-ocr, ~10–30 MB); up to 4 embedding models in ONNX form (Hugging Face, ~2 GB total); npm packages for the spikes (better-sqlite3, sharp, onnxruntime-node, transformers.js, sqlite-vec, exifr); a public-domain document and photo sample (several GB) |
| Disk | up to ~100 GB of generated and downloaded corpus under a new `bench/` directory, excluded from git |
| Real samples | any phone photos or WhatsApp media and real Arabic/French documents you're willing to use locally |
| Hardware | an external USB hard drive, 2 TB or more |
| Signing | individual or company, and the country (§8) |
| Backups | the §12 direction, budget and provider |
