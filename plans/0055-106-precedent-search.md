> **Status:** In progress · **Issue:** [#106](https://github.com/CaseGuard-AI/CaseGuard/issues/106) · **PR:** pending

# #106: precedent search screen (web)

## Context

`/precedents` was a `ComingSoon` page. The contract (#209, PR #216) defines api.v1 `searchPrecedents` and `getPrecedentRelationships`; services/ai (#210, PR #219) and apps/api (#211, PR #220) implement them. The web tests mock fetch, so this branch is built against the contract alone.

This is Track P's last step (plan [0052](0052-209-precedents-drafting-linter-contract.md)).

**Requirements:** FR-PREC-1, FR-PREC-3, FR-PREC-4, FR-TRUST-10.

## Decisions

- **`src/components/precedents/`:** `queries.ts` (search as a mutation, since each submit is one audited search; relationships as a query), `precedent-search.tsx` (form and results), `relationships-panel.tsx` (sheet).
- **Search form:** query, plus the filters court, area, decided from and to, and section. Area is free text, because the web doesn't read `case-taxonomy.v1.yaml` yet. An "include graph-derived precedents" switch (on by default). Empty filters are left out. Errors are shown in words for 400, 429, 503 and network failures.
- **Results:** each hit shows its title (which opens the relationships panel), citation, court, decision date, an origin badge, flag chips and its snippet with the locator.
  - The badge says "Retrieved" or "Graph-derived via <edge> from <related title>", plus the section label for a shared section (FR-PREC-3). Graph-derived hits are indented under the hit they came from.
  - Flags use `FlagChips` from `research/trust-details.tsx`, so `overruled` looks the same as on a research citation (FR-TRUST-10).
- **No graph:** a notice when `graphAvailable` is false.
- **Relationships panel:** outgoing and incoming groups. Each edge shows its type, the other entity, its provenance (method, confidence, whether a human confirmed it), `TrustBadge` with the stored status, and "valid from".
  - An entity with a `sourceId` opens its source record (`useSource`, with the official link through `safeUrl`) in the same sheet. Otherwise it is shown by label.
  - A 404 is worded as "not in the corpus".
- **Strings:** a new top-level `Precedents` key in `en.json` and `ur.json`. `Pages.precedents` already exists. The Urdu awaits native review (#105).

Branch: `feature/106-precedent-search` off `staging`. PR title: `feat(web): precedent search screen (FR-PREC-1, FR-PREC-3, FR-PREC-4, FR-TRUST-10)`.

## Tests

`test/precedents.test.tsx`, with fetch mocked:
- the request body, with empty filters left out and the toggle sent;
- origin badges for retrieved and graph-derived hits, with `via`;
- the overruled chip, using the same classes as research;
- the no-graph notice;
- an empty result and the error messages;
- the relationships panel: groups, provenance, status badge, a link to a source that opens it, a label-only entity, and the 404 wording.

## Verification

`pnpm --filter ./apps/web run lint`, `typecheck`, `test` and `build`. CI `ci-ok` green.
