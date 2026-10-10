# ADR-0003: PostgreSQL is the knowledge-graph system of record; Graphiti is an experiment

- **Status:** Accepted
- **Date:** 2026-10-10
- **PRD refs:** §9, FR-GRAPH-1..3, resolves TBD-18 and TBD-22

## Context
Deliverable II proposed Graphiti over Neo4j. Graphiti builds graphs by running LLM extraction over text "episodes". The core P0 edges (judgment→section citations, judgment→judgment citations, connected cases, amendments) are already **structured data** in the collector's metadata, or can be extracted with regex. Running LLM extraction over 10k+ judgments is costly on free tiers and nondeterministic, and a second datastore would complicate tenant isolation.

## Decision
- Graph entities and edges live in Postgres (`corpus.graph_entities`, `corpus.graph_edges`), with `valid_from`, `valid_to`, `recorded_at`, provenance, extraction method, confidence and a human-confirmation flag.
- GraphRAG traversal uses recursive CTEs (depth ≤ 2 by default).
- **Graphiti + Neo4j** are run as a **comparative experiment** on a subset (FR-GRAPH-3), and the results are reported. The production path changes only through a superseding ADR.

## Alternatives considered
| Option | Why not |
|---|---|
| Graphiti + Neo4j as primary store | LLM extraction cost and nondeterminism; a second datastore to secure and scope |
| Neo4j without Graphiti | A second datastore for edges that fit in two tables |

## Consequences
- One datastore, one backup and one access-control model; scoping is applied in the same SQL.
- The proposal's Graphiti investigation is still delivered, as an evaluated comparison.
- Deep multi-hop graph analytics would be slower than in a native graph DB. That is acceptable at depth 2.
