"""Internal /ai/v1 routes. The contract is packages/contracts/openapi/ai.v1.yaml."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import Engine
from sqlalchemy.exc import OperationalError

from caseguard_ai import __version__
from caseguard_ai.api.deps import (
    get_embedder,
    get_engine,
    get_gateway,
    get_reranker,
    get_support_checker,
)
from caseguard_ai.api.problems import Problem
from caseguard_ai.config import Settings, get_settings
from caseguard_ai.drafting.assist import SectionRequest, draft_section
from caseguard_ai.drafting.catalog import TemplateId, get_template, templates
from caseguard_ai.gateway.client import GatewayError, ModelGateway, NoProviderError
from caseguard_ai.gateway.providers import (
    PRESET_BASE_URLS,
    ProviderConfig,
    allowed_set,
    from_credential,
)
from caseguard_ai.ingest.embedder import Embedder
from caseguard_ai.research import store
from caseguard_ai.research.answer import Question, answer_question
from caseguard_ai.retrieval.guard import CorpusNotReady, EmbeddingMismatch
from caseguard_ai.retrieval.hybrid import Scope
from caseguard_ai.retrieval.reranker import Reranker
from caseguard_ai.security import require_service_token
from caseguard_ai.trust.support import SupportChecker

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


class CredentialIn(BaseModel):
    """A user's own key for this request (ai.v1 ``Credential``, FR-SET-2, ADR-0009).

    ``apiKey`` is a SecretStr, so a repr, a log line or a validation message never shows it.
    """

    model_config = ConfigDict(extra="forbid")
    providerId: ProviderId
    model: Annotated[str, Field(min_length=1, max_length=200)]
    apiKey: Annotated[SecretStr, Field(min_length=1, max_length=512)]


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: uuid.UUID
    question: Annotated[str, Field(min_length=1, max_length=4000)]
    language: Language | None = None
    lawAsOf: date | None = None
    history: Annotated[list[TurnIn], Field(max_length=20)] = []
    scope: ScopeIn
    allowedProviders: Annotated[list[ProviderId], Field(max_length=32)] | None = None
    credential: CredentialIn | None = None


def _generation_override(
    cred: CredentialIn | None, allowed_providers: list[str] | None
) -> ProviderConfig | None:
    """The credential as a provider, or a 400 before any model call. Details name the field,
    never the key. Shared by ``answerQuestion`` and ``draftSection`` (ai.v1)."""
    if allowed_providers is not None and len(set(allowed_providers)) != len(allowed_providers):
        raise Problem(400, "Bad Request", "invalid field(s): allowedProviders (duplicates)")
    if cred is None:
        return None
    if cred.providerId not in PRESET_BASE_URLS:
        raise Problem(
            400, "Bad Request", "invalid field(s): credential.providerId (not a cloud provider)"
        )
    if cred.providerId not in allowed_set(allowed_providers):
        raise Problem(
            400, "Bad Request", "invalid field(s): credential.providerId (not in allowedProviders)"
        )
    return from_credential(cred.providerId, cred.model, cred.apiKey.get_secret_value())


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
    support_checker: Annotated[SupportChecker, Depends(get_support_checker)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    override = _generation_override(body.credential, body.allowedProviders)
    question = Question(
        request_id=body.requestId,
        question=body.question,
        scope=Scope(
            user_id=body.scope.userId,
            account_id=body.scope.accountId,
            allowed_case_ids=tuple(body.scope.allowedCaseIds),
        ),
        language=body.language,
        law_as_of=body.lawAsOf,
        history=[(t.role, t.content) for t in body.history],
        allowed_providers=body.allowedProviders,
        generation_override=override,
    )
    with _pipeline_errors():
        return answer_question(
            engine,
            question,
            gateway=gateway,
            embedder=embedder,
            reranker=reranker,
            support_checker=support_checker,
            stale_days=settings.trust_stale_days,
        )


@contextmanager
def _pipeline_errors() -> Iterator[None]:
    """The 503s of a retrieve → generate → verify request (``answerQuestion``, ``draftSection``)."""
    try:
        yield
    except NoProviderError as exc:
        raise Problem(503, "Service Unavailable", str(exc)) from exc
    except GatewayError as exc:
        log.warning("generation_failed", provider=exc.provider_id, reason=exc.reason)
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


# ── drafting (#212) ────────────────────────────────────────────────────────────────────────

SectionKey = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]


class SectionBodyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: SectionKey
    body: Annotated[str, Field(max_length=20000)]


class DraftSectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: uuid.UUID
    templateId: TemplateId
    sectionKey: SectionKey
    instruction: Annotated[str, Field(max_length=2000)] | None = None
    fields: dict[str, Annotated[str, Field(max_length=4000)] | None]
    otherSections: Annotated[list[SectionBodyIn], Field(max_length=30)]
    scope: ScopeIn
    allowedProviders: Annotated[list[ProviderId], Field(max_length=32)] | None = None
    credential: CredentialIn | None = None


@router.get("/drafting/templates")
def drafting_templates() -> dict[str, Any]:
    return {"items": [t.dto() for t in templates()]}


@router.post("/drafting/sections")
def drafting_section(
    body: DraftSectionRequest,
    engine: Annotated[Engine, Depends(get_engine)],
    gateway: Annotated[ModelGateway, Depends(get_gateway)],
    embedder: Annotated[Embedder, Depends(get_embedder)],
    reranker: Annotated[Reranker, Depends(get_reranker)],
    support_checker: Annotated[SupportChecker, Depends(get_support_checker)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    override = _generation_override(body.credential, body.allowedProviders)
    template = get_template(body.templateId)
    section = template.section(body.sectionKey) if template else None
    if template is None or section is None:
        raise Problem(400, "Bad Request", "invalid field(s): sectionKey (no such section)")
    if not section.assistable:
        raise Problem(400, "Bad Request", "invalid field(s): sectionKey (not assistable)")
    request = SectionRequest(
        request_id=body.requestId,
        template=template,
        section=section,
        scope=Scope(
            user_id=body.scope.userId,
            account_id=body.scope.accountId,
            allowed_case_ids=tuple(body.scope.allowedCaseIds),
        ),
        instruction=body.instruction or None,
        fields=body.fields,
        other_sections=[(s.key, s.body) for s in body.otherSections],
        allowed_providers=body.allowedProviders,
        generation_override=override,
    )
    with _pipeline_errors():
        return draft_section(
            engine,
            request,
            gateway=gateway,
            embedder=embedder,
            reranker=reranker,
            support_checker=support_checker,
            stale_days=settings.trust_stale_days,
        )
