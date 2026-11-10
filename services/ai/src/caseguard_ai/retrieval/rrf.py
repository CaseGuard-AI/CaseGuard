"""Reciprocal rank fusion (PRD §8.2: RRF, k = 60).

Each list contributes ``1 / (k + rank)`` for every item it ranks (rank 1 = best). Only ranks
count, never the raw scores, so a cosine similarity and a ``ts_rank_cd`` value can be fused
without being made comparable first.
"""

from __future__ import annotations

from collections.abc import Hashable, Sequence

RRF_K = 60


def fuse[T: Hashable](ranked_lists: Sequence[Sequence[T]], k: int = RRF_K) -> list[tuple[T, float]]:
    """Fused (item, score), best first. Ties keep the order in which items were first seen."""
    scores: dict[T, float] = {}
    for ranked in ranked_lists:
        for rank, item in enumerate(ranked, start=1):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank)
    order = {item: i for i, item in enumerate(scores)}
    return sorted(scores.items(), key=lambda pair: (-pair[1], order[pair[0]]))
