"""Hybrid retrieval (#19, PRD §8.2, FR-RES-2, FR-RES-4, FR-CASE-6).

    dense top 50  (pgvector cosine)  ─┐
                                      ├─ RRF (k = 60) → top 20 → cross-encoder → top 8
    sparse top 50 (Postgres FTS)     ─┘

- **Scope is applied inside SQL**, in both searches (FR-CASE-6): the public corpus, plus the
  caller's own case chunks (``ai.case_chunks``) only where ``user_id`` is the caller's *and*
  ``case_id`` is in ``allowedCaseIds``. An empty list means the public corpus only. Nothing
  is filtered afterwards in Python, so a bug further on cannot widen what was fetched.
- **The trace** keeps every ranked list (dense, sparse, fused, reranked) for
  ``ai.answer_traces`` (FR-RES-2). It holds ids and scores, never text.
- The sparse query ORs the question's words, so a natural question ("What is the punishment
  under s. 302 PPC?") matches passages that contain only some of them; ``ts_rank_cd`` ranks
  those with more matches higher.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import Connection, text

from caseguard_ai.ingest.embedder import Embedder
from caseguard_ai.retrieval.guard import check_corpus
from caseguard_ai.retrieval.reranker import Reranker
from caseguard_ai.retrieval.rrf import RRF_K, fuse

DENSE_K = 50
SPARSE_K = 50
FUSED_K = 20
FINAL_K = 8

CORPUS = "corpus"
CASE = "case"

Key = tuple[str, uuid.UUID]  # (origin, chunk id): corpus and case chunks live in two tables


@dataclass(frozen=True)
class Scope:
    """The ai.v1 Scope, resolved by apps/api. Never widened here."""

    user_id: uuid.UUID
    account_id: uuid.UUID
    allowed_case_ids: tuple[uuid.UUID, ...] = ()


@dataclass(frozen=True)
class Passage:
    origin: str  # "corpus" or "case"
    chunk_id: uuid.UUID
    document_id: uuid.UUID
    text: str
    locator: str | None
    section_id: str | None
    headnote_only: bool
    third_party: bool
    title: str | None = None
    official_url: str | None = None
    kind: str | None = None
    case_id: uuid.UUID | None = None
    rerank_score: float = 0.0


@dataclass
class Retrieval:
    passages: list[Passage]
    dense: list[dict[str, Any]] = field(default_factory=list)
    sparse: list[dict[str, Any]] = field(default_factory=list)
    fused: list[dict[str, Any]] = field(default_factory=list)
    reranked: list[dict[str, Any]] = field(default_factory=list)

    def trace(self) -> dict[str, list[dict[str, Any]]]:
        """The ranked lists, ready for ai.answer_traces (ids and scores only)."""
        return {
            "dense": self.dense,
            "sparse": self.sparse,
            "fused": self.fused,
            "reranked": self.reranked,
        }


# ── the two searches ────────────────────────────────────────────────────────────────────────

# The case branch carries the scope predicate. With no allowed cases it matches nothing.
_DENSE = text(
    """
    (SELECT 'corpus' AS origin, c.id, c.embedding <=> CAST(:q AS vector) AS distance
       FROM corpus.chunks c
      WHERE c.embedding IS NOT NULL
      ORDER BY distance LIMIT :k)
    UNION ALL
    (SELECT 'case' AS origin, cc.id, cc.embedding <=> CAST(:q AS vector) AS distance
       FROM ai.case_chunks cc
      WHERE cc.embedding IS NOT NULL
        AND cc.user_id = CAST(:user_id AS uuid)
        AND cc.case_id = ANY(CAST(:case_ids AS uuid[]))
      ORDER BY distance LIMIT :k)
    ORDER BY distance, origin, id
    LIMIT :k
    """
)

_SPARSE = text(
    """
    WITH q AS (SELECT to_tsquery('english', :tsq) AS query)
    (SELECT 'corpus' AS origin, c.id, ts_rank_cd(c.tsv, q.query) AS rank
       FROM corpus.chunks c, q
      WHERE c.tsv @@ q.query
      ORDER BY rank DESC LIMIT :k)
    UNION ALL
    (SELECT 'case' AS origin, cc.id, ts_rank_cd(cc.tsv, q.query) AS rank
       FROM ai.case_chunks cc, q
      WHERE cc.tsv @@ q.query
        AND cc.user_id = CAST(:user_id AS uuid)
        AND cc.case_id = ANY(CAST(:case_ids AS uuid[]))
      ORDER BY rank DESC LIMIT :k)
    ORDER BY rank DESC, origin, id
    LIMIT :k
    """
)

_CORPUS_PASSAGES = text(
    """
    SELECT c.id AS chunk_id, c.document_id, c.text, c.locator, c.section_id, c.headnote_only,
           c.third_party, d.title, d.official_url, d.kind
      FROM corpus.chunks c JOIN corpus.documents d ON d.id = c.document_id
     WHERE c.id = ANY(CAST(:ids AS uuid[]))
    """
)

# Fetched again under the same scope predicate: an id alone never unlocks a case chunk.
_CASE_PASSAGES = text(
    """
    SELECT cc.id AS chunk_id, cc.document_id, cc.case_id, cc.text, cc.locator
      FROM ai.case_chunks cc
     WHERE cc.id = ANY(CAST(:ids AS uuid[]))
       AND cc.user_id = CAST(:user_id AS uuid)
       AND cc.case_id = ANY(CAST(:case_ids AS uuid[]))
    """
)


def ts_query(question: str) -> str:
    """The question's words ORed for ``to_tsquery``. Only letters and digits get through, so the
    question can never inject tsquery syntax. Stop words are dropped by Postgres itself."""
    words = dict.fromkeys(re.findall(r"[^\W_]+", question.lower()))
    return " | ".join(words)


def _scope_params(scope: Scope) -> dict[str, Any]:
    return {
        "user_id": str(scope.user_id),
        "case_ids": [str(c) for c in scope.allowed_case_ids],
    }


def _vector(values: Sequence[float]) -> str:
    return "[" + ",".join(repr(float(v)) for v in values) + "]"


def dense_search(
    conn: Connection, query_vector: Sequence[float], scope: Scope, k: int = DENSE_K
) -> list[tuple[Key, float]]:
    rows = conn.execute(_DENSE, {"q": _vector(query_vector), "k": k, **_scope_params(scope)}).all()
    return [((r.origin, r.id), 1.0 - float(r.distance)) for r in rows]


def sparse_search(
    conn: Connection, question: str, scope: Scope, k: int = SPARSE_K
) -> list[tuple[Key, float]]:
    query = ts_query(question)
    if not query:
        return []
    rows = conn.execute(_SPARSE, {"tsq": query, "k": k, **_scope_params(scope)}).all()
    return [((r.origin, r.id), float(r.rank)) for r in rows]


def _passages(conn: Connection, keys: Sequence[Key], scope: Scope) -> dict[Key, Passage]:
    out: dict[Key, Passage] = {}
    corpus_ids = [str(i) for origin, i in keys if origin == CORPUS]
    case_ids = [str(i) for origin, i in keys if origin == CASE]
    if corpus_ids:
        for r in conn.execute(_CORPUS_PASSAGES, {"ids": corpus_ids}).mappings():
            out[(CORPUS, r["chunk_id"])] = Passage(origin=CORPUS, **r)
    if case_ids:
        rows = conn.execute(_CASE_PASSAGES, {"ids": case_ids, **_scope_params(scope)})
        for r in rows.mappings():
            out[(CASE, r["chunk_id"])] = Passage(
                origin=CASE,
                chunk_id=r["chunk_id"],
                document_id=r["document_id"],
                case_id=r["case_id"],
                text=r["text"],
                locator=r["locator"],
                section_id=None,
                headnote_only=False,
                third_party=False,
            )
    return out


def _listed(ranked: Sequence[tuple[Key, float]]) -> list[dict[str, Any]]:
    return [
        {"rank": rank, "origin": key[0], "chunkId": str(key[1]), "score": round(score, 6)}
        for rank, (key, score) in enumerate(ranked, start=1)
    ]


# ── the pipeline ────────────────────────────────────────────────────────────────────────────


def retrieve(
    conn: Connection,
    question: str,
    scope: Scope,
    embedder: Embedder,
    reranker: Reranker,
    *,
    dense_k: int = DENSE_K,
    sparse_k: int = SPARSE_K,
    fused_k: int = FUSED_K,
    final_k: int = FINAL_K,
) -> Retrieval:
    """The best ``final_k`` passages for ``question`` within ``scope``, best first."""
    check_corpus(conn, embedder)
    (query_vector,) = embedder.embed([question])
    dense = dense_search(conn, query_vector, scope, dense_k)
    sparse = sparse_search(conn, question, scope, sparse_k)
    fused = fuse([[key for key, _ in dense], [key for key, _ in sparse]], k=RRF_K)[:fused_k]
    candidates = _passages(conn, [key for key, _ in fused], scope)
    # A fused key with no passage could only be a case chunk outside the scope; it is dropped.
    keys = [key for key, _ in fused if key in candidates]
    scores = reranker.score(question, [candidates[key].text for key in keys])
    reranked = sorted(zip(keys, scores, strict=True), key=lambda pair: -pair[1])[:final_k]
    passages = [
        Passage(**{**candidates[key].__dict__, "rerank_score": score}) for key, score in reranked
    ]
    return Retrieval(
        passages=passages,
        dense=_listed(dense),
        sparse=_listed(sparse),
        fused=_listed(fused),
        reranked=_listed(reranked),
    )
