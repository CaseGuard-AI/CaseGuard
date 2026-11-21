> **Status:** Done · **Issue:** [#214](https://github.com/CaseGuard-AI/CaseGuard/issues/214) · **PR:** [#217](https://github.com/CaseGuard-AI/CaseGuard/pull/217)

# #214: the procedural linter engine and rule sets (services/ai)

## Context

The linter contract is merged (#209, PR #216). ai.v1 has `listLintRulesets` (`GET /ai/v1/lint/rulesets`) and `lintDocument` (`POST /ai/v1/lint`). [ADR-0012](../docs/adr/0012-deterministic-read-only-linter.md) fixes the design: rule sets are versioned YAML files in services/ai, the engine is pure (no database, no model provider, no writes), findings carry UTF-16 spans, and `inputSha256` is the SHA-256 of the text's UTF-8 bytes. Nothing in services/ai served either route yet.

This is the first step of Track L in [plan 0052](0052-209-precedents-drafting-linter-contract.md) (ai → api #215 → web #108). Bail application rules come first, then the plaint (PRD M3).

**Requirements:** FR-LINT-1, FR-LINT-2, FR-LINT-3.

## Decisions

- **Rules are data.** `linter/rules/bail_application.yaml` and `linter/rules/plaint.yaml`, each with `id`, `documentType`, `version`, `title` and `rules`. A rule has `id`, `kind`, `severity`, `title`, `message`, `detect` and `source` (`{provision, reference}` or `null`). Loading is strict: an unknown key, a bad id, an unknown kind or severity, a duplicate id, a pattern that doesn't compile or a missing `source` key is an error at import, so a broken rule file fails the tests rather than a request.
- **Detection primitives**, all case-insensitive and multi-line:
  - `anyOf`: one of the patterns must match; `allOf`: a list of pattern groups, each of which must match.
  - `near: {anchor, window}`: the match must start within `window` characters of an anchor match. A particular that is missing next to a present anchor (an FIR mentioned without a number) gets the anchor's span, so the web can show where it was expected; with no anchor the span is `null`.
  - `when` / `unless`: the rule applies only if (or unless) another detection matches. This is how the s.498 rule (apprehension of arrest) and the s.497-only rules (custody, arrest date) switch on the title's provision.
  - `order: [ruleA, ruleB]` (kind `structure`): B's section must not come entirely before A's. It fires only when both are present; a missing one is reported by its own rule.
- **Sources are honest (FR-LINT-2).** A provision is cited only where it plainly underlies the rule: ss.497 and 498 CrPC for the bail title, the offence (s.497(1)), the grounds (s.497(2)), the statutory-delay proviso and the apprehension of arrest (s.498); Order VII r.1(a)–(i), r.3 and r.7, and Order VI rr.14–15 CPC for the plaint. Court heading, FIR particulars, the accused's particulars, the earlier-application statement, prayer, affidavit and the advocate's signature on a bail application are practice, not a provision, so their `source` is `null` and the web says "no rule source identified". `reference` (a corpus source id) is `null` everywhere for now: the corpus has no stable ids for these provisions yet.
- **The engine** (`linter/engine.py`) takes `(document_type, text)` and returns `LintOutcome(ruleset_id, ruleset_version, input_sha256, findings)`. Findings are sorted by span start, then end, then rule order; findings without a span come last in rule order (the contract's order). Offsets are converted from code points to UTF-16 code units. Text that is not valid UTF-8 (a lone surrogate from a JSON `\ud800` escape) is rejected as a 400 on `text`, since it has no UTF-8 bytes to hash.
- **The router** (`linter/router.py`) is its own `APIRouter` under `/ai/v1` with the service token, mounted with one `include_router` line in `main.py` (append-only, shared with Tracks P and D). Pydantic models use `extra="forbid"` and camelCase aliases. The rule sets endpoint serves the same rule objects the engine uses, without the patterns or message.
- **PyYAML becomes a runtime dependency** (it was dev-only), since the rule files are read at import.

Branch: `feature/214-linter-engine` off `staging`. PR title: `feat(ai): procedural linter engine and rule sets (FR-LINT-1, FR-LINT-2, FR-LINT-3)`.

## Changes

1. `services/ai/src/caseguard_ai/linter/`: `__init__.py`, `rules.py` (loading and validation), `engine.py`, `router.py`, `rules/bail_application.yaml`, `rules/plaint.yaml`.
2. `services/ai/src/caseguard_ai/main.py`: one import and one `include_router`.
3. `services/ai/pyproject.toml`, `uv.lock`: `pyyaml` in `dependencies`.
4. Tests: `tests/test_linter.py` (engine, rule files, endpoints against the contract), with complete fixtures in `tests/data/lint/`.
5. Docs: `services/ai/README.md` (a Linter section), `CHANGELOG.md`, `docs/engineering/work-log.md`, this plan.

## Verification

- `uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest` in `services/ai`, with `AI_TEST_DATABASE_URL` on this track's own database.
- The tests: a seeded defect for every rule produces exactly that rule's finding (FR-LINT-1); the complete documents produce no findings; every rule has a source or an explicit `null` (FR-LINT-2); the text and its hash are unchanged after linting and `inputSha256` matches the bytes sent (FR-LINT-3); two runs give identical output; both endpoints' responses validate against `ai.v1.yaml`, and bad requests are 400 problems.
- Push, open the PR against `staging`, wait for `ci-ok`. Merging needs the user's approval.
