"""Rerankers (#19, ADR-0008: in-process).

- ``BgeReranker``: BAAI/bge-reranker-v2-m3, a multilingual cross-encoder, pinned to a revision.
  The order passed to generation follows its scores (FR-RES-4).
- ``OverlapReranker``: a deterministic stand-in for tests and CI (share of the query's words
  found in the passage). Never use it for real answers.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any, Protocol


class Reranker(Protocol):
    model_id: str

    def score(self, query: str, passages: Sequence[str]) -> list[float]: ...


class OverlapReranker:
    model_id = "caseguard/word-overlap"

    def score(self, query: str, passages: Sequence[str]) -> list[float]:
        wanted = set(re.findall(r"\w+", query.lower()))
        if not wanted:
            return [0.0] * len(passages)
        return [len(wanted & set(re.findall(r"\w+", p.lower()))) / len(wanted) for p in passages]


class BgeReranker:
    def __init__(
        self,
        model_id: str,
        revision: str,
        *,
        device: str | None = None,
        batch_size: int = 16,
        max_length: int = 1024,
    ) -> None:
        from sentence_transformers import CrossEncoder  # heavy: only when used

        from caseguard_ai.ingest.embedder import default_device

        self.model_id = model_id
        self.revision = revision
        self.batch_size = batch_size
        self._model: Any = CrossEncoder(
            model_id, revision=revision, device=device or default_device(), max_length=max_length
        )

    def score(self, query: str, passages: Sequence[str]) -> list[float]:
        if not passages:
            return []
        scores = self._model.predict(
            [(query, p) for p in passages], batch_size=self.batch_size, show_progress_bar=False
        )
        return [float(s) for s in scores]
