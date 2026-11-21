> **Status:** In progress · **Issue:** [#215](https://github.com/CaseGuard-AI/CaseGuard/issues/215) · **PR:** pending

# #215: lint reports (API)

## Context

The linter contract is merged (#209, PR #216): api.v1 has `listLintRulesets` (`GET /lint/rulesets`), `createLintReport` and `listLintReports` (`POST`/`GET /lint-reports`), and `getLintReport` and `deleteLintReport` (`GET`/`DELETE /lint-reports/{reportId}`). services/ai serves the engine behind `GET /ai/v1/lint/rulesets` and `POST /ai/v1/lint` (#214, plan `0059`). [ADR-0012](../docs/adr/0012-deterministic-read-only-linter.md) puts the reports in apps/api, in the `app` schema (ADR-0002), with the text stored exactly as sent.

This is the second step of Track L in [plan 0052](0052-209-precedents-drafting-linter-contract.md) (ai #214 → **api** → web #108).

**Requirements:** FR-LINT-1, FR-LINT-3, FR-CASE-5, FR-AUTH-4.

## Decisions

- **Migration `0015_lint_reports`** (number reserved in plan 0052; `0014` is Track D's drafts). `app.lint_reports`: `owner_user_id` and `account_id` (FKs, cascade), `case_id` (nullable FK to `app.cases`, cascade, like documents), `draft_id` (nullable plain `uuid`, **no FK**: `app.drafts` belongs to Track D and isn't on staging), `document_type` (checked `bail_application | plaint`), `title`, `text`, `input_sha256` (checked 64 lowercase hex), `ruleset_id`, `ruleset_version`, `findings` jsonb, `created_at`. Indexes on `(owner_user_id, created_at, id)` and `(case_id, created_at, id)`. Hand-written `.down.sql`.
- **Create:** the body is a strict zod object matching `LintReportCreate`. With `caseId`, the case must be the caller's and active (`requireActiveCase`, a 400 on `caseId`), checked before services/ai is called. `draftId` is only checked as a uuid and recorded; checking that it is the caller's draft waits for Track D's table (follow-up, see below). Then services/ai lints the text; its `inputSha256` is compared with apps/api's own SHA-256 of the same UTF-8 bytes, and a mismatch is a 503 (the text would not be the one linted). The report is stored with the text as sent and returned as 201. The title defaults to "Bail application, 2026-11-21" or "Plaint, 2026-11-21".
- **The text is never logged or audited.** No model provider is called, so no `ai_audit_records` row (that table records data sent to providers, SEC-8) and the route works when AI features are disabled.
- **List:** newest first, cursor paged like notifications; `?caseId=` filters to that case, and a case that isn't the caller's gives an empty page (the contract). Summaries carry `findingCounts` by severity, counted from the stored findings.
- **Owner only:** another user's report is a 404 on get and delete (FR-AUTH-4). Delete is a hard delete (204).
- **`GET /lint/rulesets`** passes services/ai's rule sets through after a zod check; services/ai down is a 503.
- **ai client:** `listLintRulesets()` and `lint(req)` in `clients/ai.ts`; `lintRulesetListSchema` and `lintResultSchema` in `ai-schemas.ts`. Findings are checked strictly enough to store (ids, enums, span bounds within the text, message length), since they reach the user.
- **Rate limit:** 60 lint reports per user per 15 minutes (the contract's 429), like uploads.

Branch: `feature/215-lint-reports-api` off `staging`. PR title: `feat(api): lint reports (FR-LINT-1, FR-CASE-5)`.

## Changes

1. `apps/api/src/db/schema.ts`, `drizzle/0015_lint_reports.sql` (+ `.down.sql`, snapshot, journal).
2. `apps/api/src/lint/store.ts`: insert, list, find own, delete.
3. `apps/api/src/routes/lint.ts`, mounted with one line in `app.ts`; `lintLimiter` in `middleware/rate-limit.ts`.
4. `apps/api/src/clients/ai.ts`, `ai-schemas.ts`: the lint types, methods and schemas.
5. Tests: `test/lint.test.ts` (every route with `expectContract`, owner checks, case rule, sha check, ai down), `test/stubs.ts` (lint stubs for the other test files), `test/migrations.test.ts`.
6. Docs: `apps/api/README.md`, `CHANGELOG.md`, `docs/engineering/work-log.md`, this plan.

## Verification

- `pnpm --filter ./apps/api run lint`, `typecheck` and `test`, with `APP_TEST_DATABASE_URL` on this track's own bootstrapped database.
- Push, open the PR against `staging`, wait for `ci-ok`. Merging needs the user's approval.

## Follow-ups

- **`draftId` ownership.** The contract says a `draftId` that isn't the caller's is a 400 on `draftId`. Until Track D's `app.drafts` is on staging, apps/api only checks the format. Once it merges: check ownership in the create route and consider an FK with `on delete set null`.
- **Migration order.** If Track D's `0014_drafts` merges first, this branch rebases and regenerates `meta/_journal.json` and `0015_snapshot.json` so the snapshot's `prevId` follows `0014`.
