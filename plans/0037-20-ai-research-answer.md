> **Status:** Done · **Issue:** [#20](https://github.com/CaseGuard-AI/CaseGuard/issues/20) · **PR:** [#170](https://github.com/CaseGuard-AI/CaseGuard/pull/170)

# #20: research answer with checked, stored citations

## Context

Handoff item 6, the last link of load → embed → retrieve → answer. It builds on #18 (embeddings) and #19 (retrieval), both merged, and on the #21 gateway. The api side already exists (`apps/api/src/routes/conversations.ts`, `clients/ai.ts`). It calls `POST /ai/v1/research/answer` and accepts any status, but rejects an unanswerable answer that carries citations. **No contract change.**

**Requirements:** FR-RES-5, FR-RES-6, FR-RES-9, FR-RES-10, FR-TRUST-2, FR-TRUST-4, FR-TRUST-8, FR-TRUST-9, FR-TRUST-10, SEC-11, NFR-19.

## Decisions

- **Pipeline** (`research/answer.py`):
  1. allow-list check (fail closed, 503);
  2. `retrieve` (#19);
  3. prompt `answer-v1` with numbered passages;
  4. gateway `generation`;
  5. parse;
  6. existence check;
  7. status;
  8. **one transaction** writing `ai.answer_traces` + `ai.citations` + `ai.verifications`;
  9. the response is built from the statuses **read back** (FR-TRUST-10).
- **Prompt `answer-v1`** (`research/prompts/`), written for 7-8B models:
  - a fixed `ANSWER:` / `QUOTES:` shape, `[[p:N]]` markers after each legal sentence, one exact quote per cited passage;
  - a worked example;
  - `NOT_ANSWERABLE` otherwise.
  
  New wording means a new version module, never an edit.
- **The parser is lenient on layout and strict on substance.** Passage numbers come only from markers and quotes only from `[p:N]` lines. A reply with no markers at all counts as unanswerable: an uncited legal answer can't be shown (FR-RES-5).
- **The existence check** passes only if:
  - the marker's passage was retrieved for this question;
  - its document still exists;
  - the quote is a verbatim span of the passage.
  
  Whitespace runs match any whitespace, because PDF line breaks fall mid-sentence; case, punctuation and every other character must match. The **stored quote is the source's own span**, so it's a byte-for-byte substring of the chunk (FR-RES-10).
- **Status** (`trust/status.py`) follows PRD §7.2 exactly:
  - existence fail → `unverified`;
  - support not passed, or a blocking flag → `needs_review`;
  - otherwise `verified`.
  
  In M1 the support check is `not_run`, so nothing is ever `verified` (FR-TRUST-8). The source flags are `headnote_only` and `third_party_source`. `checks` also stores `existence_reason`.
- **A marker for a passage the model was never shown** has no source to attribute. It's removed from the text and counted in `answer_traces.models.invalid_markers`.
- **Unanswerable** (nothing retrieved, `NOT_ANSWERABLE`, or no valid citation) → `answerable=false`, no citations, a short explanatory text (the web shows it under its "unanswerable" heading), and the trace is still written. When nothing is retrieved, the model is never called.
- **A retried `requestId`** replaces its earlier trace and citations; `request_id` is the trace's key.
- **Errors:**
  - `NoProviderError`, `GatewayError`, `CorpusNotReady`, `EmbeddingMismatch` and DB `OperationalError` → 503 problem+json;
  - request validation → 400 problem+json, naming fields only and never echoing the question;
  - unknown ids → 404.
- **Models are loaded lazily, once per process** (`api/deps.py`, `lru_cache`), and are replaceable via `dependency_overrides`.
- **No question text** is stored or logged; the api's audit row covers the request (FR-TRUST-12).

## Verification

- `ruff` and strict `mypy` are clean. `pytest` gives 175 passed, 2 skipped (they need `DATABASE_URL` / `APP_TEST_DATABASE_URL`, set in CI).
- `tests/test_trust.py` (30): every status branch (`status.py` 100% branch coverage), "M1 never verified", spans across line breaks, exact-match rules, existence reasons, the parser.
- `tests/test_answer.py` (26, DB, fake gateway, every 200 validated against `ai.v1.yaml` with jsonschema):
  - an answer with a checked citation (`needs_review`);
  - one trace and one verification per citation, and the question never stored;
  - a fabricated quote, and a quote from another passage → `unverified`;
  - an invalid marker dropped; the head-note flag;
  - unanswerable both ways; nothing retrieved means no model call;
  - the store read back, including after a direct DB change; a retried request id;
  - the model receiving the passages and the history;
  - 503 for no provider (before any work), provider failure and no corpus;
  - 400 for 7 invalid shapes; source fetch; 404s; the token required.
- **Mutation check:** with an existence check that always passes, 3 tests fail.
- **Still to do:** the end-to-end run with a real model on the team's embedded corpus.
