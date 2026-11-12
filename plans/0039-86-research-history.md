> **Status:** Done · **Issue:** [#86](https://github.com/CaseGuard-AI/CaseGuard/issues/86)

# #86: research history sidebar (FR-RES-8)

## Context

`GET /conversations` (newest first, cursor-paged) and the Research Hub's `?c=` routing already existed, but nothing in the web app listed past conversations, so a user could not get back to an earlier thread. This adds the history list from `docs/engineering/handoff-res8-set2-res11.md` §1. It touches `apps/web` only. "Save to case", the other half of FR-RES-8, waits for Cases (#97–#99).

## Decisions

- **Data.** `useConversations()` in `components/research/queries.ts` is a `useInfiniteQuery` under `historyKey = ["conversations"]`, 20 per page, that follows `nextCursor`. `useAsk`'s `onSuccess` invalidates it, so a new conversation (or one that just moved up) shows at the top without a reload.
- **The URL stays the only state.** Clicking an item does `router.replace("/research?c=<id>")` and "New question" does `router.replace("/research")`. The hub already loads whatever `?c=` names, and the item for it gets `aria-current="page"`.
- **Layout.** On `lg:` the hub is a two-column grid with the history at the start side (`border-e`, `pe-6`). Below `lg:` a "History" button opens the same list in a `Sheet` with `side="start"`, which closes after a choice. Only logical properties are used, so Urdu mirrors it (the RTL class test covers the new files).
- **Dates.** Each item shows `updatedAt` as a relative time (`useFormatter().relativeTime`, with `useNow` ticking each minute). The title uses `dir="auto"`, since titles are the user's first question in either language.
- **States.** Loading (`aria-busy`), empty, and error with a retry. The error is not a `role="alert"`, so it never competes with the ask box's alert.
- **Strings** are under `Research.history` in `en.json` and `ur.json`: `title`, `open`, `newQuestion`, `loading`, `empty`, `error`, `retry`, `loadMore`. The Urdu needs native review (#105).

## Files

- New:
  - `apps/web/src/components/research/history-list.tsx`
  - `apps/web/test/research-history.test.tsx`
- Edited:
  - `apps/web/src/components/research/queries.ts`, `research-hub.tsx`
  - `apps/web/messages/en.json`, `ur.json`
  - `apps/web/test/research-hub.test.tsx` (the fetch mock answers `GET /conversations` with an empty list, and the call-order checks look at POSTs only)
  - `apps/web/vitest.config.ts`: `testTimeout` 15 s → 30 s. With a 17th heavy test file, the cold first import in several files (including untouched ones such as `password-reset`) reached 15–17 s under parallel workers. The baseline of 16 files passed at 15 s.
  - docs: CHANGELOG, work log

## Verification

- `research-history.test.tsx` (9 tests) covers:
  - newest first, with the relative date and the page size;
  - the active item marked from `?c=`;
  - clicking an item switches `?c=` and loads that thread;
  - "Load more" sends the cursor and then disappears;
  - after a new question the history refetches and the new conversation is on top;
  - "New question" clears `?c=`;
  - the empty and error states, with retry;
  - the mobile drawer opening and closing after a choice.
- The existing `research-hub.test.tsx` still passes.
- `pnpm --filter ./apps/web lint`, `typecheck` and `test`, and `pnpm -r lint`, all pass.
