> **Status:** In progress · **Issue:** [#213](https://github.com/CaseGuard-AI/CaseGuard/issues/213) · **PR:** [#221](https://github.com/CaseGuard-AI/CaseGuard/pull/221)

# #213: drafts with fill from case, assist and DOCX/PDF export (API)

## Context

The drafting contract is merged (#209, PR #216): api.v1 has `listDraftTemplates`, `listDrafts`, `createDraft`, `getDraft`, `updateDraft`, `deleteDraft`, `assistDraftSection` and `exportDraft`, and ai.v1 has `listDraftTemplates` and `draftSection` (#212). apps/api has no drafts yet. This is Track D's api layer in plan 0052. The api tests stub the ai client, so this PR doesn't wait for #212 to merge.

**Requirements:** FR-DRAFT-2, FR-DRAFT-4, FR-CASE-5, FR-DRAFT-3, FR-TRUST-10, FR-TRUST-12, FR-AUTH-3, FR-AUTH-4.

## Decisions

- **Migration `0014_drafts`** (with `.down.sql`): `app.drafts` (owner, account, case FK nullable and `set null` on delete, template id and version, title, fields jsonb, sections jsonb, version int, timestamps), indexed on `(owner_user_id, updated_at, id)` and `(case_id, updated_at)`. `app.draft_citations` (draft id cascading, citation id, `created_at`, primary key on both ids): the citations assist issued for each draft. `app.ai_audit_records` gains a nullable `draft_id` (no FK, like `case_id`, because the record is append-only).
- **Templates** come from services/ai and are cached in memory after the first success. A failure is 503 and is not cached.
- **`createDraft`** fills every field with a `caseField` from the case: list fields one line per entry; parties as `Name (Label)`, or the side when there is no label; dates as ISO. The title defaults to the template's title, then `: <case title>`. The case must be the caller's and active, else 400 on `caseId` (`requireActiveCase`).
- **`updateDraft`** locks on `version`: `UPDATE … WHERE id AND owner AND version = :v`, 409 when no row matched but the draft exists. Unknown field or section keys are 400 on their path; a missing section is saved empty. Every `[[c:uuid]]` marker must be in `draft_citations` for this draft, else 400 on `sections[i].body`. The template's version stays the one the draft was created from.
- **`getDraft`** and `updateDraft` return the citations whose markers appear in the sections, each read from ai `getCitation` at request time (there is no batch call). Statuses are never cached or stored with the draft (FR-TRUST-10). A failed lookup is 503.
- **`assistDraftSection`**: `requireAiEnabled` (403), the same `aiLimiter`, `enabledProviderIds` and `resolveCredential` as `askQuestion`, 503 when no provider is enabled. Scope: the public corpus and only the draft's case (FR-CASE-6). The section is checked against the template first (400). The returned citations are recorded in `draft_citations` and the audit record is written in one transaction (`outcome: answered`, the instruction as the query, the template and section named, `draft_id`); a failure is audited as `error` and is 503. An ai 400 is passed on as 400. Nothing is saved into the draft.
- **`GET /citations/{id}`** now also allows a citation issued to one of the user's drafts, so the web's trust details work for drafts as they do for answers (FR-TRUST-10, FR-AUTH-4).
- **`exportDraft`** renders the saved draft: DOCX with `docx` and PDF with `pdfkit` (new dependencies, `^` ranges like the rest). The title, then each section with its template heading. Each marker becomes a footnote (DOCX) or a numbered note in a "Citations" list at the end (PDF), with the source title, locator, the stored status and the last-verified date at export. Sent with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`.
- **Owner only:** another user's draft is a 404 everywhere. `listDrafts?caseId` of a case that isn't the caller's is an empty page.

Branch: `feature/213-drafts-api` off `staging`. PR title: `feat(api): drafts with fill from case, assist and DOCX/PDF export (FR-DRAFT-2, FR-DRAFT-4, FR-CASE-5)`.

## Changes

1. `apps/api/src/db/schema.ts`, `drizzle/0014_drafts.sql` (+ `.down.sql`, snapshot, journal).
2. `apps/api/src/drafts/`: `store.ts` (CRUD, optimistic save, `draft_citations`, audit), `fill.ts` (fields from the case), `markers.ts`, `export.ts` (DOCX and PDF).
3. `apps/api/src/routes/drafts.ts`, mounted in `app.ts`.
4. `apps/api/src/clients/ai.ts`, `ai-schemas.ts`: `listDraftTemplates`, `draftSection` and their schemas.
5. `apps/api/src/routes/sources.ts`: `GET /citations/{id}` also accepts a citation in the caller's `draft_citations` (`userHasDraftCitation`). `cases/store.ts`: `requireActiveCase` names what is being saved.
6. Tests: `test/drafts.test.ts` (every route with `expectContract`), `test/drafts-unit.test.ts` (fill, markers, export), `test/migrations.test.ts`, `test/stubs.ts` (`noIngestion` also stubs the two drafting methods, so every other test file is unchanged).
7. `apps/api/package.json`, `pnpm-lock.yaml`, `apps/api/README.md`, `CHANGELOG.md`, `docs/engineering/work-log.md`, this plan.

## Verification

- `pnpm --filter ./apps/api run lint`, `typecheck` and `test`, with `APP_TEST_DATABASE_URL` on Track D's own database.
- Push, open the PR against `staging`, wait for `ci-ok`. The integrator merges after the user approves.
