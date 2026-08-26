# Email inbox triage (post-Phase-11 addition)

> **Outlook / Microsoft 365 support has been removed.** Gmail is the only email
> provider. `microsoftOAuthClient.js` and `outlookApiClient.js` are deleted, the
> `MICROSOFT_OAUTH_*` environment variables are gone, and `EmailProvider` in
> `models/enums.js` now contains only `gmail` — so an Outlook account can no longer be
> connected, refreshed or synced. The Postgres `email_provider` enum still carries the
> `'outlook'` value, because Postgres cannot drop a value from an enum in place and any
> historical row must remain readable; nothing accepts it as input. An account row left
> over from before the removal renders on the Inbox page (so it can be disconnected) and
> its sync fails loudly rather than silently returning an empty mailbox.

A separate "Inbox" page, distinct from the document taxonomy. The user connects a Gmail
account; the app periodically pulls new inbox mail, auto-deletes what looks like
advertising/spam/newsletter clutter, and leaves everything else visible on the Inbox page
as a curated, read-only view. Opening a message never renders the email body in this
app — it opens the real message in Gmail's own web inbox in a new tab. Nothing about this
feature reads or writes the taxonomy, files, or documents; it's additive and independent
of Phases 1–11.

## Why OAuth2, not IMAP/password

Gmail has retired plain password auth for third-party mail access. `googleOAuthClient.js`
implements the standard authorization-code flow with raw `fetch()` calls (no `googleapis`
SDK — same style as the Gemini client already in this codebase). Requested scope:

- **Gmail**: `https://www.googleapis.com/auth/gmail.modify` (read + move-to-trash;
  never `gmail.readonly`-only, since triage needs to trash messages, and never the
  broader `mail.google.com` scope, which also allows permanent delete/send)

`access_type=offline&prompt=consent` is forced on the Google auth URL so a refresh token
is issued on every consent, not just the first one — without `prompt=consent`, a user who
revokes and reconnects wouldn't get a new refresh token back from Google on the second
grant. Google generally does not return a refresh token on a plain refresh call, but both
`emailAccountService` (manual actions) and `emailSyncProcessor` (every sync) check the
token response for a new `refresh_token` and re-persist it when present, so a rotated
token is never lost.

Refresh tokens are the only long-lived secret stored. They're encrypted at rest with
AES-256-GCM (`utils/tokenCrypto.js`; key derived via SHA-256 of `TOKEN_ENCRYPTION_KEY` —
see `backend/.env.example`, generate with `openssl rand -hex 32`). Access tokens are never
persisted — each sync exchanges the refresh token for a short-lived access token and
discards it after use.

## Connect flow

1. Frontend calls `GET /api/email-accounts/connect/:provider` → gets back `{ authUrl }`
   and does a full-page `window.location.href` navigation to it (not an API call the
   frontend can complete in place — this has to be a real top-level browser navigation to
   Google/Microsoft's own consent screen).
2. The provider redirects the browser back to
   `GET /api/email-accounts/oauth/:provider/callback?code=...&state=...`. This route is
   deliberately exempt from the router's normal `authenticate` middleware (registered
   before `router.use(authenticate, ...)` in `emailAccountRoutes.js`) because the
   provider's redirect carries no `Authorization` header. Identity instead comes from
   `state`, a short-lived (10 min) JWT signed with the existing `env.jwt.accessSecret`
   (`utils/jwt.js` `signOAuthState`/`verifyOAuthState`) — no extra DB table needed to
   survive the redirect round trip.
3. `emailAccountService.handleCallback` exchanges the code for tokens, resolves the
   connected mailbox's own address (`getUserEmail`), encrypts and stores the refresh
   token, and immediately enqueues a first `email_sync` job so the Inbox page has content
   without waiting for the next scheduled tick.
4. The callback always ends in `res.redirect()` to `${FRONTEND_URL}/inbox?connected=<email>`
   or `?error=<message>` — the Inbox page reads those query params on mount, shows a toast,
   and strips them from the URL.

## Sync: why a plain `setInterval`, not a scheduler inside the queue

Every background job in this codebase is created through one function,
`enqueueJob(jobType, payload, opts)` (`queues/index.js`), which writes a `processing_jobs`
row — and since migration 040 that row *is* the queue entry, so a job cannot exist
without one. Job list and status endpoints rely on that: they assume a DB row exists for
anything running.

The original reason for this section was that BullMQ's native repeatable-job feature
created jobs directly in Redis on its own schedule, bypassing `enqueueJob()` and
producing sync runs with no `processing_jobs` row. That specific hazard is gone with
Redis, but the conclusion is unchanged and now has a simpler justification: there is one
way to create work, and a second scheduling mechanism inside the queue would be a second
way.

Instead, `jobs/emailSyncScheduler.js` runs a plain `setInterval` (default
`EMAIL_SYNC_INTERVAL_MINUTES=15`) inside the API process. Each tick calls
`emailAccountRepository.listConnected()` and calls `enqueueJob(JobType.EMAIL_SYNC, ...)`
once per connected account — same code path, same `processing_jobs` row, as a manual
"Sync now" click. The interval is `.unref()`'d so it never blocks graceful shutdown, and
`server.js` starts/stops it alongside the HTTP server.

