> **Status:** In progress · **Issue:** [#212](https://github.com/CaseGuard-AI/CaseGuard/issues/212) · **PR:** [#218](https://github.com/CaseGuard-AI/CaseGuard/pull/218)

# #212: drafting templates and section assist through the trust layer (ai)

## Context

The drafting contract is merged (#209, PR #216): ai.v1 has `listDraftTemplates` and `draftSection`. services/ai has no drafting module yet. Research (#20) already runs every citation through the trust layer, but the per-marker loop (existence → support → flags → status → `NewCitation`) lives inside `research/answer.py`, so drafting cannot reuse it. This is Track D's ai layer in plan 0052.

**Requirements:** FR-DRAFT-1, FR-DRAFT-3, FR-TRUST-10, FR-TRUST-12.

## Decisions

- **Refactor first, its own commit.** `trust/verify.py` takes the per-marker work out of `research/answer.py`: `verify_citation` (existence, support only after existence passed, `source_flags`, `decide`, the `checks` dict, a `NewCitation`) and `verify_markers` (walks a parsed reply, swaps each `[[p:N]]` for `[[c:<uuid>]]`, drops markers for passages never shown and counts them). Research behaviour is unchanged and its tests are untouched.
- **Templates** are YAML in `drafting/templates/` (`bail_application`, `plaint`, `legal_notice`), loaded and validated once. Each has a `version`, fields with a `caseField` from ai.v1's `CaseField` enum (or null), and sections with `key`, `heading`, `required`, `assistable` and `guidance`. A template that does not validate fails at load, so a bad file never reaches a route. Parties go into one `parties` field, since `Case.parties` is one list.
- **Prompt `draft_section_v1`** keeps `answer_v1`'s output shape (`ANSWER:` with `[[p:N]]` markers, `QUOTES:` with `[p:N] "..."` lines), so `parse_reply` is reused unchanged. A section that cites nothing (for example the facts) is still returned, as text without citations; `parse.answer_text` gives that text.
- **`assist.py`** fails closed on the provider first, exactly as `answer_question` does, then retrieves within the scope using the template, the section heading, the instruction and the field values as the query, calls `gateway.chat("generation")` with the allow-list and override, parses, verifies through `trust/verify.py`, and writes the trace and citations in one transaction. The citations in the response are read back from the store (FR-TRUST-10).
- **Audit (FR-TRUST-12).** One `ai.answer_traces` row per request under `requestId`, so `ai.citations.request_id` keeps its foreign key. No migration: the existing `models` jsonb records `prompt: draft-section-v1`, `kind: drafting` and the template and section, next to the model ids. `answerable` is true when text came back. The instruction and the fields are never stored (the trace holds only retrieval ids and scores).
- **Routes** `GET /ai/v1/drafting/templates` and `POST /ai/v1/drafting/sections`, per ai.v1. 400: unknown template or section, a section that is not `assistable`, duplicate providers, a bad credential (shared with `answerQuestion`). 503: no allowed generation provider, a failing provider, the corpus not ready, the database down.
- **`pyyaml`** moves from the dev group to the runtime dependencies (it was already installed through `huggingface-hub`).

Branch: `feature/212-drafting-assist` off `staging`. PR title: `feat(ai): drafting templates and section assist through the trust layer (FR-DRAFT-1, FR-DRAFT-3, FR-TRUST-10, FR-TRUST-12)`.

## Changes

1. `services/ai/src/caseguard_ai/trust/verify.py`; `research/answer.py` uses it.
2. `services/ai/src/caseguard_ai/drafting/`: `catalog.py` (loads and validates), `templates/*.yaml`, `prompts/draft_section_v1.py`, `assist.py`.
3. `research/parse.py`: `answer_text`.
4. `api/v1.py`: the two routes; the credential check shared by both POSTs.
5. Tests: `tests/test_drafting.py` (contract conformance, statuses equal `getCitation`, failed existence is `unverified`, not assistable is 400, no provider is 503, the instruction is never stored), including the template checks (every template validates against ai.v1, the bail application covers s.497 and s.498, the plaint has the Order VII particulars).
6. `pyproject.toml`, `uv.lock`, `services/ai/README.md`, `CHANGELOG.md`, `docs/engineering/work-log.md`, this plan.

## Verification

- `uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest` in `services/ai`, with `AI_TEST_DATABASE_URL` on Track D's own database.
- Push, open the PR against `staging`, wait for `ci-ok`. The integrator merges after the user approves.
