"""/ai/v1/precedents routes (#210, ai.v1 ``searchPrecedents``, ``getPrecedentRelationships``)."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Engine
from sqlalchemy.exc import OperationalError

from caseguard_ai.api.deps import get_embedder, get_engine, get_reranker
from caseguard_ai.api.problems import Problem
from caseguard_ai.ingest.embedder import Embedder
from caseguard_ai.precedents.search import (
    Filters,
    PrecedentQuery,
    get_relationships,
    search_precedents,
)
from caseguard_ai.retrieval.guard import CorpusNotReady, EmbeddingMismatch
from caseguard_ai.retrieval.reranker import Reranker
from caseguard_ai.security import require_service_token

log = structlog.get_logger("api")
router = APIRouter(
    prefix="/ai/v1/precedents", tags=["precedents"], dependencies=[Depends(require_service_token)]
)


class FiltersIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    court: Annotated[str, Field(max_length=120)] | None = None
    area: Annotated[str, Field(max_length=80)] | None = None
    decidedFrom: date | None = None
    decidedTo: date | None = None
    sectionRef: Annotated[str, Field(max_length=120)] | None = None


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: uuid.UUID
    query: Annotated[str, Field(min_length=1, max_length=1000)]
    filters: FiltersIn | None = None
    includeGraphDerived: bool = True
    limit: Annotated[int, Field(ge=1, le=50)] = 20


@router.post("/search")
def search(
    body: SearchRequest,
    engine: Annotated[Engine, Depends(get_engine)],
    embedder: Annotated[Embedder, Depends(get_embedder)],
    reranker: Annotated[Reranker, Depends(get_reranker)],
) -> dict[str, Any]:
    f = body.filters or FiltersIn()
    if f.decidedFrom and f.decidedTo and f.decidedFrom > f.decidedTo:
        raise Problem(400, "Bad Request", "invalid field(s): filters.decidedFrom (after decidedTo)")
    query = PrecedentQuery(
        request_id=body.requestId,
        query=body.query,
        filters=Filters(
            court=f.court,
            area=f.area,
            decided_from=f.decidedFrom,
            decided_to=f.decidedTo,
            section_ref=f.sectionRef,
        ),
        include_graph_derived=body.includeGraphDerived,
        limit=body.limit,
    )
    try:
        return search_precedents(engine, query, embedder=embedder, reranker=reranker)
    except (CorpusNotReady, EmbeddingMismatch) as exc:
        log.error("corpus_unavailable", reason=type(exc).__name__)
        raise Problem(503, "Service Unavailable", "the corpus is not ready") from exc
    except OperationalError as exc:
        raise Problem(503, "Service Unavailable", "the database is unavailable") from exc


@router.get("/{sourceId}/relationships")
def relationships(sourceId: uuid.UUID, engine: Annotated[Engine, Depends(get_engine)]) -> Any:
    with engine.connect() as conn:
        found = get_relationships(conn, sourceId)
    if found is None:
        raise Problem(404, "Not Found", "no such judgment")
    return found
