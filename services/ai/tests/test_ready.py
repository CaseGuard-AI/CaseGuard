import os

import pytest
from fastapi.testclient import TestClient

from caseguard_ai.config import get_settings


def test_ready_reports_503_when_db_unreachable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AI_DATABASE_URL", "postgresql://nobody:x@127.0.0.1:1/none")
    get_settings.cache_clear()
    r = client.get("/ready")
    assert r.status_code == 503
    assert r.json()["database"] == "down"


@pytest.mark.skipif("DATABASE_URL" not in os.environ, reason="needs a Postgres (set in CI)")
def test_ready_ok_against_real_db(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_DATABASE_URL", os.environ["DATABASE_URL"])
    get_settings.cache_clear()
    assert client.get("/ready").json() == {"status": "ok", "database": "up"}
