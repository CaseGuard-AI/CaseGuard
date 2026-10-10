from fastapi.testclient import TestClient

from tests.conftest import TOKEN


def test_health_needs_no_token(client: TestClient) -> None:
    assert client.get("/health").json() == {"status": "ok"}


def test_v1_rejects_missing_token(client: TestClient) -> None:
    assert client.get("/ai/v1/info").status_code == 401


def test_v1_rejects_wrong_token(client: TestClient) -> None:
    r = client.get("/ai/v1/info", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_v1_accepts_service_token(client: TestClient) -> None:
    r = client.get("/ai/v1/info", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200
    assert r.json()["service"] == "caseguard-ai"
