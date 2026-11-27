> **Status:** Done · **Issue:** [#19](https://github.com/CaseGuard-AI/CaseGuard/issues/19) · **PR:** [#168](https://github.com/CaseGuard-AI/CaseGuard/pull/168)

# #19: hybrid retrieval (pgvector + FTS, RRF k=60, bge-reranker-v2-m3)

## Context

Handoff item 6, "retrieve", between #18 (embed) and #20 (answer). The branch is based on `feature/ai-ingestion-embeddings`, so **merge after #167**.

**Requirements:** FR-RES-2 (both ranked lists traced), FR-RES-4 (generation follows the reranker), FR-CASE-6 (scope in SQL; the marker test blocks release), PRD §8.2.

## Decisions

- **`retrieval.hybrid.retrieve(conn, question, scope, embedder, reranker)`:** dense top 50 + sparse top 50 → RRF (k = 60) → top 20 → cross-encoder → top 8.
- **Scope lives inside every SQL statement** that can touch `ai.case_chunks`: the dense search, the sparse search, *and* the passage fetch, as `user_id = caller AND case_id = ANY(allowedCaseIds)`.
  - An empty list matches nothing, which means the public corpus only.
  - Nothing is filtered in Python, so a bug later in the pipeline can't widen what was fetched. A chunk id alone never unlocks a case chunk.
- **The sparse search ORs the question's words** (`to_tsquery`). `websearch_to_tsquery` ANDs them, and a natural-language question then matches nothing. Only letters and digits pass through, so no tsquery syntax can be injected.
- **RRF uses ranks only**, so cosine and `ts_rank_cd` scores never need scaling. Ties keep first-seen order.
- **Guard:** refuses when `corpus_meta` is empty (`CorpusNotReady`) or its model/revision differs from the query embedder (`EmbeddingMismatch`). It deliberately doesn't require `built_at`, so search keeps working while an incremental embed adds documents.
- **The trace** holds ids, origins, ranks and scores, never text. #20 writes it to `ai.answer_traces`.
- **The reranker** is `BgeReranker` (CrossEncoder, pinned revision `953dc6f…`, in-process per ADR-0008). `OverlapReranker` is the deterministic stand-in for tests.

## Verification

- `ruff` and strict `mypy` are clean. `pytest` gives 116 passed, 2 skipped (they need `DATABASE_URL` / `APP_TEST_DATABASE_URL`, set in CI).
- `tests/test_retrieval.py` (12):
  - RRF math and tie order; the tsquery builder (including injection attempts);
  - the right section first; the trace's lists, and the order following reranker scores; sparse finding what dense might miss;
  - **FR-CASE-6 marker test:** no case without permission, only the caller's allowed case, another user's chunks never returned even when their case ids are passed (including the same case id under another user);
  - both guard refusals.
- **Mutation checks:** without the `user_id` predicate, 2 scope tests fail; without the `case_id` predicate, 2 fail.
