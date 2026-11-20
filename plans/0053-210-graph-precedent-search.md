> **Status:** In progress · **Issue:** [#210](https://github.com/CaseGuard-AI/CaseGuard/issues/210) · **PR:** pending

# #210: knowledge graph tables, graph build and precedent search (services/ai)

## Context

The precedents contract is merged (#209, PR #216): ai.v1 has `searchPrecedents` and `getPrecedentRelationships`, and [ADR-0011](../docs/adr/0011-graph-derived-precedent-search.md) fixes the design: hybrid retrieval over judgments, then one graph hop, labelled by origin. The graph lives in Postgres ([ADR-0003](../docs/adr/0003-postgres-as-graph-system-of-record.md), PRD §9.1), but no graph tables exist yet. Citations between judgments are only raw strings in `corpus.documents.raw` (`cited_cases`, `cited_laws`, `connected_cases`).

This is Track P's first step (plan [0052](0052-209-precedents-drafting-linter-contract.md)): ai → api (#211) → web (#106).

**Requirements:** FR-GRAPH-1, FR-PREC-2, FR-PREC-3, FR-PREC-4.

## Decisions

- **Migration `0002_graph`** (after `0001`): `corpus.graph_entities(id, type, ref_table, ref_id, label, key, created_at)` and `corpus.graph_edges(id, type, src_entity, dst_entity, valid_from, valid_to, recorded_at, provenance_doc_id, extraction_method, confidence, human_confirmed, verification_status)`, per §9.1.
  - Check constraints: entity `type` and edge `type` from the P0 taxonomy (§9.2); `extraction_method` in `metadata | regex | human`; `confidence` in [0, 1]; `verification_status` from the trust statuses.
  - `provenance_doc_id` references `corpus.documents` with `ON DELETE CASCADE`; the edge endpoints reference `graph_entities`, also cascading.
  - Idempotency keys: entities unique on `(type, key)`, edges unique on `(type, src_entity, dst_entity, provenance_doc_id)`. Indexes on `src_entity`, `dst_entity`, edge `type` and entity `ref_id`.
  - Grants: none needed. `bootstrap.sql` already gives `caseguard_app` SELECT on every new `corpus` table through default privileges; the grants test covers the new tables.
  - The dump restore (`ingest/dump.py`) truncates the graph tables with the corpus, since the edges reference `corpus.documents`. The graph is derived data and is not in the dump: rebuild it with `pnpm ai:graph-build` after a restore.
- **Entities.** Every judgment gets an entity keyed `doc:<id>` that points at its document. A judgment citation that doesn't resolve becomes a `judgment` entity without a ref, keyed and labelled by the normalised citation. Sections are `section` entities keyed by their normalised label ("s.497 CrPC"), with `ref_id` set to the statute document when the code resolves to one.
- **Build** (`graph/build.py`), one pass over the judgments:
  - `CITES_JUDGMENT` from `raw.cited_cases` (`metadata`, confidence 0.9) and the law-report `CITATION` regex over `full_text` (`regex`, 0.7). The regex is ported from the collector's `metadata_extractor.py`, not imported. Citations are resolved against `corpus.documents.citation` and `raw.all_citations` after normalisation (case, dots, spacing).
  - `CITES_SECTION` from section references in `raw.cited_laws` entries (`metadata`, 0.9) and in `full_text` (`regex`, 0.7), for the codes the parser knows (PPC, CrPC, CPC, Qanun-e-Shahadat, the Constitution). A cited law with no section has no P0 edge and is skipped.
  - `CONNECTED_CASE` from `raw.connected_cases` (`metadata`, 0.9), resolved by case number, preferring the same court; ambiguous or unknown case numbers become unresolved entities.
  - `OVERRULES` only from an explicit `raw.overrules` list (`metadata`, 1.0). The collector emits no such key yet, so no `OVERRULES` edge exists from real data; nothing is ever inferred (§9.2).
  - One edge per `(type, src, dst, provenance)`; metadata wins over regex. Self-citations are dropped.
  - Idempotent: upserts on the unique keys, then deletes the machine edges of each processed document that this run no longer produced (human edges are never touched), then unreferenced unresolved entities. A re-run changes nothing.
  - CLI: `python -m caseguard_ai.graph.build`, wired as root `pnpm ai:graph-build`.
- **Traversal** (`graph/traverse.py`): one recursive CTE, both directions, typed edges, depth ≤ 2, intermediate nodes restricted to given entity types, no cycles.
- **Search** (`precedents/search.py`):
  - `retrieve()` with an empty public scope and a new, optional `kinds` filter (corpus branch only, in SQL; research passes nothing, so its behaviour is unchanged).
  - Chunks are grouped by judgment (`retrieved`), with the best passage's locator and a snippet of at most 500 characters.
  - Filters: `court` (exact), `area`, `decidedFrom`/`decidedTo`, and `sectionRef` (normalised, through `CITES_SECTION`), applied to every hit.
  - One hop from each retrieved judgment: `CITES_JUDGMENT` either way, `CONNECTED_CASE` either way, and judgments citing the same section (two edges through a `section` entity). These are `graph_derived` with `via`. A judgment seen both ways is `retrieved`.
  - Order: each retrieved hit, then up to 2 of its graph-derived hits, cut at `limit`. `score` falls with rank, so it is comparable within one result.
  - `overruled` from an incoming `OVERRULES` edge. `graphAvailable` is false when `graph_edges` is empty.
- **Routes** in a new `api/precedents.py`, mounted with one line in `main.py`. The relationships route is a 404 for anything that isn't a judgment.

Branch: `feature/210-graph-precedent-search` off `staging`. PR title: `feat(ai): knowledge graph tables, graph build and precedent search (FR-GRAPH-1, FR-PREC-2, FR-PREC-3, FR-PREC-4)`.

## Changes

1. `services/ai/migrations/versions/0002_graph.py`, `db/tables.py`: the two tables.
2. `services/ai/src/caseguard_ai/graph/`: `citations.py` (regexes, normalisation), `build.py` (+ CLI), `traverse.py`.
3. `services/ai/src/caseguard_ai/precedents/search.py`, `api/precedents.py`, `main.py` (mount).
4. `retrieval/hybrid.py`: the optional `kinds` filter. `ingest/dump.py`: truncate the graph on restore.
5. `package.json`: `ai:graph-build`. `services/ai/README.md`, `CHANGELOG.md`, `docs/engineering/work-log.md`.

## Tests

- `tests/test_migrations.py`: the new tables in the round trip, the constraints, app read access.
- `tests/test_graph.py`: known citations give the expected edges with provenance (FR-GRAPH-1); a re-run adds nothing; parsing and normalisation units.
- `tests/test_precedents.py`, synthetic judgments with `HashEmbedder`, responses checked against ai.v1: a graph-derived hit is labelled with `via` (FR-PREC-3); an overruled hit is flagged; relationships carry provenance (FR-PREC-2, FR-PREC-4); no graph gives `graphAvailable: false`; filters; 404 for a statute.

## Verification

`uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest` in `services/ai`, against a Track P test database. CI `ci-ok` green.
