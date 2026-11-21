> **Status:** In progress · **Issue:** [#211](https://github.com/CaseGuard-AI/CaseGuard/issues/211) · **PR:** pending

# #211: precedent search and relationships (API)

## Context

The precedents contract is merged (#209, PR #216). api.v1 has `searchPrecedents` (`POST /precedents/search`, audited, 429 when rate limited) and `getPrecedentRelationships` (`GET /precedents/{sourceId}/relationships`). They mirror the ai.v1 operations that services/ai serves from #210 ([ADR-0011](../docs/adr/0011-graph-derived-precedent-search.md)).

This is Track P's second step (plan [0052](0052-209-precedents-drafting-linter-contract.md)): ai (#210) → **api** → web (#106). The api tests mock the ai client, so this branch doesn't wait for #210 to merge.

**Requirements:** FR-PREC-1, FR-PREC-4, FR-TRUST-12.

## Decisions

- **Routes** in `src/routes/precedents.ts`, mounted with one line in `app.ts`. Both need a signed-in user.
- **Search:**
  - The body is validated with zod against api.v1 `PrecedentSearch` (strict; `decidedFrom` after `decidedTo` is a 400 on `filters.decidedFrom`).
  - apps/api generates the `requestId`, forwards the body to ai.v1, and checks the response with zod before it reaches the user. A response for another `requestId` is treated as a failure.
  - Rate limited with the same `aiLimiter()` as research (30 per user per 15 minutes, 429).
  - **No 403 check.** The search calls no model provider, so it works when AI features are disabled for the user, as the contract says.
- **Audit (FR-TRUST-12)** reuses `app.ai_audit_records`, the table research writes, so there is no new migration: `question` holds the query, `outcome` is `answered` when there are hits and `unanswerable` when there are none, and `error` is set on failure. `response_text` holds a JSON summary of the hits (filters, `graphAvailable`, and each hit's `sourceId`, `origin` and `via`), which is the graph context the search used (§13.3). `allowed_providers` is `[]`, since no provider is used. The rows stay append-only.
- **Errors:** ai's 503 (and any failure, timeout or malformed response) becomes a 503. A 400 from ai means apps/api sent something the contract rejects, so it is treated as a failure too.
- **Relationships:** the path id is checked as a uuid (else 404, as `/sources` does). An ai 404 stays a 404; anything else is a 503. Not audited and not rate limited: api.v1 declares neither for it.
- **Client:** `searchPrecedents` and `getPrecedentRelationships` in `clients/ai.ts`, with `precedentSearchResultSchema` and `relationshipListSchema` in `ai-schemas.ts`. The test stubs get the two methods in `noIngestion`.

Branch: `feature/211-precedents-api` off `staging`. PR title: `feat(api): precedent search and relationships (FR-PREC-1, FR-PREC-4, FR-TRUST-12)`.

## Changes

1. `apps/api/src/clients/ai.ts`, `ai-schemas.ts`: types, methods, schemas.
2. `apps/api/src/precedents/audit.ts`: the audit write.
3. `apps/api/src/routes/precedents.ts`, mounted in `app.ts`.
4. `apps/api/test/precedents.test.ts`, `test/stubs.ts`.
5. `CHANGELOG.md`, `docs/engineering/work-log.md`.

## Tests

`expectContract` on every response: 200 search with retrieved and graph-derived hits; the request sent to ai (generated `requestId`, filters, defaults); the audit row for a search, an empty search and a failed one; 400s; 401; 429 after 30 searches; ai 503 → 503; a response for another request → 503; 200 relationships; ai 404 → 404; a non-uuid → 404; ai down → 503; and a search still works for a user whose AI features are off.

## Verification

`pnpm --filter ./apps/api run lint && pnpm --filter ./apps/api run typecheck && pnpm --filter ./apps/api run test` against a Track P test database. CI `ci-ok` green.
