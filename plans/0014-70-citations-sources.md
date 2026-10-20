> **Status:** In progress · **Issue:** [#70](https://github.com/CaseGuard-AI/CaseGuard/issues/70) · **PR:** #N

# #70: citations and sources routes (API)

## Context
api.v1 has `GET /citations/{citationId}` and `GET /sources/{sourceId}`, but no API issue covered them. I found the gap while doing #13. Both routes proxy to ai.v1 (`getCitation`, `getSource`) with the service token.

**Decision (owner):** contract first. #71 declares `503 Unavailable` on both operations, since the AI service can be down.

`services/ai` doesn't serve these ai.v1 endpoints yet (#15/#20), so, as with #13, this is built against the contract with a fake AI client.

Branch `feature/api-citations-sources` (stacked on #71, rebased onto `staging` once it merges). PR title: `feat(api): citation and source routes with access checks`.

## Changes
1. **`src/clients/ai.ts`**:
   - `getCitation(id)` and `getSource(id)`, plus a `Source` type.
   - Non-200 responses throw `AiHttpError` with a `status`, so routes can tell a 404 from an outage.
2. **`src/clients/ai-schemas.ts`**: Zod versions of the shared `Citation`, `Source` and `Answer` shapes (loose objects; checks only the required fields).
   - Moving `answerSchema` here means `src/routes/conversations.ts` now imports it.
   - Every response from the AI service is validated before it reaches a user. An invalid one becomes 503.
3. **Migration `0005_messages_citations_idx`**: a GIN `jsonb_path_ops` index on `app.messages.citations`, so the ownership check below doesn't scan the whole table. It has a `.down.sql`.
4. **`src/conversations/store.ts`**: `userHasCitation(db, userId, citationId)`. It looks for an assistant message owned by the user whose `citations @> '[{"id": …}]'`.
5. **`src/routes/sources.ts`**: `sourcesRouter({ db, jwtSecret, ai })`, with `requireAuth` on `/citations` and `/sources`.
   - **`GET /citations/{id}`:**
     - A non-uuid id, or a citation that isn't in the user's own answers, gives **404 without calling the AI service** (FR-AUTH-4).
     - Otherwise it calls `ai.getCitation`, which returns the current stored verification (FR-TRUST-5, FR-TRUST-10).
     - An AI 404 gives 404. Any other failure, or an invalid response, gives 503.
   - **`GET /sources/{id}`:**
     - Any signed-in user can read public-corpus sources (FR-RES-7).
     - A non-uuid id gives 404. An AI 404 gives 404, and any other failure or an invalid response gives 503.
     - Private case documents come with cases (P1, FR-CASE-6).
6. **Wiring**: mount the router in `src/app.ts`. The test fakes gain the two new methods.
7. **Tests** in `test/sources.test.ts`, which needs `APP_TEST_DATABASE_URL`:
   - Every response goes through `expectContract`.
   - **Citation:**
     - The owner gets 200 with the AI's current verification, not the stored copy.
     - Another user gets 404, and the AI isn't called.
     - An unknown or malformed id gives 404. An AI 404 gives 404.
     - The AI being down gives 503, and so does an invalid AI response. No token gives 401.
   - **Source:** 200 with `officialUrl`. An AI 404 gives 404, the AI being down gives 503, and a malformed id gives 404.
   - `test/migrations.test.ts` adds `0005`.
8. **Docs**: `apps/api/README.md`, `CHANGELOG.md`.

## Verification
- Lint and typecheck pass.
- `vitest` with temp Postgres and Mailpit passes with nothing skipped.
- CI is green after rebasing onto `staging` with #71 merged.
