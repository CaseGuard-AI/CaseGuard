"""A user's own key on POST /ai/v1/research/answer (FR-SET-2, SEC-4, SEC-11, ADR-0009). No DB.

The route checks ``credential`` before any work, so these tests replace the retrieval and
storage steps (``answer_question``) with a stand-in that only calls the real ``ModelGateway``,
whose HTTP goes to an ``httpx.MockTransport``. The DB-backed path is in test_answer.py.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest
import structlog.testing
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from caseguard_ai.api import deps, v1
from caseguard_ai.config import get_settings
from caseguard_ai.gateway.client import ModelGateway
from caseguard_ai.gateway.providers import PRESET_BASE_URLS
from caseguard_ai.main import app
from caseguard_ai.research.answer import Question
from tests.conftest import TOKEN
from tests.test_answer import conforms
from tests.test_gateway import nim

KEY = "sk-user-credential-test-9f8e7d6c5b4a"
Handler = Callable[[httpx.Request], httpx.Response]


def ok(_: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200, json={"choices": [{"message": {"content": "NOT_ANSWERABLE"}, "finish_reason": "stop"}]}
    )


class Harness:
    def __init__(self, client: TestClient) -> None:
        self.client = client
        self.handler: Handler = ok
        self.sent: list[httpx.Request] = []
        self.questions: list[Question] = []

    def ask(self, **overrides: Any) -> httpx.Response:
        body: dict[str, Any] = {
            "requestId": str(uuid.uuid4()),
            "question": "What is the punishment of qatl-i-amd?",
            "scope": {
                "userId": str(uuid.uuid4()),
                "accountId": str(uuid.uuid4()),
                "allowedCaseIds": [],
            },
            "allowedProviders": ["ollama", "gemini"],
            "credential": {"providerId": "gemini", "model": "gemini-2.5-flash", "apiKey": KEY},
            **overrides,
        }
        body = {k: v for k, v in body.items() if v is not None}
        return self.client.post(
            "/ai/v1/research/answer", json=body, headers={"Authorization": f"Bearer {TOKEN}"}
        )


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch) -> Iterator[Harness]:
    monkeypatch.setenv("AI_SERVICE_TOKEN", TOKEN)
    monkeypatch.setattr("caseguard_ai.gateway.client.time.sleep", lambda s: None)
    get_settings.cache_clear()

    def fake_answer(engine: Engine, q: Question, *, gateway: ModelGateway, **_: Any) -> Any:
        # What answer_question does with the gateway: fail closed first, then generate.
        h.questions.append(q)
        gateway.provider_for("generation", q.allowed_providers, q.generation_override)
        result = gateway.chat(
            "generation",
            [{"role": "user", "content": q.question}],
            q.allowed_providers,
            override=q.generation_override,
        )
        return {
            "requestId": str(q.request_id),
            "answerable": False,
            "language": "en",
            "text": result.text,
            "citations": [],
        }

    def transport(request: httpx.Request) -> httpx.Response:
        h.sent.append(request)
        return h.handler(request)

    monkeypatch.setattr(v1, "answer_question", fake_answer)
    gateway = ModelGateway(nim(), client=httpx.Client(transport=httpx.MockTransport(transport)))
    app.dependency_overrides[deps.get_gateway] = lambda: gateway
    app.dependency_overrides[deps.get_engine] = lambda: None
    app.dependency_overrides[deps.get_embedder] = lambda: None
    app.dependency_overrides[deps.get_reranker] = lambda: None
    with TestClient(app) as client:
        h = Harness(client)
        yield h
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def is_problem(r: httpx.Response, status: int) -> None:
    assert r.status_code == status, r.text
    assert r.headers["content-type"].startswith("application/problem+json")
    conforms("Problem", r.json())
    assert KEY not in r.text


# ── routing ────────────────────────────────────────────────────────────────────────────────


def test_an_allowed_credential_goes_to_its_provider_with_the_users_key(harness: Harness) -> None:
    r = harness.ask()
    assert r.status_code == 200, r.text
    conforms("Answer", r.json())
    assert KEY not in r.text
    (request,) = harness.sent
    assert str(request.url) == f"{PRESET_BASE_URLS['gemini']}/chat/completions"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    override = harness.questions[0].generation_override
    assert override is not None and (override.id, override.model) == ("gemini", "gemini-2.5-flash")
    assert KEY not in repr(harness.questions[0])


def test_no_credential_keeps_the_configured_provider(harness: Harness) -> None:
    r = harness.ask(credential=None, allowedProviders=["nvidia-nim"])
    assert r.status_code == 200, r.text
    assert harness.questions[0].generation_override is None
    (request,) = harness.sent
    assert str(request.url) == "https://integrate.api.nvidia.com/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer nvapi-secret"


# ── refused before any model call ──────────────────────────────────────────────────────────


def cred(provider_id: str = "gemini", **extra: Any) -> dict[str, Any]:
    return {"providerId": provider_id, "model": "gemini-2.5-flash", "apiKey": KEY, **extra}


@pytest.mark.parametrize(
    ("overrides", "why"),
    [
        ({"allowedProviders": ["ollama"]}, "not in allowedProviders"),
        ({"allowedProviders": None}, "not in allowedProviders"),  # omitted = local only
        ({"allowedProviders": []}, "not in allowedProviders"),
        ({"credential": cred("mistral"), "allowedProviders": ["mistral"]}, "not a cloud provider"),
        ({"credential": cred("ollama"), "allowedProviders": ["ollama"]}, "not a cloud provider"),
    ],
)
def test_a_credential_for_a_provider_not_allowed_or_unknown_is_400(
    harness: Harness, overrides: dict[str, Any], why: str
) -> None:
    r = harness.ask(**overrides)
    is_problem(r, 400)
    assert r.json()["detail"] == f"invalid field(s): credential.providerId ({why})"
    assert harness.questions == [] and harness.sent == []


@pytest.mark.parametrize(
    ("credential", "field"),
    [
        (cred(surprise=True), "credential.surprise"),
        (cred(apiKey=""), "credential.apiKey"),
        (cred(apiKey=KEY + "x" * 512), "credential.apiKey"),
        (cred(apiKey=12345), "credential.apiKey"),
        (cred(model=""), "credential.model"),
        (cred(model="m" * 201), "credential.model"),
        (cred("Not Valid"), "credential.providerId"),
        ({"providerId": "gemini", "apiKey": KEY}, "credential.model"),
        ({"providerId": "gemini", "model": "m"}, "credential.apiKey"),
    ],
)
def test_an_invalid_credential_is_400_without_echoing_it(
    harness: Harness, credential: dict[str, Any], field: str
) -> None:
    r = harness.ask(credential=credential)
    is_problem(r, 400)
    assert r.json()["detail"] == f"invalid field(s): {field}"
    assert harness.sent == []


# ── the key is never logged ────────────────────────────────────────────────────────────────


def _timeout(request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout(f"timed out sending {request.headers}", request=request)


@pytest.mark.parametrize(
    ("handler", "status"),
    [
        (ok, 200),
        (lambda r: httpx.Response(500, text=f"upstream echoed {r.headers['authorization']}"), 503),
        (lambda r: httpx.Response(401, text=f"bad key {r.headers['authorization']}"), 503),
        (_timeout, 503),
    ],
    ids=["ok", "http-500", "http-401", "timeout"],
)
def test_the_key_is_in_no_log_and_no_response(
    harness: Harness, caplog: pytest.LogCaptureFixture, handler: Handler, status: int
) -> None:
    harness.handler = handler
    caplog.set_level(logging.DEBUG)
    with structlog.testing.capture_logs() as logs:
        r = harness.ask()
    assert r.status_code == status, r.text
    assert harness.sent and all(s.headers["authorization"] == f"Bearer {KEY}" for s in harness.sent)
    assert KEY not in r.text and KEY not in str(r.headers)
    assert KEY not in str(logs)
    assert KEY not in caplog.text
    assert all(KEY not in str(rec.args) for rec in caplog.records)
    if status == 503:
        assert r.json()["detail"] == "the model provider failed"
        assert {"event": "generation_failed", "provider": "gemini", "log_level": "warning"} in logs
    else:
        assert any(e["event"] == "llm_call" and e["model"] == "gemini-2.5-flash" for e in logs)
