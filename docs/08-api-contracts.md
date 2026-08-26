# Phase 9 — API Contracts

Finalized only now, after the domain model (Phase 1-5), pipeline (Phase 6-7), and
auth/RBAC (Phase 8) already exist -- per the spec's explicit ordering. Endpoints are
organized around the resources those phases already established; nothing here invents
a new concept.

## 9.1 Conventions

- All routes are under `/api`. All protected routes require `Authorization: Bearer
  <accessToken>` and are additionally gated by a specific RBAC permission key (see
  `backend/seeds/001_roles_permissions.sql` for the permission catalog).
- Long-running or repository-wide operations are represented as **jobs**
  (`processing_jobs`), never as a synchronous request — see `POST .../scan` and
  `POST /rename-proposals/bulk-apply` below. The response is the job row (status
  `queued`), not the eventual result.
- Mutations that change filesystem or classification state go through the same
  services the background workers use (`renameProposalService`, `duplicateGroupService`
  etc.) — there is exactly one code path for "approve a rename," whether it is
  triggered from the API or, later, from the UI calling the API.
- Errors are `{ "error": "message" }` with the HTTP status carrying the meaning
  (400 validation, 401 unauthenticated, 403 unauthorized, 404 not found, 409 conflict).

## 9.2 Auth (`/api/auth`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/register` | none (public) | Always assigns the `User` role; rate-limited |
| POST | `/login` | none (public) | Returns `{ user, accessToken, refreshToken }`; rate-limited |
| POST | `/refresh` | none (holds a valid refresh token) | Rotates the refresh token |
| POST | `/logout` | none | Revokes the given refresh token |
| GET | `/me` | authenticated | Current user + roles + permissions |

## 9.3 Users & Roles (`/api/users`, `/api/roles`)

| Method | Path | Permission |
|---|---|---|
| GET | `/users` | `user.manage` |
| GET | `/users/:id` | `user.manage` |
| POST | `/users/:id/roles` | `role.manage` |
| GET | `/roles` | `user.manage` |

## 9.4 Storage Locations (`/api/storage-locations`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | authenticated | |
| POST | `/` | `user.manage` | Registers a new location; agent locations validated to have an agent (Phase 12) |
| GET | `/:id` | authenticated | |
| POST | `/:id/scan` | `scan.run` | Enqueues a `scan` job; returns the `processing_jobs` row |

