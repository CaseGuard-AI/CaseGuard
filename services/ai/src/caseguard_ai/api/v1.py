"""Internal /ai/v1 routes. The contract is packages/contracts/openapi/ai.v1.yaml."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Engine
from sqlalchemy.exc import OperationalError

from caseguard_ai import __version__
from caseguard_ai.api.deps import get_embedder, get_engine, get_gateway, get_reranker
from caseguard_ai.api.problems import Problem
from caseguard_ai.config import Settings, get_settings
from caseguard_ai.gateway.client import GatewayError, ModelGateway, NoProviderError
from caseguard_ai.ingest.embedder import Embedder
from caseguard_ai.research import store
from caseguard_ai.research.answer import Question, answer_question
from caseguard_ai.retrieval.guard import CorpusNotReady, EmbeddingMismatch
from caseguard_ai.retrieval.hybrid import Scope
from caseguard_ai.retrieval.reranker import Reranker
from caseguard_ai.security import require_service_token

log = structlog.get_logger("api")
router = APIRouter(prefix="/ai/v1", dependencies=[Depends(require_service_token)])

Language = Literal["en", "ur", "roman_ur"]
ProviderId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")]


class ScopeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    userId: uuid.UUID
    accountId: uuid.UUID
    allowedCaseIds: list[uuid.UUID]


class TurnIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: str


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: uuid.UUID
    question: Annotated[str, Field(min_length=1, max_length=4000)]
    language: Language | None = None
    lawAsOf: date | None = None
    history: Annotated[list[TurnIn], Field(max_length=20)] = []
    scope: ScopeIn
    allowedProviders: Annotated[list[ProviderId], Field(max_length=32)] | None = None


@router.get("/info")
def info() -> dict[str, str]:
    """Authenticated smoke-test endpoint: proves the API → AI token wiring works."""
    return {"service": "caseguard-ai", "version": __version__}


@router.post("/research/answer")
def research_answer(
    body: AnswerRequest,
    engine: Annotated[Engine, Depends(get_engine)],
    gateway: Annotated[ModelGateway, Depends(get_gateway)],
    embedder: Annotated[Embedder, Depends(get_embedder)],
    reranker: Annotated[Reranker, Depends(get_reranker)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    if body.allowedProviders is not None and len(set(body.allowedProviders)) != len(
        body.allowedProviders
    ):
        raise Problem(400, "Bad Request", "invalid field(s): allowedProviders (duplicates)")
    question = Question(
        request_id=body.requestId,
        question=body.question,
        scope=Scope(
            user_id=body.scope.userId,
            account_id=body.scope.accountId,
            allowed_case_ids=tuple(body.scope.allowedCaseIds),
        ),
        language=body.language,
        history=[(t.role, t.content) for t in body.history],
        allowed_providers=body.allowedProviders,
    )
    try:
        return answer_question(
            engine,
            question,
            gateway=gateway,
            embedder=embedder,
            reranker=reranker,
            stale_days=settings.trust_stale_days,
        )
    except NoProviderError as exc:
        raise Problem(503, "Service Unavailable", str(exc)) from exc
    except GatewayError as exc:
        log.warning("generation_failed", provider=exc.provider_id)
        raise Problem(503, "Service Unavailable", "the model provider failed") from exc
    except (CorpusNotReady, EmbeddingMismatch) as exc:
        log.error("corpus_unavailable", reason=type(exc).__name__)
        raise Problem(503, "Service Unavailable", "the corpus is not ready") from exc
    except OperationalError as exc:
        raise Problem(503, "Service Unavailable", "the database is unavailable") from exc


@router.get("/citations/{citationId}")
def citation(citationId: uuid.UUID, engine: Annotated[Engine, Depends(get_engine)]) -> Any:
    with engine.connect() as conn:
        found = store.get_citation(conn, citationId)
    if found is None:
        raise Problem(404, "Not Found", "no such citation")
    return found


@router.get("/sources/{sourceId}")
def source(sourceId: uuid.UUID, engine: Annotated[Engine, Depends(get_engine)]) -> Any:
    with engine.connect() as conn:
        found = store.get_source(conn, sourceId)
    if found is None:
        raise Problem(404, "Not Found", "no such source")
    return found
