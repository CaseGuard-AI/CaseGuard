> **Status:** In progress · **Issue:** [#14](https://github.com/CaseGuard-AI/CaseGuard/issues/14) · **PR:** [#87](https://github.com/CaseGuard-AI/CaseGuard/pull/87)

# #14: Research Hub, the answer view with citations, trust badges and a source panel (web)

## Context

#14 replaces the `ComingSoon` placeholder at `/research` with the prototype's Research Hub, built on `api.v1`. The parts are an ask box, an answer whose `[[c:id]]` markers become citation chips, a `TrustBadge` and flags for each citation, and a source panel with the verbatim quote and the official URL. The page shows only the stored status and never works one out itself.

What already exists:
- The shell and `PageIntro` (#11).
- `TrustBadge`, which takes the `verified | needs_review | unverified` status.
- The logical-side `Sheet` (`side="end"`).
- The typed `api` client, which adds the bearer token (#79, #12).
- TanStack Query, in `Providers`.

How the API behaves (`apps/api/src/routes/conversations.ts`, `citations.ts`; plans 0013, 0014):
- **Start:** `POST /conversations` gives 201 with a `Conversation`.
- **Ask:** `POST /conversations/{id}/messages` with `{ question, language? }` gives 201 with the assistant `Message`.
  - The message holds `text` with `[[c:<uuid>]]` markers, plus `language`, `answerable` and `citations[]`. Each citation has `claim`, `locator`, `quote`, `quoteLanguage` and the stored `verification`.
  - It answers only once every citation has a stored verification (FR-RES-6).
  - Errors:
    - **403:** AI is turned off for this user, which is the default for a new user (FR-AUTH-3).
    - **429:** more than 30 questions per 15 minutes.
    - **503:** the AI service or a model provider is down.
    - **404:** the conversation doesn't exist or isn't this user's.
    - **400:** a validation failure.
  - It can take up to 120 s.
- **Reload:** `GET /conversations/{id}` returns the conversation with all its messages, oldest first.
- **Citation:** `GET /citations/{id}` returns the citation with its **current** stored verification, which can be newer than the copy saved on the message (FR-TRUST-5, FR-TRUST-10).
- **Source:** `GET /sources/{id}` returns the source: `kind`, `title`, `citation`, `court`, `decidedOn`, `officialUrl`, `sourceTier`, `thirdParty`, `headnoteOnly`, `language` and a verbatim `excerpt`.
- **Today:** `services/ai` has no `research/answer`, citations or sources yet (#20). So in the real stack every question gets 503, and every citation or source lookup gets 503 or 404.

**Requirements:** FR-RES-5, FR-RES-7, FR-RES-10, FR-TRUST-5, FR-TRUST-10, plus FR-RES-9 (the unanswerable state) and FR-AUTH-3 (AI turned off).

**Decisions (owner):**
- **Build now against the contract, without waiting for #20.**
  - Unit tests stub `fetch` with responses shaped by the contract.
  - The browser check runs the real web app on `pnpm stack:up`, with one exception: Playwright's `page.route` intercepts `POST …/messages`, `GET /citations/*` and `GET /sources/*` and serves fixtures shaped by the contract.
  - The real 403 (AI off) and 503 (no `research/answer`) come from the live API.
- **No list of past conversations.** It's left out of this PR, with a follow-up issue, [#86](https://github.com/CaseGuard-AI/CaseGuard/issues/86). The current conversation is kept in the URL as `?c=<id>`, so a reload brings it back.

**Decisions (from the contract and the PRD):**
- **One trust store in the browser (FR-TRUST-10).** Citation chips, the sources list and the source panel all read one TanStack Query entry per citation, `["citation", id]`.
  - That entry starts from the copy saved on the message.
  - `GET /citations/{id}` then replaces it with the current verification.
  - So the three places can never show different statuses, and a changed status shows up in all of them at once.
  - If the lookup fails, the saved copy stays and nothing is worked out from it.
- **Markers.** `text` is split on `[[c:<uuid>]]`. Each marker becomes a chip numbered by the order in which citations first appear. A marker whose id isn't in `citations[]` is dropped, because there's no stored status to show for it. Repeated markers reuse their number.
- **Plain text only.** The answer is rendered as text, with paragraphs split on blank lines. There's no Markdown and no `dangerouslySetInnerHTML`, so model output can't inject markup.
- **Original language (FR-RES-10).**
  - The answer block gets `lang`/`dir` from `message.language`.
  - Each quote and excerpt gets `lang`/`dir` from `quoteLanguage` or `source.language` (`ur` is RTL; `en` and `roman_ur` are LTR). It's shown exactly as received and never translated.
  - The UI around them stays in the UI locale.
- **Chips and flags.**
  - A chip is the number, coloured by status, with an `aria-label` such as "Citation 2: Needs review".
  - The source panel shows every flag as a localised chip:
    - Blocking flags (`overruled`, `repealed`, `superseded_version`, `conflict`) use warning styling.
    - The others (`stale`, `third_party_source`, `headnote_only`, `amended_since`) are neutral.
  - Next to each badge is "Last verified <date>", formatted for the locale (FR-TRUST-5).
- **Sources list (FR-RES-7).** Beside the answer, one row per citation shows the number, the source title and citation (from `GET /sources/{id}`, or the `locator` while that loads), and a `TrustBadge`. "Third-party source" and "Head-note only" labels come from `thirdParty` and `headnoteOnly`.
- **Source panel.** A `Sheet` on the logical `end` side shows:
  - the badge, the last-verified date and the flags;
  - the source details: kind, court, decided-on date and tier;
  - the claim, the verbatim quote and the excerpt;
  - **"Open official source"**, a link to `officialUrl` with `target="_blank"` and `rel="noopener noreferrer"`.
    - It's rendered only for an `http:` or `https:` URL, so a `javascript:` value can't run.
- **The ask flow.**
  - The first question creates the conversation, then asks, then sets `?c=<id>` with `router.replace`.
  - Follow-up questions go to the same conversation, and the thread shows every message.
  - While waiting there's a busy state, "Researching and verifying citations…", and the submit button is disabled. There's no client timeout beyond the API's.
  - Errors are localised: 403 gives "AI research is turned off for your account. Ask your administrator to enable it.", 429 uses `tooMany`, 503 gives "The research service is unavailable right now. Try again shortly.", and a network failure uses `network`.
  - A `?c=` that returns 404 clears itself and starts a fresh page.
- **Unanswerable (FR-RES-9).** `answerable: false` shows the answer text inside an info notice, "The sources don't support an answer to this question", with no chips and no sources list.
- **Not ported from the prototype.** The filter chips (Statutes, Judgments, Court, …), the "High confidence" label and the "Generated from N sources" count have nothing behind them in the contract (`AskRequest` has only `question`, `language` and `lawAsOf`), so the page would be showing values it doesn't have.

Branch: `feature/web-research-hub` off `staging`. PR title: `feat(web): Research Hub answer view with citations, trust badges and source panel`.

## Changes

1. **Route.** `src/app/[locale]/(app)/research/page.tsx` renders `PageIntro` and `<ResearchHub />` inside a `Suspense` (it reads `?c=`). The metadata still comes from `pageMetadata("research")`.

2. **Data** (`src/components/research/queries.ts`)
   - `useConversation(id)`, `useAsk()`, `useCitation(citation)` and `useSource(id)`.
   - `useCitation` starts the query from the copy saved on the message (`initialData`, with `initialDataUpdatedAt: 0` so it refetches right away).
   - `seedCitations(client, citations)` runs after an ask or a load, so every view reads the same cache entry.
   - `ApiError(status, problem)` is thrown for non-2xx responses, and `researchError(status, t)` maps it to the messages above.

3. **Parsing** (`src/components/research/markers.ts`)
   - `parseAnswer(text, citations)` returns paragraphs of `{ text } | { citationId, n }` segments plus the ordered list of cited ids.
   - It's a pure function, so it's easy to unit test.

4. **Components** (`src/components/research/`)
   - `research-hub.tsx`: reads and writes `?c=`, renders the thread, the ask box and the open source panel.
   - `ask-box.tsx`: a textarea (maximum 4000 characters, with a localised placeholder), submitted by the button or Ctrl/⌘+Enter. Its error alert uses `role="alert"`.
   - `answer-card.tsx`: the analysis card, with `lang`/`dir` on the text and the unanswerable notice.
   - `citation-chip.tsx`: a `button`, coloured by status, that opens the panel.
   - `sources-list.tsx`: the evidence column.
   - `source-panel.tsx`: the `Sheet` described under Decisions.
   - `flag-chips.tsx` and `last-verified.tsx`, shared by the list and the panel.
   - `TrustBadge` doesn't change.

5. **Helpers.** `src/lib/language.ts` gets `dirOf(language)`. It's separate from `directionOf`, which covers UI locales only.

6. **Messages** (en and ur, the same keys)
   - `Research.{placeholder,submit,asking,analysis,sources,you,unanswerable,…}`.
   - `Research.errors.{aiDisabled,unavailable}`.
   - `Research.source.{title,claim,quote,excerpt,openOfficial,kind.*,court,decidedOn,tier,thirdParty,headnoteOnly}`.
   - `Trust.lastVerified`, `Trust.chip`.
   - `Trust.flags.{overruled,repealed,superseded_version,conflict,stale,third_party_source,headnote_only,amended_since}`.

7. **Tests**
   - `test/markers.test.ts`: numbering by first appearance, repeated markers, unknown ids dropped, paragraph splits, and text without markers.
   - `test/research-hub.test.tsx` (ur labels, stubbed `fetch`, the navigation mocks used elsewhere):
     - The first ask posts `/conversations` and then `/messages` with `{ question }`, and sets `?c=`.
     - Chips appear in order with their status `aria-label`s. An unknown marker shows no chip.
     - Opening a chip shows the panel: the badge, the last-verified date, the flags, the quote with `lang="ur" dir="rtl"`, and the official link with `rel="noopener noreferrer"`. A `javascript:` `officialUrl` gives no link.
     - **FR-TRUST-10:** the saved copy says `verified`, `GET /citations/{id}` returns `needs_review`, and afterwards the chip, the list row and the panel all show `needs_review`.
     - `answerable: false` shows the notice and no chips.
     - 403, 503 and 429 each show their localised alert. A `?c=` that gets 404 clears itself.
   - `rtl-classes.test.ts` and `i18n.test.ts` cover the new files and keys.

8. **Docs**
   - `apps/web/README.md`: a "Research Hub" section covering the one trust store, plain-text rendering, original-language quotes and the `http(s)` check on the official URL.
   - The `CHANGELOG.md` entry.
   - This plan's status line.

## Deviations during implementation
- **AI is on by default, not off.** `users.ai_enabled` defaults to `true`, so a new user got the live **503** in step 1. For the live **403**, the browser check made an admin (`docker compose exec api node dist/db/create-admin.js`) and turned AI off for the test user with `PATCH /admin/users/{id}`. A retry then reused the same conversation, with no second `POST /conversations`.
- **There's no `seedCitations`.** `useCitation` uses the saved copy as `initialData` with `initialDataUpdatedAt: 0`. That alone gives one cache entry per citation, which every view reads.
- **`useAsk` adds the question to the cache itself.** The API returns only the answer, so the thread doesn't have to be fetched again.
- **The conversation comes only from `?c=`,** not from component state as well. So the sidebar's Research link always starts a fresh page.
- **A new conversation goes into the URL as soon as it's created,** before the ask finishes. A failed ask (403, 503) is then retried in the same conversation.
- **`TrustBadge` exports `trustStyles`,** so the chips use the same colours.
- **`timeZone: "Asia/Karachi"` in `src/i18n/request.ts`.** next-intl needs a time zone to format the last-verified date the same on server and client. A source's `decidedOn` is a calendar date, so it's formatted in UTC.
- **`test/setup.ts` raises Testing Library's `asyncUtilTimeout` to 5 s.** One run in about ten had a cold first `findBy` pass the 1 s default. Five runs in a row passed after the change.
- **The FR-TRUST-10 test uses the app's 30 s `staleTime`.** With the test default of 0 it still passed when the refetch was broken on purpose, so it wasn't proving anything. With 30 s it fails when the refetch is broken.
- **The source panel's close button has a label** (`Common.close`). This was missing in the first browser pass.
- **Not in the plan's list, but needed:** `Research.loading` and `Research.shortcut` (Ctrl + Enter).

## Not in this PR
- A list of past conversations (#86), saving to a case, and `lawAsOf` (FR-RES-11).
- The prototype's filter chips and confidence label (nothing in the contract to back them).
- Sending a flagged item to human review (FR-TRUST-11, P1) and the "View precedent graph" buttons.
- Any API or `services/ai` change. Real answers arrive with #20.

## Verification
- `pnpm --filter ./apps/web run lint`, `typecheck`, `test` (all pass, none skipped) and `build`.
- `pnpm stack:up`, register a user, then:
  1. With AI off (the default), `/ur/research`: asking shows the Urdu "AI research is turned off" alert. That's the live 403.
  2. Turn AI on for the user (`pnpm db:create-admin` for an admin, then `PATCH /admin/users/{id}`), then ask. The live API answers 503 with no `research/answer` and the page shows "service unavailable".
  3. With `page.route` fixtures for `…/messages`, `/citations/*` and `/sources/*`:
     - The answer shows numbered chips and the sources list.
     - A chip opens the panel on the logical end side, in both EN and UR.
     - An Urdu quote is RTL inside the English UI, and an English quote is LTR inside the Urdu UI.
     - The official link opens in a new tab.
  4. A fixture where `/citations/{id}` returns `needs_review` for a citation saved as `verified`: the chip, the row and the panel all change together.
  5. Reloading with `?c=` brings the thread back. The conversation `GET` also comes from a fixture, because before #20 the live one has no messages. A `?c=` the user doesn't own gets the live 404 and clears itself.
- CI `ci-ok` is green.
