"""Shared, lazily built dependencies of the /ai/v1 routes.

The embedder, reranker and support checker are loaded once per process, on the first question
(the first two are about 2.3 GB each on first download, the NLI model about 0.6 GB). Tests
replace these with ``app.dependency_overrides``.
"""

from __future__ import annotations

from functools import lru_cache

from sqlalchemy import Engine, create_engine

from caseguard_ai.config import get_settings
from caseguard_ai.gateway.client import ModelGateway
from caseguard_ai.ingest.embedder import BgeM3Embedder, Embedder
from caseguard_ai.retrieval.reranker import BgeReranker, Reranker
from caseguard_ai.trust.support import (
    FallbackSupportChecker,
    LlmSupportChecker,
    NliSupportChecker,
    SupportChecker,
)


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


@lru_cache
def get_support_checker() -> SupportChecker:
    """NLI first; the judge role only when NLI is uncertain and the request allows a judge."""
    s = get_settings()
    nli = NliSupportChecker(
        s.support_model,
        s.support_revision,
        pass_threshold=s.support_pass_threshold,
        fail_threshold=s.support_fail_threshold,
        device=s.embedding_device or None,
    )
    judge = LlmSupportChecker(get_gateway()) if s.support_llm_fallback else None
    return FallbackSupportChecker(nli, judge)
