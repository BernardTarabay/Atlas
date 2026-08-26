# AI classification escalation tier (post-Phase-11 addition)

The rule-based classifier from Phase 5 (`jobs/processors/classifyProcessor.js`)
keyword-matches filenames/extracted text against the seeded taxonomy. It's
free, instant, and fully explainable, but it can only assign a broad bucket
("Finance") -- it can't tell two invoices from different vendors apart, and
it can't describe what a document actually *is*.

This tier adds an optional, opt-in LLM pass (Gemini 3.1 Flash-Lite) that
only runs when the rule-based pass wasn't confident, and produces three
things the rule-based classifier never could: a specific, human-scannable
title; a one-to-two-sentence summary for list-view scanning without opening
the file; and extracted entities (counterparty, date/period, document
identifier) that feed directly into naming.

## Why it's off by default

Set `GEMINI_API_KEY` in `backend/.env` to turn it on -- see
`backend/.env.example` for the full set of `AI_*` variables. With no key
set, every code path in this feature is a no-op and the pipeline behaves
exactly as it did before this tier existed.

## Cost controls (in order of what actually saves money)

1. **Escalation only, not every file.** `AI_ESCALATE_BELOW_CONFIDENCE`
   (default `high`) means the LLM only runs when the rule-based result was
   `low` or `medium` confidence. A clean keyword match never costs an API
   call.
2. **Duplicate-skip.** Before calling Gemini, `classifyProcessor` checks
   `files.sha256_hash` for a sibling file that's already been AI-classified
   (`fileRepository.findClassifiedSiblingByHash`) and reuses that result
   instead of re-classifying identical content.
3. **Bounded prompt.** The extracted-text excerpt sent to the model is
   capped at `geminiClassifier.MAX_EXCERPT_CHARS` (6,000 characters) --
   enough to identify a document, not the whole file.
4. **Minimal thinking.** `generation_config.thinking_level: "minimal"` is
   set explicitly. Gemini 3-series models think by default, and thought
   tokens are billed as output tokens; this is a bounded classification/
   extraction task that doesn't benefit from deep reasoning, so thinking is
   turned down rather than left at the model's default.
5. **No artificial cap, deliberately.** There used to be an
   `AI_DAILY_CALL_CAP` (default 500) counted over a rolling 24h window, and a
   default 12 req/min client-side pace. Both are gone. The daily cap was
   enforced three inconsistent ways -- `classifyProcessor` counted only
   `ai_classification.called`, `ocrService` only `ai_image_description.called`,
   and `descriptionService` the sum of all three -- so a "500-call cap" let
   1,003 calls through in a day while the description stage, the only one
   measuring the true total, starved and left 5,730 files stranded in
   `failed_retryable`.

   The fix was not a fourth counting rule. A cap that silently converts "your
   files are being processed" into "5,730 files failed" is worse than no cap.
   The real quota belongs to Google and Google enforces it: 429 responses
   carry a `Please retry in Ns` hint that every caller honours and retries
   (`services/ai/rateLimiter.js`). Spend stays **visible** rather than
   restricted -- every billed call is written to `audit_logs`, and
   `scripts/measure-ai-cost.js` reports it. Setting
   `GEMINI_RATE_LIMIT_PER_MINUTE` to a positive value opts back into
   client-side pacing; nothing sets it by default.

## What gets stored

- A new `classification_results` row per AI call, `method: 'llm'`, with
  `raw_output` holding the short title, summary, entities, and the actual
  Gemini token usage for that call (`usage.total_input_tokens` /
  `total_output_tokens` / `total_thought_tokens`) -- so real spend is
  auditable per file, not just estimated.
- Migration 012 adds `ai_short_title`, `ai_summary`, `ai_entities`,
  `ai_classified_at` directly on `files`, denormalized so list views (the
  Files page) can show a preview without joining/parsing JSON per row.

## Naming impact

**Revised: this tier now drives naming directly, not just as an entities
add-on.** `namingService.buildCanonicalName` prioritizes a real title over
a taxonomy bucket name (see docs/03-taxonomy.md §3.6 for the full
rationale and priority order): the document's own embedded title metadata
when it has one, otherwise `files.ai_short_title` -- the AI tier's own
read of the content, written the way a person would title the file
themselves ("Letter from Mom", "Annual Returns 2024"), not a category
label. `files.ai_entities` (party/date/identifier) is still used, but now
only to lightly disambiguate a title that doesn't already contain that
fact, rather than being the only thing that unlocks non-bucket naming.

This deployment's `backend/.env` sets `AI_ESCALATE_BELOW_CONFIDENCE=always`
(overriding the code default of `high` above) specifically so this tier
-- and therefore real titles -- runs on every file, not just low/medium
rule-based misses.

## What this deliberately does not do

- **No safety change.** A richer AI classification still only produces a
  `rename_proposal` -- the human-review and bulk-apply double gate (spec
  §22/§23) is completely unaffected. Bad AI output means a bad *suggestion*,
  never a bad rename.
- **No provider abstraction yet.** `geminiClassifier.js` calls the Gemini
  Interactions API directly. Swapping in a different provider (a local
  Ollama model, Claude, etc.) means writing a sibling module with the same
  `classify({ filename, bodyText, subjects, documentTypes })` shape and
  swapping the require in `classifyProcessor.js` -- not a redesign, but not
  built as a pluggable interface either, since there was only one consumer
  to design against.
- **Not verified against a live key.** This was built and reviewed against
  the current Gemini Interactions API docs (endpoint, request/response
  shape, structured-output schema, and the `gemini-3.1-flash-lite` model
  ID all confirmed from https://ai.google.dev as of this writing), but no
  live API call was made during development -- there's no API key available
  in the environment this was built in. The first real call you make is the
  first real test of this integration end to end.
