"""FastAPI entry point: `uv run uvicorn caseguard_ai.main:app --reload --port 8000`."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import psycopg
from fastapi import FastAPI, Response, status
from sqlalchemy import Engine

from caseguard_ai import __version__
from caseguard_ai.api import deps, problems
from caseguard_ai.api.ingestion import router as ingestion_router
from caseguard_ai.api.precedents import router as precedents_router
from caseguard_ai.api.v1 import router as v1_router
from caseguard_ai.config import get_document_settings, get_settings
from caseguard_ai.ingest.embedder import Embedder
from caseguard_ai.ingest.ingestion import Worker
from caseguard_ai.linter.router import router as lint_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Starts the document ingestion worker (#253) unless INGEST_WORKERS_ENABLED is false. It
    uses the same engine and embedder as the routes, test overrides included."""
    settings = get_document_settings()
    worker = None
    if settings.ingest_workers_enabled:

        def engine() -> Engine:
            made: Engine = app.dependency_overrides.get(deps.get_engine, deps.get_engine)()
            return made

        def embedder() -> Embedder:
            made: Embedder = app.dependency_overrides.get(deps.get_embedder, deps.get_embedder)()
            return made

        worker = Worker(engine, embedder, settings)
        worker.start()
    try:
        yield
    finally:
        if worker:
            await worker.close()


app = FastAPI(title="CaseGuard AI (internal)", version=__version__, lifespan=lifespan)
problems.install(app)
app.include_router(v1_router)
app.include_router(lint_router)
app.include_router(precedents_router)
app.include_router(ingestion_router)


@app.get("/health", tags=["ops"])
def health() -> dict[str, str]:
    """Liveness: the process is up. No dependencies checked."""
    return {"status": "ok"}


@app.get("/ready", tags=["ops"])
def ready(response: Response) -> dict[str, str]:
    """Readiness: the database is reachable as caseguard_ai."""
    try:
        with psycopg.connect(get_settings().psycopg_dsn, connect_timeout=3) as conn:
            conn.execute("SELECT 1")
    except psycopg.Error:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "unavailable", "database": "down"}
    return {"status": "ok", "database": "up"}
