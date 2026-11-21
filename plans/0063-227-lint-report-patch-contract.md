> **Status:** Done · **Issue:** [#227](https://github.com/CaseGuard-AI/CaseGuard/issues/227) · **PR:** [#231](https://github.com/CaseGuard-AI/CaseGuard/pull/231)

# #227: contract for `PATCH /lint-reports/{reportId}`

Part of Phase 2 of plan `0052`. #228 implements it.

## Context

api.v1 has no way to save an existing lint report to a case. The linter screen (#108, PR #224) works around this: it creates the report again inside the case, then deletes the old one. That gives the report a new id and runs the linter a second time. A contract change goes in its own PR (PRD §14.2).

## Change (additive, version stays `1.0.0-draft`)

- New operation `updateLintReport`, `PATCH /lint-reports/{reportId}`.
  - Body: `LintReportUpdate {title?, caseId?: uuid|null}`, with `minProperties: 1` and `additionalProperties: false`.
  - Responses:
    - 200: the `LintReport`.
    - 400: invalid values, or a case that isn't the caller's or isn't active (`errors[].path = caseId`).
    - 404: another user's report (FR-AUTH-4).
  - The text, findings and hash never change (FR-LINT-3).
- `LintReportUpdate` is modelled on `ConversationUpdate`.
- `generated/api.v1.ts` is regenerated with `pnpm gen:contracts`.
- The README mentions the new operation.

## Verification

- `npx @redocly/cli lint packages/contracts/openapi/*.yaml` is clean.
- `pnpm gen:contracts` produces no diff.
