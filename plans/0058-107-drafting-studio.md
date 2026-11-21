> **Status:** Done · **Issue:** [#107](https://github.com/CaseGuard-AI/CaseGuard/issues/107) · **PR:** [#225](https://github.com/CaseGuard-AI/CaseGuard/pull/225)

# #107: drafting studio (web)

## Context

`/drafting` still shows `ComingSoon`. The drafting contract is merged (#209, PR #216), and the api (#213) and ai (#212) layers are in review. This is Track D's web layer in plan 0052. The tests mock `fetch`, so this PR doesn't wait for the api to merge.

**Requirements:** FR-DRAFT-1, FR-DRAFT-2, FR-DRAFT-3, FR-DRAFT-4, FR-TRUST-10, FR-CASE-4, FR-CASE-5.

## Decisions

- **`/drafting`** shows the drafts list (template, case and last update, newest first, paged) and a "New draft" form. The form has a template picker (radio cards with each template's description), an optional case picker and an optional title. `?case=<id>` preselects the case, so the case dashboard can link straight in. Creating a draft opens its editor.
- **Case picker reuse.** The `<select>` of active cases moves out of `CasePicker` into `CaseSelect` in `components/research/case-picker.tsx`. Research's `CasePicker` keeps the same behaviour on top of it, and drafting uses the same control.
- **`/drafting/[draftId]`** is the editor:
  - the title, the case and the fields form, in template order;
  - one plain `<textarea>` per section, in template order, each with its heading, guidance and a "required" mark (no rich-text library);
  - the citations whose markers are in a section, shown under it as the research `CitationChip`s with `LastVerified` and `FlagChips` (FR-TRUST-10). Clicking a chip opens the research `SourcePanel`.
- **Assist** is a button on each assistable section, with an optional instruction:
  - the suggestion is rendered with `parseAnswer` from `research/markers.ts` and `CitationChip`, so statuses look exactly as they do in research;
  - "Insert" appends the suggestion to the section, and "Replace" swaps it in. Nothing is saved until Save;
  - a 403, 429 or 503 is explained in words.
- **Save** sends `version`. A 409 shows "saved somewhere else" with a Reload button that loads the saved version and discards local edits. Leaving with unsaved edits isn't blocked; the Save button shows the dirty state.
- **Export** DOCX and PDF downloads go through the API with the bearer token, as a blob, like document downloads.
- **Delete** asks for confirmation first, then returns to `/drafting`.
- **Dynamic route.** The page passes `draftId` from `params`, as `/cases/[caseId]` does. The new-draft form reads `?case=`, so it sits inside Suspense. `next build` is run.
- **Case dashboard.** Only the Drafts card changes: it lists the case's drafts and has a "New draft" link (`/drafting?case=<id>`, hidden for an archived case). FR-CASE-4.
- **Strings** go under `Drafting` in en and ur. The Urdu awaits native review (#105).

Branch: `feature/107-drafting-studio` off `staging`. PR title: `feat(web): drafting studio (FR-DRAFT-1, FR-DRAFT-2, FR-DRAFT-3, FR-DRAFT-4)`.

## Changes

1. `apps/web/src/components/drafting/`: `queries.ts`, `drafts-list.tsx`, `new-draft.tsx`, `draft-editor.tsx`, `assist-panel.tsx`, `section-citations.tsx`, `case-drafts.tsx`.
2. `apps/web/src/app/[locale]/(app)/drafting/page.tsx` and `drafting/[draftId]/page.tsx`.
3. `apps/web/src/components/research/case-picker.tsx`: `CaseSelect`.
4. `apps/web/src/components/cases/case-dashboard.tsx`: the Drafts card.
5. `apps/web/messages/en.json`, `ur.json`: `Drafting`.
6. `apps/web/test/drafting.test.tsx`.
7. `CHANGELOG.md`, `docs/engineering/work-log.md`, this plan.

## Verification

- `pnpm --filter ./apps/web run lint`, `typecheck`, `test` and `build`.
- Push, open the PR against `staging`, wait for `ci-ok`. The integrator merges after the user approves.
