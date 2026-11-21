"""GET /ai/v1/drafting/templates and POST /ai/v1/drafting/sections (#212).

The research fixtures (corpus, fake gateway, recording support checker) are reused, so drafting
runs against the same trust layer and the same store as research. Every 200 response is checked
against packages/contracts/openapi/ai.v1.yaml.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from caseguard_ai.api import deps
from caseguard_ai.config import get_settings
from caseguard_ai.drafting.catalog import templates
from caseguard_ai.ingest.embedder import HashEmbedder
from caseguard_ai.main import app
from caseguard_ai.retrieval.reranker import OverlapReranker
from tests.conftest import TOKEN
from tests.test_answer import (  # noqa: F401  (engine is a fixture)
    AI_URL,
    FakeGateway,
    RecordingSupport,
    conforms,
    engine,
    p,
)

pytestmark = pytest.mark.skipif(not AI_URL, reason="needs AI_TEST_DATABASE_URL (set in CI)")

AUTH = {"Authorization": f"Bearer {TOKEN}"}
INSTRUCTION = "Stress the confidential instruction marker zq-7781"
FIELD_VALUE = "Confidential field value zq-9932"
Reply = Callable[[str], str]


@pytest.fixture
def draft(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., Any]]:  # noqa: F811
    monkeypatch.setenv("AI_SERVICE_TOKEN", TOKEN)
    get_settings.cache_clear()
    gateways: list[FakeGateway] = []

    def _draft(reply: Reply, *, fail: bool = False, **overrides: Any) -> Any:
        gateway = FakeGateway(reply, fail=fail)
        gateways.append(gateway)
        app.dependency_overrides[deps.get_gateway] = lambda: gateway
        body = {
            "requestId": str(uuid.uuid4()),
            "templateId": "bail_application",
            "sectionKey": "grounds",
            "instruction": INSTRUCTION,
            "fields": {"offences": "s.302 PPC", "police_station": FIELD_VALUE, "unknown": "x"},
            "otherSections": [{"key": "facts", "body": "The applicant was arrested on [____]."}],
            "scope": {
                "userId": str(uuid.uuid4()),
                "accountId": str(uuid.uuid4()),
                "allowedCaseIds": [],
            },
            "allowedProviders": ["ollama"],
            **overrides,
        }
        body = {k: v for k, v in body.items() if v is not None}
        return client.post("/ai/v1/drafting/sections", json=body, headers=AUTH)

    app.dependency_overrides[deps.get_engine] = lambda: engine
    app.dependency_overrides[deps.get_embedder] = HashEmbedder
    app.dependency_overrides[deps.get_reranker] = OverlapReranker
    support = RecordingSupport()
    app.dependency_overrides[deps.get_support_checker] = lambda: support
    with TestClient(app) as client:
        _draft.client = client  # type: ignore[attr-defined]
        _draft.gateways = gateways  # type: ignore[attr-defined]
        _draft.support = support  # type: ignore[attr-defined]
        yield _draft
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def cites_302(quote: str = "be punished with death as qisas") -> Reply:
    def reply(msg: str) -> str:
        n = p(msg, "s. 302")
        return (
            "ANSWER:\n1. That the offence carries death as qisas, so the prohibitory clause "
            f'applies [[p:{n}]].\nQUOTES:\n[p:{n}] "{quote}"'
        )

    return reply


def _rows(engine: Engine, sql: str, **params: Any) -> list[Any]:  # noqa: F811
    with engine.connect() as conn:
        return list(conn.execute(text(sql), params))


def _is_problem(r: Any, status: int) -> None:
    assert r.status_code == status, r.text
    assert r.headers["content-type"].startswith("application/problem+json")
    conforms("Problem", r.json())


# ── templates ──────────────────────────────────────────────────────────────────────────────


def test_the_templates_follow_the_contract(client: TestClient) -> None:
    r = client.get("/ai/v1/drafting/templates", headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    conforms("DraftTemplateList", body)
    assert [t["id"] for t in body["items"]] == ["bail_application", "plaint", "legal_notice"]


def test_every_template_has_an_assistable_section_and_unique_keys() -> None:
    for t in templates():
        assert any(s.assistable for s in t.sections), t.id
        assert any(s.required for s in t.sections), t.id
        assert len({f.key for f in t.fields}) == len(t.fields)
        # Parties come from Case.parties as one list, so one field takes them.
        assert [f.caseField for f in t.fields].count("parties") <= 1


def test_the_bail_application_covers_s497_and_s498() -> None:
    (bail,) = [t for t in templates() if t.id == "bail_application"]
    grounds = bail.section("grounds")
    assert grounds is not None and grounds.assistable and grounds.required
    assert "s.497" in grounds.guidance and "s.498" in grounds.guidance
    assert {"cause_title", "facts", "grounds", "prayer", "affidavit"} <= {
        s.key for s in bail.sections
    }


def test_the_plaint_has_the_order_vii_particulars() -> None:
    (plaint,) = [t for t in templates() if t.id == "plaint"]
    keys = {s.key for s in plaint.sections}
    assert {"cause_of_action", "jurisdiction", "valuation", "relief", "verification"} <= keys


def test_the_templates_route_needs_the_service_token(client: TestClient) -> None:
    assert client.get("/ai/v1/drafting/templates").status_code == 401
    assert client.post("/ai/v1/drafting/sections", json={}).status_code == 401


# ── section assist ─────────────────────────────────────────────────────────────────────────


def test_a_drafted_section_carries_the_stored_statuses(draft: Any) -> None:
    draft.support.verdict = "pass"
    r = draft(cites_302())
    assert r.status_code == 200, r.text
    body = r.json()
    conforms("DraftSectionResult", body)
    (citation,) = body["citations"]
    assert f"[[c:{citation['id']}]]" in body["text"]
    assert "[[p:" not in body["text"]
    assert citation["verification"]["status"] == "verified"
    # FR-TRUST-10: the status is identical wherever the citation is read.
    stored = draft.client.get(f"/ai/v1/citations/{citation['id']}", headers=AUTH).json()
    assert stored == citation


def test_statuses_match_get_citation_for_every_outcome(draft: Any) -> None:
    for verdict, quote in (
        (None, "be punished with death as qisas"),
        ("fail", "be punished with death as qisas"),
        (None, "shall be hanged by the neck until dead"),
    ):
        draft.support.verdict = verdict
        for c in draft(cites_302(quote)).json()["citations"]:
            got = draft.client.get(f"/ai/v1/citations/{c['id']}", headers=AUTH).json()
            assert got["verification"] == c["verification"]


def test_a_failed_existence_check_is_unverified(draft: Any) -> None:
    draft.support.verdict = "pass"  # never asked: existence decides first (FR-TRUST-9)
    (citation,) = draft(cites_302("shall be hanged by the neck until dead")).json()["citations"]
    assert citation["verification"]["status"] == "unverified"
    assert citation["verification"]["checks"]["existence"] == "fail"
    assert draft.support.calls == []


def test_a_section_without_markers_is_text_without_citations(draft: Any) -> None:
    r = draft(lambda _: "ANSWER:\nThe applicant was arrested on [____] at [____].")
    assert r.status_code == 200, r.text
    body = r.json()
    conforms("DraftSectionResult", body)
    assert body == {
        "requestId": body["requestId"],
        "text": "The applicant was arrested on [____] at [____].",
        "citations": [],
    }


def test_the_model_sees_the_section_particulars_and_passages(draft: Any) -> None:
    draft(cites_302())
    (messages,) = draft.gateways[-1].calls
    user = messages[-1]["content"]
    assert "Section to draft: Grounds for bail" in user
    assert "s.497(2)" in user  # the template's guidance
    assert "Offences charged (sections, one per line): s.302 PPC" in user
    assert INSTRUCTION in user
    assert "## Brief facts" in user
    assert "unknown" not in user  # unknown field keys are ignored
    assert "[p:1] " in user


def test_one_audit_trace_per_request_without_the_instruction_or_fields(
    draft: Any,
    engine: Engine,  # noqa: F811
) -> None:
    body = draft(cites_302()).json()
    (trace,) = _rows(
        engine,
        "SELECT models, provider, row_to_json(t)::text AS j FROM ai.answer_traces t"
        " WHERE request_id = :r",
        r=body["requestId"],
    )
    assert trace.models["prompt"] == "draft-section-v1"
    assert trace.models["kind"] == "drafting"
    assert trace.models["template"] == "bail_application@1"
    assert trace.models["section"] == "grounds"
    assert trace.provider == "ollama"
    assert INSTRUCTION not in trace.j and FIELD_VALUE not in trace.j
    stored = _rows(
        engine,
        "SELECT c.claim FROM ai.citations c WHERE c.request_id = :r",
        r=body["requestId"],
    )
    assert len(stored) == len(body["citations"]) == 1
    everything = _rows(engine, "SELECT row_to_json(c)::text AS j FROM ai.citations c")
    assert all(INSTRUCTION not in row.j and FIELD_VALUE not in row.j for row in everything)


def test_a_user_credential_is_the_generation_provider(draft: Any) -> None:
    key = "user-key-drafting-test-0123456789"
    credential = {"providerId": "gemini", "model": "gemini-2.5-flash", "apiKey": key}
    r = draft(cites_302(), allowedProviders=["ollama", "gemini"], credential=credential)
    assert r.status_code == 200, r.text
    assert key not in r.text
    (override,) = draft.gateways[-1].overrides
    assert override is not None and override.api_key == key


# ── failures ───────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("section", ["cause_title", "affidavit", "no_such_section"])
def test_a_section_that_is_not_assistable_is_400(draft: Any, section: str) -> None:
    _is_problem(draft(cites_302(), sectionKey=section), 400)
    assert draft.gateways[-1].calls == []


def test_no_allowed_provider_is_503_before_any_work(draft: Any, engine: Engine) -> None:  # noqa: F811
    _is_problem(draft(cites_302(), allowedProviders=["gemini"]), 503)
    assert draft.gateways[-1].calls == []
    assert _rows(engine, "SELECT 1 FROM ai.answer_traces") == []


def test_a_failing_provider_is_503(draft: Any) -> None:
    _is_problem(draft(cites_302(), fail=True), 503)


@pytest.mark.parametrize(
    "overrides",
    [
        {"templateId": "will"},
        {"sectionKey": "Grounds"},
        {"instruction": "x" * 2001},
        {"fields": {"court": "x" * 4001}},
        {"otherSections": [{"key": "facts", "body": "x"}] * 31},
        {"scope": None},
        {"allowedProviders": ["ollama", "ollama"]},
        {"credential": {"providerId": "ollama", "model": "m", "apiKey": "k"}},
        {"credential": {"providerId": "gemini", "model": "m", "apiKey": "k"}},
        {"surprise": True},
    ],
)
def test_invalid_requests_are_400(draft: Any, overrides: dict[str, Any]) -> None:
    r = draft(cites_302(), **overrides)
    _is_problem(r, 400)
    assert INSTRUCTION not in r.text  # the instruction is never echoed
