"""POST /ai/v1/research/answer and the citation / source routes (#20).

A fake gateway plays the model; HashEmbedder and OverlapReranker stand in for bge-m3 and the
cross-encoder. Every 200 response is checked against packages/contracts/openapi/ai.v1.yaml.
"""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from sqlalchemy import Engine, create_engine, text

from caseguard_ai.api import deps
from caseguard_ai.config import _sqlalchemy_url, get_settings
from caseguard_ai.gateway.client import ChatResult, GatewayError, NoProviderError
from caseguard_ai.gateway.providers import ProviderConfig
from caseguard_ai.ingest.embed import run
from caseguard_ai.ingest.embedder import HashEmbedder
from caseguard_ai.ingest.load import load
from caseguard_ai.main import app
from caseguard_ai.retrieval.reranker import OverlapReranker
from tests.conftest import TOKEN
from tests.test_load import judgment, record

AI_URL = os.environ.get("AI_TEST_DATABASE_URL")
SERVICE_DIR = Path(__file__).resolve().parents[1]
CONTRACT = SERVICE_DIR.parents[1] / "packages" / "contracts" / "openapi" / "ai.v1.yaml"

pytestmark = pytest.mark.skipif(not AI_URL, reason="needs AI_TEST_DATABASE_URL (set in CI)")

PPC = (
    "WHEREAS it is expedient; It is hereby enacted as follows:__\n"
    "301. Culpable homicide by causing death of person other than person intended.\n"
    "302. Punishment of qatl-i-amd. Whoever commits qatl-i-amd shall,\n"
    "subject to the provisions of this Chapter, be punished with death as qisas.\n"
    "303. Qatl committed under the influence of extreme provocation. Whoever commits qatl.\n"
)
CRPC = (
    "WHEREAS it is expedient; It is hereby enacted as follows:__\n"
    "496. In what cases bail to be taken. When any person other than a person accused of a "
    "non-bailable offence is arrested he shall be released on bail.\n"
    "497. When bail may be taken in case of non-bailable offence. Such person may be released.\n"
)
HEADNOTE = "Qatl-i-amd bail refused (Applicant) VS The State. Bail in qatl-i-amd case refused."

Reply = Callable[[str], str]  # user message -> model reply


# ── the contract ───────────────────────────────────────────────────────────────────────────

_DOC = yaml.safe_load(CONTRACT.read_text(encoding="utf-8"))


def conforms(name: str, body: Any) -> None:
    schema = {"$ref": f"#/components/schemas/{name}", "components": _DOC["components"]}
    validator = Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)
    errors = sorted(validator.iter_errors(body), key=str)
    assert not errors, [e.message for e in errors]


# ── fakes ──────────────────────────────────────────────────────────────────────────────────


class FakeGateway:
    """The gateway's interface: an allow-list check, then a scripted reply."""

    def __init__(self, reply: Reply, *, fail: bool = False) -> None:
        self.reply, self.fail = reply, fail
        self.calls: list[list[dict[str, str]]] = []
        self.overrides: list[ProviderConfig | None] = []

    def provider_for(
        self, role: str, allowed: list[str] | None, override: ProviderConfig | None = None
    ) -> object:
        if override is not None and role == "generation":
            if override.id not in (allowed or []):
                raise NoProviderError(role)  # type: ignore[arg-type]
            return override
        if "ollama" not in (allowed or ["ollama"]):
            raise NoProviderError(role)  # type: ignore[arg-type]
        return object()

    def chat(
        self,
        role: str,
        messages: list[dict[str, str]],
        allowed: list[str] | None,
        *,
        override: ProviderConfig | None = None,
    ) -> ChatResult:
        self.provider_for(role, allowed, override)
        self.calls.append(messages)
        self.overrides.append(override)
        provider, model = (override.id, override.model) if override else ("ollama", "qwen2.5:7b")
        if self.fail:
            raise GatewayError(provider, "HTTP 500")
        return ChatResult(self.reply(messages[-1]["content"]), provider, model, 5, "stop", {})


def p(user_message: str, heading: str) -> int:
    """The number the prompt gave the passage whose heading contains ``heading``."""
    for n, line in re.findall(r"^\[p:(\d+)\] (.*)$", user_message, re.M):
        if heading in line:
            return int(n)
    raise AssertionError(f"{heading!r} was not among the passages")


