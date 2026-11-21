> **Status:** In progress · **Issue:** [#108](https://github.com/CaseGuard-AI/CaseGuard/issues/108) · **PR:** pending

# #108: the procedural linter screen (web)

## Context

`/linter` still shows `ComingSoon`. The linter contract is merged (#209, PR #216). services/ai has the engine (#214, PR #217) and apps/api has the lint reports (#215, PR #222). The web is built against the contract with fetch stubbed, like #102, so it doesn't wait for either PR to merge.

This is the third step of Track L in [plan 0052](0052-209-precedents-drafting-linter-contract.md).

**Requirements:** FR-LINT-1, FR-LINT-2, FR-LINT-3, FR-CASE-4, FR-CASE-5.

## Decisions

- **`/linter`** replaces `ComingSoon` with the screen, which has:
  - a document-type picker (bail application or plaint);
  - a text area plus a `.txt` file loader. The file is read in the browser with `File.text()`, never uploaded as a file. Only `.txt` or `text/plain` is accepted, up to 200,000 characters;
  - a **Lint** button.

  Linting is `POST /lint-reports`, the only lint operation in api.v1, so every lint is kept as a report and appears in **Past reports**, where it can be opened again or deleted.
- **Findings** are grouped by kind (missing sections, missing particulars, structure), then sorted by severity within each group (error, warning, info). Each finding shows:
  - its severity;
  - its message, which is in English as the contract says, shown `dir="ltr"`;
  - its rule's title, from `GET /lint/rulesets`;
  - a source chip with the provision, or "No rule source identified" when `source` is null (FR-LINT-2).

  A summary counts each severity, and a clean report says no problems were found.
- **Spans.** A finding with a span is a button. Clicking it highlights `[start, end)` in a read-only view of the text and scrolls it into view. The offsets are UTF-16, so the text is sliced directly with `String.slice`. The view renders the stored text exactly, with `whitespace-pre-wrap`, and never edits it (FR-LINT-3). A finding without a span says it concerns the whole document.
- **Save to case** reuses the case select from `components/research/case-picker.tsx`. The picker's `<select>` is extracted into an exported `CaseSelect`, and `CasePicker` keeps its markup and behaviour.
  - The case is chosen before linting, so the report is created in that case.
  - For a report that isn't in a case yet, "Save to case" creates the same text as a report in the chosen case and deletes the unsaved one. api.v1 has no operation to move a report into a case.
  - `?case=<id>` preselects a case (the dashboard's "Lint a document" link).
  - `?report=<id>` opens a past report (the dashboard links).
  - Reading the URL means the screen sits inside `Suspense` (`cacheComponents`).
- **Case dashboard:** a Lint reports card goes next to Documents. It lists the case's reports with their counts, each linking to `/linter?report=<id>`, plus "Lint a document". Nothing else on the dashboard changes.
- **Errors in words:** 400 on `caseId` (the case is archived or gone), 429, 503 (the linter is unavailable) and network failures.
- **Strings** go under `Linter` in en and ur. The Urdu awaits native review (#105).

Branch: `feature/108-linter-screen` off `staging`. PR title: `feat(web): procedural linter screen (FR-LINT-1, FR-LINT-2)`.

## Changes

1. `apps/web/src/components/linter/`:
   - `queries.ts`
   - `linter-screen.tsx`
   - `findings.tsx`
   - `text-view.tsx`
   - `past-reports.tsx`
   - `case-lint-reports.tsx`
2. `apps/web/src/app/[locale]/(app)/linter/page.tsx`.
3. `apps/web/src/components/research/case-picker.tsx`: `CaseSelect` extracted.
4. `apps/web/src/components/cases/case-dashboard.tsx`: one card added.
5. `apps/web/messages/en.json` and `ur.json`: the `Linter` strings.
6. Tests: `apps/web/test/linter.test.tsx`.
7. Docs: `CHANGELOG.md`, `docs/engineering/work-log.md`, this plan.

## Verification

- `pnpm --filter ./apps/web run lint`, `typecheck`, `test` and `build`.
- Push, open the PR against `staging`, wait for `ci-ok`. Merging needs the user's approval.