## 9.5 Files (`/api/files`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `document.view` | Query: `q`, `status`, `limit`, `offset`, plus the filters below. `q` searches filenames, document contents, and each file's stored description — the last both by wording and by **meaning**, so describing a file in your own words finds it (see "Describing a file to find it" below). `mode=filename` for name-only; `mode=content` for the pre-description ranking |
| GET | `/count` | `document.view` | `{ count }` for the same filters, repository-wide. Refuses a `q` — see below |
| GET | `/filter-options` | `document.view` | What is actually there to filter by: `extensions` (with counts, including a `none` bucket), `locations`, and `dateRange` (`earliest`, `latest`, `undated`) |
| GET | `/:id` | `document.view` | Joins metadata, content length, latest classification, duplicate-group membership |
| GET | `/:id/download` | `document.download` | Streams via `StorageService`, never a raw filesystem path |
| GET | `/:id/preview` | `document.download` | Inline, mime-whitelisted rasterized preview (same bytes-exposure bar as download) |
| PATCH | `/:id` | `document.rename` and/or `classification.modify` | Body `{ filename? }` needs `document.rename`; `{ subjectId?, documentTypeId? }` needs `classification.modify` (also how "move a file to another subject" works — reclassifies, doesn't touch the filesystem) |
| POST | `/compare` | `document.view` | Body `{ fileIdA, fileIdB }`. Read-only: reports how alike two files are, using the same engine as probable-duplicate detection, and **never** creates or changes a duplicate group. Returns `verdict` (`exact` / `probable` / `distinct` / `not_comparable`), `similarity`, the `threshold` the pipeline would act on, a plain-language `explanation`, and per-file word counts. Exists because the automatic detector only ever compares a bounded candidate pool (same extension, most recent 300 — see `fileRepository.listSimilarityCandidates`), so any specific pair outside it was unaskable |
| DELETE | `/:id` | `document.delete` | Marks `deleted`, doesn't erase from disk |
| DELETE | `/remove-all` | `document.delete` | Background job; marks every file deleted |
| POST | `/:id/reveal` | `document.download` | Spawns the host OS's native file manager with the file selected (`explorer.exe /select,`, `open -R`, or `xdg-open` on the containing folder as a Linux fallback). Only works when this backend process is itself running on the desktop machine being browsed from, and only for `direct`-access-mode storage locations -- 400s otherwise. Sends no bytes over the network; see `fileService.revealInFileManager`. |

### Describing a file to find it

`GET /files?q=...` accepts a description, not just keywords. "the photo of a kid
blowing out birthday candles" finds a file whose stored description reads "a child at
a party with a cake", and an English phrase finds a French or Arabic document, because
the query and every description are compared as embeddings rather than as words. See
`docs/06-processing-pipeline.md` §6.8 for where descriptions come from — every file
has one, including photos, videos and audio recordings, which have no text at all.

Each result row carries how it was found, so the UI can say why something matched
rather than presenting an unexplained hit:

| Field | Meaning |
|---|---|
| `matched_by` | Which signals fired: `semantic` (by meaning), `description` (words in its description), `content` (the document's text, its filename or its AI title) |
| `match_reasons` | The same thing in plain language, ready to render |
| `similarity` | 0–1 cosine similarity for a semantic hit, `null` otherwise. Note this model's floor is high — unrelated text still scores ~0.55, and the search will not return anything below `DESCRIPTION_SEARCH_MIN_SIMILARITY` (default 0.62) |
| `rank` | The fused score results are ordered by. Not comparable across queries |

The response is still a **bare array** — several callers already consume that shape.
Whether the semantic half actually ran is reported in the `X-Search-Mode` response
header (`hybrid` or `lexical`); `lexical` means Gemini was unreachable or no API key is
set, so paraphrase matching was unavailable for that request and the results are
keyword-only. Search degrades rather than failing.

### Search filters

The same five parameters are accepted by `GET /files`, `GET /files/count`,
`GET /subjects` (where they filter the per-node counts) and
`GET /subjects/:id/documents`. One shared builder emits the predicates
(`repositories/fileFilters.js`), so a filter cannot mean one thing in the tree and
another in the list that tree links to.

| Param | Meaning |
|---|---|
| `ext` | Comma-separated file types, dot and case insensitive (`.PDF,docx`). The literal `none` selects files with no extension |
| `dateFrom`, `dateTo` | `YYYY-MM-DD`, inclusive at both ends, on `files.document_date` |
| `subjectId` | That subject **and everything filed underneath it**, by latest classification |
| `storageLocationId` | Which registered location the file lives in |
| `pathPrefix` | Prefix of the file's path relative to that location's root |

Notes that are easy to get wrong:

- **They apply with or without `q`.** "Every PDF from 2019" has no search term in it, so
  the filters are predicates on the plain listing as much as on the search.
- **Dates are calendar days in the database's timezone**, not UTC instants. `document_date`
  is `timestamptz` and a date-only source (EXIF, a PDF header) normalises to local
  midnight; comparing against UTC midnight drops the whole first day of the range
  wherever the server is ahead of UTC.
- **An undated file matches no range.** Over half this repository has no known
  `document_date`, so a date filter hides a lot; `/filter-options` reports `undated` so
  the UI can say so before the user wonders where the files went.
- **"Location" means storage location and folder path, not EXIF GPS.** GPS is on phone
  photos and essentially absent from scanned documents, so a GPS filter over this
  corpus would match nothing. If it is ever wanted it is a second filter, not a
  reinterpretation of this one.
- **Bad input is a 400, never a silently-ignored parameter** — a filter the backend
  dropped looks exactly like one that matched nothing.
- `GET /files/count` refuses a `q` on purpose: ranking is the expensive half of the
  search, and running it again only to count the rows would double the cost of every
  keystroke.

## 9.6 Documents (`/api/documents`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `document.view` | Query: `q`, `subjectId`, `limit`, `offset` |
| GET | `/:id` | `document.view` | Full view incl. current version, primary subject |
| PATCH | `/:id` | `classification.modify` | Display name / document type only — never touches the physical file |

### Document Types (`/api/document-types`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `document.view` | Read-only lookup list, used to populate document-type pickers |

## 9.7 Subjects (`/api/subjects`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `document.view` | Flat list with `parent_id` + `materialized_path`; client builds the tree. Each node carries `fileCount` (direct) and `totalFileCount` (rolled up through `materialized_path`). Accepts the §9.5 search filters, which narrow **both** counts — a tree whose numbers ignored the active filter would advertise files the list below refuses to show |
| GET | `/:id/documents` | `document.view` | Files currently classified under that subject (query: `q`, `limit`, `offset`, plus the §9.5 filters, which stack on top of the subject rather than replacing it) — sourced from files' latest classification result, see `fileRepository.listBySubject`. Note this is an EXACT-match scope, unlike the `subjectId` *filter*, which includes descendants: browsing a branch shows that branch's own files |
| POST | `/` | `subject.manage` | Body `{ parentId?, name, description? }`; `level` is derived from the parent (Subject → Category → Subcategory, max 3 deep) |
| PATCH | `/:id` | `subject.manage` | Body `{ name?, description? }` — rename only; `parent_id`/`slug` are immutable after creation so `materialized_path` never needs recomputing for descendants |
| DELETE | `/:id` | `subject.manage` | Blocked (400) if the subject has child subjects, has files currently classified under it, or has ever had files classified under it (classification history is kept for audit, see `classification_results`) |
| POST | `/import` | `subject.manage` | Multipart, one file per request: `file` + `relativePath` (e.g. `Finance/Budgets/Invoice.pdf`), same shape as `/storage-locations/upload`. Bypasses Discovery/Hash/Extract/Classify/Generate-Names entirely -- see `folderImportService.js`. The folder path becomes/reuses a Subject -> Category -> Subcategory chain (capped at 3 levels; deeper nesting folds into the 3rd level), the filename is kept as-is, and a single `manual` classification is recorded synchronously. No `processing_jobs` row is created. |

Distinct from `classification.modify` on `/api/files/:id`, which only assigns an
*existing* subject to a file. `subject.manage` governs the taxonomy's shape itself.

## 9.8 Duplicate Groups (`/api/duplicate-groups`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `duplicate.manage` | Defaults to `status=open` |
| GET | `/:id` | `duplicate.manage` | Members, each carrying what it takes to choose between them (below) |
| POST | `/:id/resolve` | `duplicate.manage` | Body `{ canonicalFileId }` — never deletes members |

Each member of `GET /:id` carries, beyond the filename and path: `size_bytes` and
`text_length` (as numbers, not bigint strings), `extension`, `status`,
`location_name` / `location_is_read_only`, `subject_name`, `text_quality` /
`needs_ocr`, `is_cloud_placeholder`, `canonical_filename`, and `is_canonical`.

That list is the point rather than padding. For an **exact** group the copies are
byte-identical, so nothing about the content can break the tie — what breaks it is
which drive the copy is on, whether it got indexed and named, whether it is filed,
and whether it is a cloud placeholder with no bytes present locally.

Comparing two members uses `POST /files/compare` (§9.5) — there is no group-scoped
compare endpoint, because the question "how alike are these two files" has nothing to
do with whether they are already in a group, and it is read-only: comparing never
creates or changes one.

## 9.9 Rename Proposals (`/api/rename-proposals`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `document.view` | Query: `status` (default `pending`) |
| POST | `/:id/approve` | `document.rename` | Sets `approved`; does NOT touch the filesystem |
| POST | `/:id/reject` | `document.rename` | Sets `rejected` |
| POST | `/bulk-apply` | `bulk.approve` | Body `{ proposalIds: [...] }` — enqueues `bulk_rename`; only proposals already `approved` are actually applied by the worker (spec §22/§23 double gate) |

## 9.10 Processing Jobs (`/api/processing-jobs`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | authenticated | Query: `status`, `jobType`, `limit`, `offset` |
| GET | `/:id` | authenticated | Includes `processing_job_items` summary for bulk jobs |

## 9.10a Triage (`/api/triage`)

Everything the pipeline could not confidently handle, in one queue, with the reason
attached. Not a new table — it is a derived view over facts already recorded in
`files`, `file_content` and `processing_jobs`, which were previously only reachable
as counts on three unrelated pages.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `document.view` | Query: `reason`, `limit`, `offset`. Each row carries `reason`, `reasonLabel`, `reasonExplanation`, `retryable`, `retryJobType` and (when not retryable) `retryBlockedMessage`, so the UI never keeps its own copy of the vocabulary. An unknown `reason` is a 400, not a silently-unfiltered list |
| GET | `/summary` | `document.view` | `{ total, inFlight, reasons: [{ key, label, explanation, count }] }` — every reason including the zeros. Backs the filter tabs and the nav badge |
| POST | `/:id/retry` | `scan.run` | Re-enqueues the earliest stage that still has no result (`hash` when the file was never hashed, otherwise `extract_text`; for a failed job, that same job with its original payload). Idempotent — every stage it can enqueue is. 400 when the reason is not retryable, 404 when the file is not in the queue |

**Reasons**, most serious first: `missing` (the file is gone from disk — not retryable,
rescan the location), `job_failed`, `extraction_failed`, `stalled`, `needs_ocr`,
`unreadable`. A file appears exactly once, under its most serious reason.

**Deliberately excluded** from the queue: files with a queued or running job — they are
waiting their turn, not stuck, and during an import that is most of the repository.
`summary.inFlight` reports that number separately so a small queue mid-import is
legible. Also excluded: a job that failed less than five minutes ago (still inside
the queue's retry ladder), and a file whose `text_quality` is `NULL` (indexed before
migration 023 — never judged, which is not the same as judged bad).

Renaming, re-filing and previewing a triaged file are **not** endpoints here — they are
`PATCH /files/:id` and `GET /files/:id/preview`, the same ones the Files page uses.

## 9.11 Audit Logs (`/api/audit-logs`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `audit.view` | Query: `entityType`, `entityId`, `limit`, `offset` |

## 9.12 AI Chat (`/api/ai`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/chat` | `classification.modify` | Body `{ message, history?, context?: { selectedSubjectId?, files? } }`. Returns `{ reply, actions[] }`. |

The Subjects-page chatbot (`geminiChatService.js`). Deliberately not a function-calling /
tool-execution loop -- every call is read-only server-side (fetches the current subject
tree fresh from the DB, never trusts `context` for anything but extra prompt context) and
returns `actions` as PROPOSALS only, using the same structured-output (`response_format` +
JSON schema) technique as the classifier in `geminiClassifier.js`. Each action is one of
`move_file`, `move_subject_contents`, `create_subject`, `rename_subject`, `delete_subject`;
the frontend renders them as Apply/Reject cards and only calls the normal REST endpoints
above once a human clicks Apply -- nothing is ever executed as a side effect of a chat
turn itself. Any action referencing a subject/file id outside what was just given to the
model is dropped before the response leaves the server (defense in depth against a
hallucinated id, on top of the system prompt telling it not to invent one).

## 9.13 Email Accounts (`/api/email-accounts`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/oauth/:provider/callback` | *(none — public)* | Hit directly by Google's own redirect, not by frontend JS, so it can't require an `Authorization` header. Identity is recovered from the signed `state` param instead (`jwt.signOAuthState`/`verifyOAuthState`, 10-minute expiry). Always ends in `res.redirect()` back to `${FRONTEND_URL}/inbox?connected=<email>` or `?error=<message>` — never returns JSON. Registered before the router's `authenticate` middleware for this exact reason. |
| GET | `/` | `email.manage` | Accounts connected by the logged-in user |
| GET | `/connect/:provider` | `email.manage` | `:provider` is `gmail` (the only supported provider; Outlook was removed). Returns `{ authUrl }`; frontend does `window.location.href = authUrl` — this is a full browser navigation to Google's consent screen, not an API call the frontend can complete in place |
| POST | `/:id/sync` | `email.manage` | Enqueues an `email_sync` job for that account (202, same envelope as other job-enqueuing endpoints: `{ processingJobId, status }`). Syncs also run automatically every `EMAIL_SYNC_INTERVAL_MINUTES` (default 15) via `emailSyncScheduler.js` |
| DELETE | `/:id` | `email.manage` | Disconnects: best-effort revokes the Google token, clears the stored encrypted refresh token, sets `status = 'disconnected'`. Auto-sync stops; rows already in `inbox_messages` are left as-is |

Gmail is integrated via raw `fetch()` OAuth2 calls (no `googleapis` SDK), matching the
style already used for the Gemini client. It is the only provider; Outlook was removed. Refresh
tokens are encrypted at rest with AES-256-GCM (`utils/tokenCrypto.js`, key derived from
`TOKEN_ENCRYPTION_KEY`). See `docs/10-email-inbox.md` for the full design, including why
periodic sync uses a plain `setInterval` (`emailSyncScheduler.js`) instead of the queue's
native repeatable-job feature — every job in this codebase is created through the single
`enqueueJob()` entry point, and the scheduler preserves that by calling `enqueueJob()`
itself on each tick rather than going around it.

## 9.14 Inbox (`/api/inbox`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `email.manage` | Query: `status` (`kept` default, or `deleted` for the "what did auto-triage remove" transparency view), `limit`, `offset`. Scoped to the logged-in user's own connected accounts via a join on `email_accounts.user_id` — one user's inbox never appears in another user's list |

Each row is a triaged copy of a provider message (`inbox_messages`), not the message
itself — the actual email always stays in Gmail. `provider_web_link` opens that
real message directly in the provider's own web inbox (`window.open`, new tab). Rows are
never deleted when a message is auto-trashed upstream; `status` flips from `kept` to
`deleted` and the row stays, so there's always an auditable record of what the triage
removed (same "history is additive" philosophy as `classification_results`/`audit_logs`).
Auto-deletion is fully automatic (no confidence-gated review queue) — see
`docs/10-email-inbox.md` for the classifier's safety bias (uncertain → `important`, never
uncertain → `junk`) given that a `junk` classification has no human review step before the
upstream trash call.

## 9.15 What's deliberately not here yet

Bulk classification review, document-version confirmation endpoints, and desktop-agent
registration/heartbeat endpoints are not in this pass — they depend on UI workflows
(Phase 11) and the agent protocol (Phase 12) respectively, and adding them now would be
guessing at shapes nothing consumes yet.