# ── fixtures ───────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def engine() -> Iterator[Engine]:
    url = _sqlalchemy_url(AI_URL or "")
    cfg = Config(str(SERVICE_DIR / "alembic.ini"))
    cfg.attributes["url"] = url
    command.upgrade(cfg, "head")
    eng = create_engine(url)
    reset = "TRUNCATE corpus.documents, corpus.corpus_meta, ai.answer_traces CASCADE"
    with eng.begin() as conn:
        conn.execute(text(reset))
    load(
        eng,
        [
            record(full_text=PPC, content_hash="h-ppc"),
            record(
                id="pakistan_code-crpc",
                title="Code of Criminal Procedure, 1898",
                source_url="https://pakistancode.gov.pk/english/crpc-sg-jjj",
                full_text=CRPC,
                content_hash="h-crpc",
            ),
            judgment(7, full_text=HEADNOTE, content_hash="h-hn", raw={"headnote_only": True}),
        ],
        "p@1",
    )
    run(eng, HashEmbedder())
    yield eng
    with eng.begin() as conn:
        conn.execute(text(reset))
    eng.dispose()


@pytest.fixture
def ask(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., Any]]:
    monkeypatch.setenv("AI_SERVICE_TOKEN", TOKEN)
    get_settings.cache_clear()
    gateways: list[FakeGateway] = []

    def _ask(reply: Reply, *, fail: bool = False, **overrides: Any) -> Any:
        gateway = FakeGateway(reply, fail=fail)
        gateways.append(gateway)
        app.dependency_overrides[deps.get_gateway] = lambda: gateway
        body = {
            "requestId": str(uuid.uuid4()),
            "question": "What is the punishment of qatl-i-amd?",
            "scope": {
                "userId": str(uuid.uuid4()),
                "accountId": str(uuid.uuid4()),
                "allowedCaseIds": [],
            },
            "allowedProviders": ["ollama"],
            **overrides,
        }
        body = {k: v for k, v in body.items() if v is not None}
        return client.post(
            "/ai/v1/research/answer", json=body, headers={"Authorization": f"Bearer {TOKEN}"}
        )

    app.dependency_overrides[deps.get_engine] = lambda: engine
    app.dependency_overrides[deps.get_embedder] = HashEmbedder
    app.dependency_overrides[deps.get_reranker] = OverlapReranker
    with TestClient(app) as client:
        _ask.client = client  # type: ignore[attr-defined]
        _ask.gateways = gateways  # type: ignore[attr-defined]
        yield _ask
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def get(ask: Any, path: str) -> Any:
    return ask.client.get(path, headers={"Authorization": f"Bearer {TOKEN}"})


def cites_302(quote: str = "be punished with death as qisas") -> Reply:
    def reply(msg: str) -> str:
        n = p(msg, "s. 302")
        return f'ANSWER:\nQatl-i-amd is punished with death as qisas [[p:{n}]].\nQUOTES:\n[p:{n}] "{quote}"'

    return reply


def _rows(engine: Engine, sql: str, **params: Any) -> list[Any]:
    with engine.connect() as conn:
        return list(conn.execute(text(sql), params))


# ── answers ────────────────────────────────────────────────────────────────────────────────


def test_an_answer_with_a_checked_citation(ask: Any, engine: Engine) -> None:
    # The quote spans the PDF's line break in s. 302; it still resolves, to the source's text.
    r = ask(cites_302("shall, subject to the provisions of this Chapter, be punished"))
    assert r.status_code == 200, r.text
    body = r.json()
    conforms("Answer", body)
    assert body["answerable"] is True and body["language"] == "en"
    (citation,) = body["citations"]
    assert body["text"] == f"Qatl-i-amd is punished with death as qisas [[c:{citation['id']}]]."
    assert citation["locator"] == "s. 302"
    assert citation["quote"] == "shall,\nsubject to the provisions of this Chapter, be punished"
    assert citation["quoteLanguage"] == "en"
    assert citation["claim"] == "Qatl-i-amd is punished with death as qisas."
    # M1: the support check is not run, so nothing is "verified" (FR-TRUST-8).
    assert citation["verification"]["status"] == "needs_review"
    assert citation["verification"]["checks"]["existence"] == "pass"
    assert citation["verification"]["checks"]["support"] == "not_run"


def test_one_trace_and_one_verification_per_citation_are_stored(ask: Any, engine: Engine) -> None:
    body = ask(cites_302()).json()
    (trace,) = _rows(
        engine, "SELECT * FROM ai.answer_traces WHERE request_id = :r", r=body["requestId"]
    )
    assert trace.answerable and trace.provider == "ollama"
    assert trace.dense and trace.sparse and trace.fused and trace.reranked  # FR-RES-2
    assert trace.models["prompt"] == "answer-v1" and trace.models["generation"] == "qwen2.5:7b"
    counts = _rows(
        engine,
        "SELECT count(*) AS n, count(v.citation_id) AS v FROM ai.citations c"
        " LEFT JOIN ai.verifications v ON v.citation_id = c.id WHERE c.request_id = :r",
        r=body["requestId"],
    )[0]
    assert (counts.n, counts.v) == (1, 1)  # FR-TRUST-2 / FR-TRUST-4


