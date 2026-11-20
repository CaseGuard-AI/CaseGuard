"""FastAPI entry point: `uv run uvicorn caseguard_ai.main:app --reload --port 8000`."""

import psycopg
from fastapi import FastAPI, Response, status

from caseguard_ai import __version__
from caseguard_ai.api import problems
from caseguard_ai.api.v1 import router as v1_router
from caseguard_ai.config import get_settings
from caseguard_ai.linter.router import router as lint_router

app = FastAPI(title="CaseGuard AI (internal)", version=__version__)
problems.install(app)
app.include_router(v1_router)
app.include_router(lint_router)


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
