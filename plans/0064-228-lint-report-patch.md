> **Status:** In progress · **Issue:** [#228](https://github.com/CaseGuard-AI/CaseGuard/issues/228) · **PR:** TBD

# #228: implement `PATCH /lint-reports/{reportId}` and use it for Save to case

Part of Phase 2 of plan `0052`. It needs the contract from #227 (plan `0063`), so the branch is stacked on `feature/227-lint-report-patch-contract`.

## Change

- **api**
  - `updateLintReport` in `apps/api/src/lint/store.ts` changes only `title` and `caseId`, and only on the owner's report.
  - The route `PATCH /lint-reports/:reportId` in `apps/api/src/routes/lint.ts`:
    - It parses the body with `updateBody` (strict, at least one field).
    - Another user's or an unknown report is a 404.
    - A `caseId` must pass `requireActiveCase(db, owner, caseId, "report")`, else 400 on `caseId`.
    - It returns the full `LintReport`.
- **web**
  - `useUpdateLintReport` in `apps/web/src/components/linter/queries.ts`.
  - `SaveToCase` in `linter-screen.tsx` sends one PATCH. The report keeps its id, and the linter isn't run again.

## Verification

- api, `test/lint.test.ts`:
  - 401 without a token.
  - Save in place: the report keeps its id, nothing else changes, and services/ai isn't called.
  - Detach with `null`, and rename with a trimmed title.
  - 400 for another user's, an unknown or an archived case, for an empty body, and for fields that can't change.
  - 404 for another user's, an unknown or a malformed report id.
- web, `test/linter.test.tsx`: Save to case sends one PATCH `{caseId}`, with no POST and no DELETE.
- Run `pnpm --filter ./apps/api run lint|typecheck|test` and `pnpm --filter ./apps/web run lint|typecheck|test|build`.