def test_the_question_is_never_stored(ask: Any, engine: Engine) -> None:
    ask(cites_302(), question="What is the punishment of qatl-i-amd zebraquokka?")
    dump = _rows(engine, "SELECT row_to_json(t)::text AS j FROM ai.answer_traces t")
    assert dump and all("zebraquokka" not in row.j for row in dump)


def test_a_fabricated_quote_is_unverified(ask: Any) -> None:
    body = ask(cites_302("shall be hanged by the neck until dead")).json()
    (citation,) = body["citations"]
    assert citation["verification"]["status"] == "unverified"
    assert citation["verification"]["checks"]["existence"] == "fail"
    assert (
        citation["verification"]["checks"]["existence_reason"]
        == "the quote is not in the cited passage"
    )
    assert "quote" not in citation


def test_a_quote_from_another_passage_is_unverified(ask: Any) -> None:
    # Words that are in the corpus (CrPC s. 496), but not in the passage the model cited.
    body = ask(cites_302("he shall be released on bail")).json()
    assert body["citations"][0]["verification"]["status"] == "unverified"


def test_a_marker_for_a_passage_never_shown_is_dropped(ask: Any, engine: Engine) -> None:
    def reply(msg: str) -> str:
        n = p(msg, "s. 302")
        return (
            f"ANSWER:\nQatl-i-amd is punished with death [[p:{n}]]. It is also a crime [[p:99]].\n"
            f'QUOTES:\n[p:{n}] "be punished with death as qisas"\n[p:99] "made up"'
        )

    body = ask(reply).json()
    conforms("Answer", body)
    assert len(body["citations"]) == 1 and "[[p:" not in body["text"]
    assert body["text"].endswith("It is also a crime.")
    (trace,) = _rows(
        engine, "SELECT models FROM ai.answer_traces WHERE request_id = :r", r=body["requestId"]
    )
    assert trace.models["invalid_markers"] == 1


def test_a_headnote_only_source_is_flagged(ask: Any) -> None:
    def reply(msg: str) -> str:
        n = p(msg, "head-note only")
        return f'ANSWER:\nBail was refused in a qatl-i-amd case [[p:{n}]].\nQUOTES:\n[p:{n}] "Bail in qatl-i-amd case refused"'

    body = ask(reply, question="bail refused in qatl-i-amd case").json()
    assert body["citations"][0]["verification"]["flags"] == ["headnote_only"]
    assert body["citations"][0]["verification"]["status"] == "needs_review"


@pytest.mark.parametrize(
    "reply", ["NOT_ANSWERABLE", "ANSWER:\nIt depends on the facts.\nQUOTES:\n"]
)
def test_unanswerable_answers_carry_no_citations(ask: Any, engine: Engine, reply: str) -> None:
    body = ask(lambda _msg: reply).json()
    conforms("Answer", body)
    assert (body["answerable"], body["citations"]) == (False, [])
    assert body["text"]
    (trace,) = _rows(
        engine, "SELECT answerable FROM ai.answer_traces WHERE request_id = :r", r=body["requestId"]
    )
    assert trace.answerable is False
    assert (
        _rows(engine, "SELECT 1 FROM ai.citations WHERE request_id = :r", r=body["requestId"]) == []
    )


def test_nothing_retrieved_is_unanswerable_without_calling_the_model(
    ask: Any, engine: Engine
) -> None:
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM corpus.chunks"))
    body = ask(cites_302()).json()
    assert body["answerable"] is False
    assert ask.gateways[-1].calls == []


def test_the_status_shown_is_the_stored_one(ask: Any, engine: Engine) -> None:
    citation = ask(cites_302()).json()["citations"][0]
    fetched = get(ask, f"/ai/v1/citations/{citation['id']}").json()
    conforms("Citation", fetched)
    assert fetched == citation
    # Change the store directly: every reader follows it, nothing recomputes (FR-TRUST-10).
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE ai.verifications SET status = 'unverified' WHERE citation_id = :c"),
            {"c": citation["id"]},
        )
    assert (
        get(ask, f"/ai/v1/citations/{citation['id']}").json()["verification"]["status"]
        == "unverified"
    )


