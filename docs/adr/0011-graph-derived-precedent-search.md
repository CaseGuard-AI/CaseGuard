# ADR-0011: Precedent search is retrieval plus one graph hop, labelled by origin

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Stream A (apps/api, apps/web), Stream B (graph), Stream C (services/ai)
- **PRD refs:** FR-PREC-1, FR-PREC-2, FR-PREC-3, FR-PREC-4, FR-GRAPH-1, §9.1–§9.3, ADR-0003

## Context
The precedent search screen (#106) needs judgments relevant to a query, plus the precedents the knowledge graph links them to, and each judgment's typed relationships with provenance (FR-PREC-2, FR-PREC-4). Graph-derived precedents must be returned *and labelled* as graph-derived (FR-PREC-3). The graph lives in Postgres (ADR-0003), but no graph tables exist yet: citations between judgments are only raw strings in `corpus.documents.raw` (`cited_cases`, `cited_laws`, `connected_cases`).

## Decision
- **Search is hybrid retrieval, then one hop.** `POST /ai/v1/precedents/search` reuses `retrieval/hybrid.py::retrieve()` over judgments only, groups chunks by judgment (`origin: retrieved`), then adds judgments one hop away through `CITES_JUDGMENT` (either direction), `CONNECTED_CASE` and a shared `CITES_SECTION` (`origin: graph_derived`, with `via` naming the edge and the retrieved judgment it came from). A judgment reached both ways is `retrieved`. Graph-derived hits rank after the hits they came from.
- **Deterministic, no model.** Search calls no model provider, so no data leaves the deployment and it works with AI features disabled for a user.
- **Graph flags constrain.** A judgment with an incoming `OVERRULES` edge carries the `overruled` flag (§9.3). Flags reuse the trust layer's `TrustFlag` enum, so a flag means the same thing everywhere (FR-TRUST-10).
- **Graph tables per §9.1.** `corpus.graph_entities` and `corpus.graph_edges` (Alembic, services/ai), built by an idempotent job from collector metadata (`extraction_method: metadata`) and regex matches in the text (`regex`), with provenance and a confidence on every edge (FR-GRAPH-1). `OVERRULES` only from explicit metadata or human confirmation (§9.2). Traversal uses recursive CTEs, depth ≤ 2.
- **Degrades without a graph.** Until the graph is built, `graphAvailable` is false and only retrieved hits are returned.

## Alternatives considered
| Option | Why not |
|---|---|
| Graph-only search (match citations by text, then traverse) | Misses relevant judgments that nobody cited yet; retrieval quality is already measured, the graph is not. |
| Two hops by default | Fan-out explodes on a small, noisy regex graph; one hop keeps `via` explainable. Depth 2 stays available to the trust layer. |
| Rank graph-derived hits by an LLM | Non-deterministic and sends data to a provider for a search; the label, not a score, is what FR-PREC-3 asks for. |
| Graphiti / Neo4j | An experiment only (§9.4, ADR-0003). |

## Consequences
- The search result is only as good as citation resolution; unresolved citations become `section`/`judgment` entities without a `sourceId` and are shown by label.
- FR-TRUST-7 (graph flags on research citations) can read the same tables later.
