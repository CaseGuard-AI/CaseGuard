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

## Addendum (2026-11-12): the support-check NLI model runs in-process too
The citation support check (FR-TRUST-3, PRD §7.1 step 2) needs a cross-encoder that scores
entailment, neutral and contradiction for a (evidence, claim) pair. No OpenAI-compatible endpoint
offers that, for the same reason as the reranker, so it follows this decision:

- **Model:** `MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7` (multilingual, so
  Urdu and Roman Urdu claims can be checked against English statutes), pinned by
  `SUPPORT_MODEL` and `SUPPORT_REVISION` (`b5113eb38ab63efdd7f280f8c144ea8b13f978ce`). About
  0.6 GB, CPU by default (`EMBEDDING_DEVICE`).
- It loads through `transformers` (a dependency of `sentence-transformers`), and the label order
  is read from the model config's `id2label`, never assumed.
- The LLM judge, used only when NLI is uncertain, goes through the gateway under the request's
  allow-list, as above. The model id is recorded in `ai.answer_traces.models.support`; the
  verifier version (`m2-support-1`) on every verification.
- Tests and CI use `StubSupportChecker`, so they never download it.
