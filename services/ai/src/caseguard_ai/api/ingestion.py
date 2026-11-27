"""The ai.v1 `ingestion` routes (#253, ADR-0010): submit, poll and purge a user's document.

Only apps/api calls these. The work runs in the background worker (ingest/ingestion.py), never
in the request (SEC-6), so every route answers from ``ai.ingestions`` at once.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Engine
from sqlalchemy.exc import OperationalError

from caseguard_ai.api.deps import get_engine
from caseguard_ai.api.problems import Problem
from caseguard_ai.api.v1 import ScopeIn
from caseguard_ai.ingest import ingestion
from caseguard_ai.security import require_service_token

router = APIRouter(
    prefix="/ai/v1/documents",
    tags=["ingestion"],
    dependencies=[Depends(require_service_token)],
)

MediaType = Literal[
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/png",
    "image/jpeg",
    "image/tiff",
]


class IngestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: ScopeIn
    caseId: uuid.UUID
    storageKey: Annotated[
        str, Field(pattern=r"^users/[0-9a-f-]{36}/cases/[0-9a-f-]{36}/[0-9a-f-]{36}$")
    ]
    mediaType: MediaType
    filename: Annotated[str, Field(min_length=1, max_length=255)]
    attempt: Annotated[int, Field(ge=1)]


def _unavailable(exc: OperationalError) -> Problem:
    return Problem(503, "Service Unavailable", "the database is unavailable")


@router.post("/{documentId}/ingestion", status_code=status.HTTP_202_ACCEPTED)
def start_ingestion(
    documentId: uuid.UUID,
    body: IngestionRequest,
    engine: Annotated[Engine, Depends(get_engine)],
) -> Any:
    user = body.scope.userId
    if body.storageKey != f"users/{user}/cases/{body.caseId}/{documentId}":
        raise Problem(400, "Bad Request", "storageKey does not match the document")
    if body.scope.allowedCaseIds != [body.caseId]:
        raise Problem(400, "Bad Request", "scope.allowedCaseIds must be exactly [caseId]")
    try:
        found = ingestion.submit(
            engine,
            ingestion.Submission(
                document_id=documentId,
                attempt=body.attempt,
                user_id=user,
                case_id=body.caseId,
                storage_key=body.storageKey,
                media_type=body.mediaType,
                filename=body.filename,
            ),
        )
    except ingestion.StaleAttempt as exc:
        raise Problem(409, "Conflict", "a later attempt has been submitted") from exc
    except OperationalError as exc:
        raise _unavailable(exc) from exc
    return JSONResponse(found, status_code=status.HTTP_202_ACCEPTED)


@router.get("/{documentId}/ingestion")
def get_ingestion(documentId: uuid.UUID, engine: Annotated[Engine, Depends(get_engine)]) -> Any:
    try:
        found = ingestion.status(engine, documentId)
    except OperationalError as exc:
        raise _unavailable(exc) from exc
    if found is None:
        raise Problem(404, "Not Found", "nothing was submitted for this document")
    return found


@router.delete("/{documentId}", status_code=status.HTTP_204_NO_CONTENT)
def purge_document(
    documentId: uuid.UUID, engine: Annotated[Engine, Depends(get_engine)]
) -> Response:
    try:
        ingestion.purge(engine, documentId)
    except OperationalError as exc:
        raise _unavailable(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
