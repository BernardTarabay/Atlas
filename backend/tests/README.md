# Tests

```bash
npm test
```

Uses Node's built-in test runner (`node --test`) — **no new dependencies**, in
keeping with the rest of this codebase's preference for the platform over a
framework (raw `fetch` instead of `googleapis`/MSAL, hand-rolled validators
instead of a validation library).

## What's covered, and why these things specifically

Every test here is a **pure unit test**: no live Postgres, no network.
They run in well under a second and can't fail for environmental reasons. Files
that set secrets do so *before* requiring `config/env` — `dotenv` never
overrides an already-present variable, so the suite is hermetic and does not
depend on whatever is in your `.env`.

| File | Covers | Why it's high-risk |
|---|---|---|
| `pathSafety.test.js` | `resolveWithinRoot` | Path traversal turns "rename a file" into "write anywhere on the host". Includes the `/srv/repo` vs `/srv/repo-evil` prefix trap. (The `sanitizeRelativePath` cases went with the upload routes — see `routes/storageLocationRoutes.js`.) |
| `filenameSafety.test.js` | `assertSafeFilename`, `capFilenameLength` | The layer under path safety: a name can stay inside the root and still be one Windows will not store. Pins the reserved device names (`NUL`, `COM1`), the NTFS alternate-data-stream colon, trailing dots (Windows strips them, so the DB would hold a name that is not on disk), and the length cap that keeps mirror shortcuts under MAX_PATH. The negative assertions matter most: French, Arabic, Hebrew and CJK filenames must pass untouched. |
| `tokenCrypto.test.js` | AES-256-GCM encrypt/decrypt | `email_accounts.refresh_token_encrypted` is a standing credential granting read+trash on a real mailbox. Asserts random IVs (GCM nonce reuse is catastrophic), auth-tag tamper rejection, and that a missing key fails loudly instead of silently defaulting. |
| `rbac.test.js` | `requirePermission` | The actual enforcement point — a hidden frontend button is cosmetic. Asserts exact (not prefix/substring/case-insensitive) permission matching. |
| `jwt.test.js` | access tokens, refresh tokens, OAuth state | Includes the `alg:none` bypass, wrong-secret forgery, expiry, and that refresh tokens are stored only as a SHA-256 hash. Pins the OAuth state window to 10 minutes. |
| `emailTriage.test.js` | `ruleClassify` | This tier auto-trashes mail with **no human review**. The most important assertions are the *negative* ones: a `no-reply@` sender without `List-Unsubscribe` (receipts, password resets, 2FA) must fall through to the AI tier rather than be junked on the sender pattern alone. |
| `namingService.test.js` | canonical name + folder building | Decides what files are physically renamed to. This repository's real content is French/Arabic/Hebrew, and an earlier `[a-zA-Z0-9]` filter deleted non-Latin names outright — those regressions are pinned here. |
| `utils.test.js` | pagination, signature detection, filename collisions | `fs.rename()` silently overwrites, so `resolveAvailableFilename` is the only thing between a bulk rename and data loss. Signature tests pin spec §7 (content beats extension) and §8 (a PBIX is not a spreadsheet). |
| `taxonomyMatcher.test.js` | keyword terms + matching for the rule tier | This was wrong in production and nothing caught it: of 13 seeded document types exactly one was ever assigned, to a personal narrative, on the substrings inside "playbook" and "fantasy books". The keyword list was `[name, code]` — the same word twice for every single-word type — so one occurrence scored 2, silently satisfying a MEDIUM threshold whose own comment demanded "two independent body matches". Pins the substring bleed, the double-count, and that French/Arabic words are not split by the ASCII `\b` rule. |

## What is deliberately *not* covered here

- **The AI escalation tiers** (`geminiClassifier`, `geminiChatService`, and
  `emailTriageClassifier.callGemini`) — these need a live `GEMINI_API_KEY` and a
  network call. Only the free rule tier is unit-tested.
- **Repositories and the job pipeline** — these are genuinely integration-level
  (they need Postgres). The README documents that they were verified
  by hand against real services; that verification has not been automated.
- **The frontend** — no component tests. `npm run build` in `frontend/` is
  currently the only automated check there.

These are the obvious next places to extend coverage, in that order.
