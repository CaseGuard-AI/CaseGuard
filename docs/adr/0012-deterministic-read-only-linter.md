# ADR-0012: The procedural linter is deterministic, rule-file driven and read-only

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Stream A (apps/api, apps/web), Stream C (services/ai)
- **PRD refs:** FR-LINT-1, FR-LINT-2, FR-LINT-3, FR-CASE-5

## Context
The linter checks a bail application (s.497/498 CrPC) and a plaint (Order VII CPC) for required sections, required particulars and structure (FR-LINT-1). Each finding must cite its rule source or say none was identified (FR-LINT-2), and the document must be byte-identical after linting (FR-LINT-3). The acceptance test is that seeded-defect documents produce the matching findings, which needs repeatable output.

## Decision
- **Rules are data.** One YAML rule set per document type in `services/ai` (`linter/rules/*.yaml`), versioned. Each rule has an id, a kind (`missing_section`, `missing_particular`, `structure`), a severity, detection patterns, and a `source` (provision and optional corpus reference) or `null`. The rule sets are served by `GET /ai/v1/lint/rulesets`, so the UI shows the same sources the engine uses.
- **The engine is pure.** It takes the text and returns findings: no database, no model provider, no writes. The same text and rule-set version always give the same findings.
- **Read-only by contract.** `lintDocument` returns `inputSha256` of the text's UTF-8 bytes as received, and apps/api stores the report with the text exactly as sent. Spans are UTF-16 offsets into that text, so the web highlights without changing it.
- **Reports live in apps/api.** `app.lint_reports` (ADR-0002: user data in `app`), optionally saved to a case (FR-CASE-5) or linked to the draft the text came from.

## Alternatives considered
| Option | Why not |
|---|---|
| LLM review of the document | Not repeatable, so the seeded-defect test can't pass reliably; sends a client's filing to a provider; can't cite a rule source it didn't come from. A model-assisted layer can be added later, behind the deterministic one (cf. FR-TRUST-9). |
| Rules in TypeScript in apps/api | The PRD places drafting/linter AI in services/ai (§14.1); keeping rules there lets a later model-assisted pass and the drafting templates share them. |
| Auto-fix suggestions applied to the text | Breaks FR-LINT-3. |

## Consequences
- Pattern rules miss unusual phrasings; findings are worded as "could not find", and the rule sets are refined against real filings.
- A rule-set change bumps its `version`, which is stored with every report.