def test_a_retried_request_id_replaces_its_earlier_answer(ask: Any, engine: Engine) -> None:
    request_id = str(uuid.uuid4())
    first = ask(cites_302(), requestId=request_id).json()
    second = ask(cites_302(), requestId=request_id).json()
    assert first["citations"][0]["id"] != second["citations"][0]["id"]
    rows = _rows(engine, "SELECT id FROM ai.citations WHERE request_id = :r", r=request_id)
    assert [str(r.id) for r in rows] == [second["citations"][0]["id"]]


def test_the_model_sees_numbered_passages_and_the_history(ask: Any) -> None:
    history = [
        {"role": "user", "content": "Earlier question"},
        {"role": "assistant", "content": "Earlier answer"},
    ]
    ask(cites_302(), history=history)
    messages = ask.gateways[-1].calls[0]
    assert messages[0]["role"] == "system" and "NOT_ANSWERABLE" in messages[0]["content"]
    assert [m["content"] for m in messages[1:3]] == ["Earlier question", "Earlier answer"]
    assert "[p:1] " in messages[-1]["content"]
    assert "Question: What is the punishment of qatl-i-amd?" in messages[-1]["content"]


def test_a_user_credential_is_the_generation_provider(ask: Any, engine: Engine) -> None:
    key = "user-key-answer-test-0123456789"
    credential = {"providerId": "gemini", "model": "gemini-2.5-flash", "apiKey": key}
    r = ask(cites_302(), allowedProviders=["ollama", "gemini"], credential=credential)
    assert r.status_code == 200, r.text
    body = r.json()
    conforms("Answer", body)
    assert key not in r.text
    (override,) = ask.gateways[-1].overrides
    assert override is not None
    assert (override.id, override.model, override.api_key) == ("gemini", "gemini-2.5-flash", key)
    (trace,) = _rows(
        engine,
        "SELECT provider, models, row_to_json(t)::text AS j FROM ai.answer_traces t"
        " WHERE request_id = :r",
        r=body["requestId"],
    )
    assert trace.provider == "gemini" and trace.models["generation"] == "gemini-2.5-flash"
    assert key not in trace.j  # the trace never holds the key


def test_without_a_credential_there_is_no_override(ask: Any) -> None:
    ask(cites_302())
    assert ask.gateways[-1].overrides == [None]


# ── failures ───────────────────────────────────────────────────────────────────────────────


def _is_problem(r: Any, status: int) -> None:
    assert r.status_code == status, r.text
    assert r.headers["content-type"].startswith("application/problem+json")
    conforms("Problem", r.json())


def test_no_allowed_provider_is_503_before_any_work(ask: Any, engine: Engine) -> None:
    r = ask(cites_302(), allowedProviders=["gemini"])
    _is_problem(r, 503)
    assert ask.gateways[-1].calls == []
    assert _rows(engine, "SELECT 1 FROM ai.answer_traces") == []


def test_a_failing_provider_is_503(ask: Any) -> None:
    _is_problem(ask(cites_302(), fail=True), 503)


def test_a_corpus_that_is_not_embedded_is_503(ask: Any, engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE corpus.corpus_meta"))
    _is_problem(ask(cites_302()), 503)


@pytest.mark.parametrize(
    "overrides",
    [
        {"scope": None},
        {"question": ""},
        {"question": "x" * 4001},
        {"language": "fr"},
        {"allowedProviders": ["Not Valid"]},
        {"allowedProviders": ["ollama", "ollama"]},
        {"surprise": True},
    ],
)
def test_invalid_requests_are_400(ask: Any, overrides: dict[str, Any]) -> None:
    r = ask(cites_302(), **overrides)
    _is_problem(r, 400)
    assert "What is the punishment" not in r.text  # the question is never echoed


# ── sources and citations ──────────────────────────────────────────────────────────────────


def test_a_cited_source_can_be_fetched(ask: Any) -> None:
    citation = ask(cites_302()).json()["citations"][0]
    source = get(ask, f"/ai/v1/sources/{citation['sourceId']}").json()
    conforms("Source", source)
    assert source["kind"] == "statute" and source["title"] == "Pakistan Penal Code, 1860"
    assert source["officialUrl"].startswith("https://pakistancode.gov.pk/")
    assert (source["thirdParty"], source["headnoteOnly"], source["sourceTier"]) == (False, False, 1)


def test_unknown_ids_are_404(ask: Any) -> None:
    ask(cites_302())
    _is_problem(get(ask, f"/ai/v1/citations/{uuid.uuid4()}"), 404)
    _is_problem(get(ask, f"/ai/v1/sources/{uuid.uuid4()}"), 404)


def test_the_routes_need_the_service_token(ask: Any) -> None:
    assert ask.client.post("/ai/v1/research/answer", json={}).status_code == 401
    assert ask.client.get(f"/ai/v1/citations/{uuid.uuid4()}").status_code == 401
