> **Status:** In progress · **Issue:** [#226](https://github.com/CaseGuard-AI/CaseGuard/issues/226) · **PR:** TBD

# #226: lint report `draftId` must be the caller's draft

Part of Phase 2 (integration) of plan `0052`. The other Phase 2 PRs are #227 (contract, `PATCH /lint-reports/{id}`), #228 (implement it and use it for Save to case) and #229 ("Lint this draft" in the drafting studio, and marking A12 done).

## Context

`createLintReport` in api.v1 already says `draftId` "must be the caller's, else 400 with `errors[].path` of `draftId`". #215 (plan `0060`) only checked it was a uuid, because `app.drafts` hadn't merged yet. `app.drafts` now exists (migration 0014), so the check and an FK can go in.

## Change

- `apps/api/src/routes/lint.ts`: when `draftId` is set, `findOwnDraft` (`apps/api/src/drafts/store.ts`) must return the draft. If it doesn't, answer 400 with `errors: [{path: "draftId", message: "No such draft"}]` before services/ai is called. Another user's draft gets the same answer as a missing one (FR-AUTH-4).
- Migration `0016_lint_reports_draft_fk`:
  - Clear any `draft_id` that points at no draft. The check didn't exist before, so such rows can be there.
  - Add `lint_reports.draft_id → app.drafts(id) on delete set null`. Deleting a draft keeps its lint reports.
  - The hand-written `.down.sql` drops the constraint.
- Schema comment and FK in `apps/api/src/db/schema.ts`.

## Verification

- `test/lint.test.ts`:
  - Alice's own draft gives 201.
  - Bob's draft or an unknown id gives 400 on `draftId`, without calling services/ai and without storing anything.
  - Deleting the draft leaves the report in place with `draftId: null`.
- `test/migrations.test.ts`: 0016 is part of the up and down chains.
- `pnpm --filter ./apps/api run lint|typecheck|test`, run against the Docker DB on port 5433.
