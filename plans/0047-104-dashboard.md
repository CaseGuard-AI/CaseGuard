> **Status:** Done · **Issue:** [#104](https://github.com/CaseGuard-AI/CaseGuard/issues/104) · **PR:** [#196](https://github.com/CaseGuard-AI/CaseGuard/pull/196)

# #104: dashboard with recent research and cases

## Context

FR-DASH-1 asks for a dashboard that shows the user's recent research, cases and drafts, with a quick way to ask. `/` (`apps/web/src/app/[locale]/(app)/page.tsx`) is still the shell placeholder: a disabled textarea, "Research is being built", the three `TrustBadge`s and the `ApiStatus` dev aid. This is item A10 of [`docs/engineering/stream-a-roadmap.md`](../docs/engineering/stream-a-roadmap.md). Its blockers are merged: the research history (#86, `GET /conversations` and `useConversations`) and the cases API (#98, `GET /cases`).

This issue runs in parallel with #99 (cases web) and #100 (documents contract). #99 owns `components/cases/`, `components/research/research-hub.tsx` and the `/cases` routes, so this PR stays out of them.

**Requirements:** FR-DASH-1 (and FR-AUTH-4: only the caller's own items, which the API already enforces).

## Decisions

- **One client component, `components/dashboard/dashboard.tsx`,** under the page's existing `PageIntro`. The page stays a server component.
- **Quick ask is a "Start research" link to `/research`**, not a live ask box. Prefilling a question would mean reading a new query parameter in `research-hub.tsx`, which #99 is changing; it can follow after the join.
- **Recent research reuses `useConversations`** from `components/research/queries.ts` (read-only use, same query key, so the Research Hub's history is already warm). It shows the first 5 items of the first page, with the relative time `history-list.tsx` uses. Rows link to `/research?c=<id>`; "See all" goes to `/research`.
- **Recent cases use a local `useRecentCases()`** in `components/dashboard/queries.ts`: `GET /cases?limit=5` (active cases, most recently updated first). It is not a `components/cases/` module, which is #99's. At the join it kept its own query (it fetches 5, `useCases` pages 20) but moved under #99's `casesKey`, so case changes refresh it. Rows link to `/cases/<id>` and show the case number, court and next hearing date when set; "See all" goes to `/cases`.
- **Each section has its own loading, error (with retry) and empty state**, so one failing request doesn't blank the page.
- **The `Home.*` strings go**, since nothing else uses them. `TrustBadge` stays (the Research Hub uses it). `ApiStatus` is only removed from the page; the component file stays as a dev aid.
- **i18n:** a new top-level `Dashboard` namespace appended to `messages/en.json` and `messages/ur.json`; no other keys move.

## Changes

1. **`apps/web/src/app/[locale]/(app)/page.tsx`**: `PageIntro` plus `<Dashboard />`; the textarea, badges and `ApiStatus` go.
2. **`apps/web/src/components/dashboard/queries.ts`**: `useRecentCases()` and `recentCasesKey`.
3. **`apps/web/src/components/dashboard/dashboard.tsx`**: the quick-ask card, Recent research and Recent cases.
4. **`apps/web/messages/en.json`, `ur.json`**: `Dashboard.*` appended, `Home.*` removed.
5. **`apps/web/test/dashboard.test.tsx`**: both lists render with their links and the `limit` sent, at most 5 research items, empty and error states with retry, the next hearing date.
6. **`docs/engineering/stream-a-roadmap.md`**: A10 moves to Done, noting drafts wait for their contract. **`docs/engineering/work-log.md`**, **`CHANGELOG.md`**: an entry each.
7. This plan.

## Left for later

- **Drafts** on the dashboard: no drafts contract yet (A12, FR-DRAFT-*). A section is added when it exists.
- **Prefilled quick ask** (`/research?q=…`), after #99 merges and `research-hub.tsx` is free.
- The new Urdu strings need native review (#105).

## Verification

- `pnpm --filter ./apps/web run lint`, `typecheck` and `test` pass (including the en/ur key-parity test).
- After the join, with `pnpm dev`: `/` lists the latest conversations and active cases, each link opens the right page, and the Urdu locale shows the new strings.
- CI `ci-ok` is green.
