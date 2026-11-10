"""Shared, lazily built dependencies of the /ai/v1 routes.

The embedder and reranker are loaded once per process, on the first question (each is about
2.3 GB on first download). Tests replace these with ``app.dependency_overrides``.
"""

from __future__ import annotations

from functools import lru_cache

from sqlalchemy import Engine, create_engine

from caseguard_ai.config import get_settings
from caseguard_ai.gateway.client import ModelGateway
from caseguard_ai.ingest.embedder import BgeM3Embedder, Embedder
from caseguard_ai.retrieval.reranker import BgeReranker, Reranker


@lru_cache
def get_engine() -> Engine:
    return create_engine(get_settings().sqlalchemy_url, pool_pre_ping=True)


@lru_cache
def get_gateway() -> ModelGateway:
    return ModelGateway(get_settings())


@lru_cache
def get_embedder() -> Embedder:
    s = get_settings()
    return BgeM3Embedder(
        s.embedding_model,
        s.embedding_revision,
        device=s.embedding_device or None,
        batch_size=s.embedding_batch_size,
    )


@lru_cache
def get_reranker() -> Reranker:
    s = get_settings()
    return BgeReranker(s.reranker_model, s.reranker_revision, device=s.embedding_device or None)