## Triage classification

`services/ai/emailTriageClassifier.js` mirrors the two-tier philosophy of the document
classifier (`geminiClassifier.js`): a free, instant rule pass first, escalating to Gemini
only when the rules aren't confident.

**Rule pass** (`ruleClassify`) is high-confidence-only — it never guesses:
- Gmail label `SPAM`, `CATEGORY_PROMOTIONS`, or `CATEGORY_SOCIAL` → `junk`
- Gmail label `IMPORTANT` or `CATEGORY_PERSONAL` → `important`
- Sender matches a bulk-mail pattern (`no-reply@`, `newsletter@`, `marketing@`, etc.)
  *and* the message carries a `List-Unsubscribe` header → `junk`
- Subject matches common promo phrasing ("unsubscribe", "% off", "flash sale", ...) → `junk`
- Anything else → falls through to Gemini

**AI escalation** uses the same structured-output technique as the document classifier
(`response_format` + JSON schema: `{ classification, confidence, reason }`). The system
prompt is deliberately biased toward `important` on doubt — it says outright that this
classification determines whether the message is auto-trashed with **no human review**,
and that genuine uncertainty should resolve to `important`. This bias is a direct
consequence of the product decision (see below) to make deletion fully automatic rather
than confidence-gated.

## Fully automatic deletion — and the safety rails around it

The user chose fully automatic triage: no review queue, no "are you sure" step between a
`junk` classification and the message being trashed upstream. Given that, the design
leans on rails elsewhere instead of a human gate:

- **Reversible by construction.** Neither provider call is a permanent delete —
  Gmail's `trashMessage` moves to Trash (`messages/{id}/trash`); the former Outlook path,
  `moveToDeletedItems` moves to the Deleted Items folder (`messages/{id}/move`). Both
  providers keep trashed mail recoverable for a retention window before permanent
  deletion, same as clicking the provider's own trash button.
- **Full transparency.** Every message classified `junk` still gets an `inbox_messages`
  row (`status = 'deleted'`) instead of being silently dropped — the Inbox page's
  "Auto-removed" tab lists exactly what triage removed and why (rule vs. AI,
  confidence), so nothing disappears invisibly.
- **Fail closed, not open.** If classification itself errors, `emailSyncProcessor`
  defaults the message to `important`/kept rather than risking a false `junk`. If the
  upstream trash/move call fails after a message was optimistically marked `deleted`,
  the row is rolled back to `kept` — the local record never claims something was removed
  when it wasn't.
- **Audit trail.** Every auto-trash action is recorded in `audit_logs`
  (`email.auto_trashed`), same as every other consequential action in this app.

## Data model

`email_accounts` — one row per connected mailbox (`provider`, `email_address`, `status`:
`connected`/`disconnected`/`error`, encrypted refresh token, sync cursor, last error).
`inbox_messages` — one row per provider message ever seen, scoped to its `email_account_id`
(`provider_message_id` unique per account so re-syncing never double-inserts), with
`classification` (`important`/`junk`), `classification_method` (`rule`/`ai`), and `status`
(`kept`/`deleted`). See `backend/migrations/016_email_inbox.sql` for the full schema.
Rows are additive-only — a `deleted` row is never removed, only its `status` changes,
preserving history the same way `classification_results`/`audit_logs` do elsewhere in
this app.

## Setup

All required environment variables (`TOKEN_ENCRYPTION_KEY`, `FRONTEND_URL`,
`GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI`, `EMAIL_SYNC_INTERVAL_MINUTES`) and the
Google Cloud Console setup steps to obtain them are documented inline in
`backend/.env.example`. In short:

1. Generate `TOKEN_ENCRYPTION_KEY` with `openssl rand -hex 32`.
2. Google Cloud Console: enable the Gmail API, create an OAuth client (Web application),
   add the redirect URI, and leave the OAuth consent screen in **Testing** mode with your
   own account added as a test user — this skips Google's verification review, which is
   otherwise required before `gmail.modify` can be granted to arbitrary users. Fine for a
   self-hosted, personal-use deployment; would need to go through verification for a
   multi-tenant public deployment.
3. Azure Portal: register an app, add `Mail.ReadWrite`, `offline_access`, `User.Read`
   delegated permissions, add the redirect URI.
4. Like the `subject.manage` permission added earlier this project, the new
   `email.manage` permission requires **`npm run db:seed`** to be re-run against the live
   database before the Inbox nav item or its endpoints become reachable — seeds are not
   auto-applied on migrate.

## What's deliberately not here yet

No IMAP/other-provider support (Yahoo, iCloud, Outlook, self-hosted mail) — Gmail covers
the two providers the user actually asked for. No per-message manual "restore"/"mark
important after the fact" action from the Inbox page — undoing a triage decision today
means going into the provider's own web inbox directly (which the "Open" link on every row
already links to). No configurable rule/keyword editing UI — the rule tier's patterns are
constants in `emailTriageClassifier.js`, not database-backed or user-editable.
