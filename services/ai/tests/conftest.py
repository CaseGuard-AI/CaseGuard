from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from caseguard_ai.config import get_settings
from caseguard_ai.main import app

TOKEN = "test-service-token"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("AI_SERVICE_TOKEN", TOKEN)
    get_settings.cache_clear()
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()
