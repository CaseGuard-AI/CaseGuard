# ADR-0008: Embeddings and the reranker run in-process; LLM calls go through the gateway

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** Stream C, with the team (decided while planning the handoff work)
- **PRD refs:** §8.2, NFR-11, NFR-16, NFR-17, NFR-19. Amends ADR-0005.

## Context
ADR-0005 routes "chat/embeddings" through one OpenAI-compatible gateway. PRD §8.2 names **bge-m3** for embeddings and **bge-reranker-v2-m3** for reranking, and NFR-17 requires a locally runnable option for both.

In practice:
- OpenAI-compatible servers (and Ollama) offer embeddings but **no cross-encoder reranking endpoint**.
- Free-tier clouds don't host bge-m3 with a pinned revision.
- A corpus dump (#154) is only valid if the query side uses **exactly** the model and revision the corpus was embedded with.

## Decision
- **LLM calls** (generation, judge, later translation and the support-check fallback) go through `caseguard_ai.gateway.ModelGateway`, as in ADR-0005.
- **Embeddings and reranking** run **in-process** in services/ai through `sentence-transformers` (bge-m3 dense, normalised, 1024 dims; bge-reranker-v2-m3 as a `CrossEncoder`). They use CPU by default and CUDA when available.
  - Model ids **and revisions** are pinned in settings and recorded in `corpus.corpus_meta`.
  - Retrieval refuses to run if they differ.
- Both sit behind small interfaces (`Embedder`, `Reranker`), so a server-backed implementation can be added later as configuration.

## Alternatives considered
| Option | Why not |
|---|---|
| Embeddings through Ollama's `/v1/embeddings` | No reranker there anyway; harder to pin the exact model revision a dump was built with |
| A hosted embedding API | Not free, needs the network for every query, and the revision isn't under our control |
| Skip the reranker in M1 | PRD §8.1–8.2 and FR-RES-4 put reranking in the P0 pipeline |

## Consequences
- services/ai gains `torch` and `sentence-transformers` (about 1–2 GB installed). The model weights download once into the Hugging Face cache.
- The integrator embeds on the strongest machine available. Everyone else restores the dump and only embeds queries, which is fast on CPU.
- Tests use a deterministic stand-in embedder and reranker, so CI never downloads models.
