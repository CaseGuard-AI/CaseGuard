> **Status:** In progress · **Issue:** [#99](https://github.com/CaseGuard-AI/CaseGuard/issues/99) · **PR:** —

# #99: Cases list and case dashboard (web)

## Context

#97 (PR #194) put cases into api.v1 and #98 (PR #195) implemented them in `apps/api`: `listCases` (`state` active|archived|all, cursor), `createCase`, `getCase`, `updateCase` (partial), `archiveCase` / `unarchiveCase`, `listConversations?caseId=`, `createConversation {caseId}` and `updateConversation {caseId | null}`. The web app still shows `ComingSoon` on `/cases`, and the Research Hub can't ask within a case or save a conversation to one.

This is the last step of roadmap item A7 (contract → API → **web**). It runs in parallel with #100 (documents contract) and #104 (dashboard), so it stays inside `components/cases/`, the `/cases` routes, `components/research/` and a new `Cases` namespace in `messages/*.json`. It does not create `components/dashboard/` or touch `app/[locale]/(app)/page.tsx` (#104's).

**Requirements:** FR-CASE-1, FR-CASE-4, FR-CASE-5, FR-CASE-6 (asking in a case), FR-AUTH-4.

## Decisions

- **Queries in `components/cases/queries.ts`**, modelled on `components/research/queries.ts`: `useCases(state)` (infinite, 20 a page), `useCase(id)` (404 or 400 → no retry), `useCreateCase`, `useUpdateCase`, `useArchiveCase` (archive or unarchive), `useCaseConversations(caseId)` (infinite). Keys all start with `casesKey = ["cases"]`, and every mutation invalidates it, so the list, the dashboard and the case's research stay in step. `Case`, `CaseInput`, `CaseUpdate`, `Party` are exported from `Schemas`.
- **Forms are routes, not a sheet**: `/cases/new` and `/cases/[caseId]/edit`. A route can be linked to and reloaded, and the settings page's pattern (a card with a heading per section) fits a long form better than a drawer. The same `CaseForm` serves both.
- **Client validation mirrors the contract's bounds** (title 1–200, court 120, case number 80, case type 80, status 80, judge 200, assigned lawyer 120, summary 4000, ≤ 50 parties with name 1–200 and label ≤ 40, ≤ 50 laws of 1–120). A 400's `errors[].path` (`title`, `parties.0.name`, `relevantLaws.2`) is shown at that field; a path the form doesn't know goes in the form's alert.
- **Edit sends only what changed** (`PATCH` partial): a cleared text or date is `null`, an emptied list is `[]`. With nothing changed, Save is disabled.
- **The dashboard** `/cases/[caseId]`: a header with the title, status and archived state, Edit, Archive (behind an `AlertDialog`) or Unarchive, and "Ask in this case" → `/research?case=<id>` (hidden for an archived case, which the API refuses). Then the case details (Table 4.29 fields, parties in two columns by side, relevant laws), the case's research from `listConversations?caseId=` linking to `/research?c=<id>`, and placeholder sections for Documents, Drafts and Precedents that say when they arrive. No fake data.
- **A missing case is an inline "not found" inside the shell**, with a link back to `/cases`, rather than `notFound()`: the locale's `not-found.tsx` is outside the app shell, and a 404 here only means "not yours or gone" (FR-AUTH-4).
- **Asking in a case (FR-CASE-5, FR-CASE-6)**: `useAsk`'s mutation takes an optional `caseId` and sends it on `createConversation`. `ResearchHub` reads `?case=` for a new conversation and shows a chip with the case title and a way to ask without it. An open conversation gets a "Saved to case" select (active cases, plus its current case if archived) calling `updateConversation`; "Not saved to a case" detaches. Both update the conversation in the cache and invalidate the history and the cases keys.
- **Strings**: one new top-level `Cases` namespace in `messages/en.json` and `messages/ur.json`, appended at the end, including the Research Hub's case chip and select (`Cases.research.*`), so the existing `Research` block is untouched. Urdu awaits native review (#105).

Branch: `feature/99-cases-web` off `origin/staging`. PR title: `feat(web): cases list and case dashboard (FR-CASE-1, FR-CASE-4, FR-CASE-5)`.

## Changes

1. **`apps/web/src/components/cases/queries.ts`** (new): the hooks and types above.
2. **`apps/web/src/components/cases/cases-list.tsx`** (new): Active / Archived tabs (`components/ui/tabs.tsx`); rows with title, case number, court, next hearing and relative updated time, linking to `/cases/<id>`; load more; loading, error with retry, and empty states as in `history-list.tsx`.
3. **`apps/web/src/components/cases/case-form.tsx`** (new): create and edit, parties and laws as add/remove lists, validation and 400 mapping, changed-fields PATCH.
4. **`apps/web/src/components/cases/case-dashboard.tsx`** (new) and **`case-edit.tsx`** (new, loads the case for the form).
5. **Routes**: `app/[locale]/(app)/cases/page.tsx` (replaces `ComingSoon`), `cases/new/page.tsx`, `cases/[caseId]/page.tsx`, `cases/[caseId]/edit/page.tsx`.
6. **`apps/web/src/components/research/`**: `queries.ts` (`useAsk` takes `caseId`; new `useSaveToCase`), `research-hub.tsx` (reads `?case=`, renders the chip or the select), new `case-picker.tsx`. A `?case=` that turns out archived or missing says so, and the question is asked without a case rather than failing with the API's 400.
7. **`apps/web/messages/en.json`, `ur.json`**: the `Cases` namespace, appended.
8. **Tests**: `apps/web/test/cases.test.tsx` (list, form, dashboard) and `research-case.test.tsx`, patterned on `research-history.test.tsx`. The two existing Research Hub tests mock `Link` too, since the hub now renders case links.
9. **Docs**: `CHANGELOG.md` Unreleased → Added; a heading in `docs/engineering/work-log.md`; A7 moves to Done in `docs/engineering/stream-a-roadmap.md`; this plan.

## Verification

- `pnpm --filter ./apps/web run lint`, `typecheck`, `test` (the i18n key-parity test included).
- Tests cover: list states and tabs (the `state` query sent), load more; create with client validation and a 400 mapped to its field; edit sends only changed fields with `null` for a cleared one; archive behind the confirm; the dashboard's research list and links, the archived banner, not found; asking with `?case=` sends `caseId`, and the select saves and detaches a conversation.
- After the join, on staging with `pnpm dev`: create a case → ask in it → the conversation shows on the case dashboard → archive the case and it leaves the active list → the Urdu locale shows the new strings.
