"""``pnpm research:ask``: the terminal front to the answer path (#191).

The corpus, embedder and reranker are the ones from ``test_answer``; the gateway is the real
``RecordingGateway`` with its HTTP call replaced by a scripted OpenAI-shaped reply, so the
provider selection, the allow-list and the recording are exercised for real.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Iterator
from typing import Any

import pytest
import structlog
from sqlalchemy import Engine

from caseguard_ai.api import deps
from caseguard_ai.config import get_settings
from caseguard_ai.gateway.providers import ProviderConfig
from caseguard_ai.ingest.embedder import HashEmbedder
from caseguard_ai.research import ask_cli
from caseguard_ai.retrieval.reranker import OverlapReranker
from tests.conftest import TOKEN
from tests.test_answer import RecordingSupport, cites_302, engine, p  # noqa: F401  # fixture

pytestmark = pytest.mark.skipif(
    not os.environ.get("AI_TEST_DATABASE_URL"), reason="needs AI_TEST_DATABASE_URL (set in CI)"
)

Reply = Callable[[str], str]


class ScriptedGateway(ask_cli.RecordingGateway):
    """The real gateway, answering from a script instead of the network."""

    def __init__(self, settings: Any, reply: Reply) -> None:
        super().__init__(settings)
        self.reply = reply
        self.posted: list[dict[str, Any]] = []

    def _post(self, provider: ProviderConfig, body: dict[str, Any]) -> dict[str, Any]:
        self.posted.append(body)
        text = self.reply(body["messages"][-1]["content"])
        return {
            "choices": [{"message": {"content": text}, "finish_reason": "stop"}],
            "usage": {"completion_tokens": 42},
        }


@pytest.fixture
def cli(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., Any]]:  # noqa: F811
    monkeypatch.setenv("AI_SERVICE_TOKEN", TOKEN)  # Settings needs it; CI has no .env
    # One configured provider: Ollama, so the allow-list has something to refuse (nvidia-nim).
    monkeypatch.setenv("LLM_GENERATION_BASE_URL", "http://127.0.0.1:11434/v1")
    monkeypatch.setenv("LLM_GENERATION_MODEL", "qwen2.5:7b")
    monkeypatch.setenv("LLM_GENERATION_API_KEY", "")
    monkeypatch.setenv("LLM_GENERATION_PROVIDER", "")
    get_settings.cache_clear()
    gateways: list[ScriptedGateway] = []
    support = RecordingSupport()
    monkeypatch.setattr(deps, "get_engine", lambda: engine)
    monkeypatch.setattr(deps, "get_embedder", HashEmbedder)
    monkeypatch.setattr(deps, "get_reranker", OverlapReranker)
    monkeypatch.setattr(deps, "get_support_checker", lambda: support)

    def _run(reply: Reply, *argv: str) -> int:
        def build(settings: Any) -> ScriptedGateway:
            gateway = ScriptedGateway(settings, reply)
            gateways.append(gateway)
            return gateway

        monkeypatch.setattr(ask_cli, "build_gateway", build)
        return ask_cli.main(["--", "What is the punishment of qatl-i-amd?", *argv])

    _run.gateways = gateways  # type: ignore[attr-defined]
    yield _run
    get_settings.cache_clear()
    structlog.reset_defaults()  # main() points logs at stderr


def test_prints_the_answer_its_citations_and_the_raw_reply(
    cli: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli(cites_302()) == 0
    out = capsys.readouterr().out
    assert "llm_call" not in out  # logs go to stderr
    assert "Model: ollama qwen2.5:7b" in out and "finish=stop" in out and "tokens=42" in out
    assert "Answerable: yes" in out
    assert "Qatl-i-amd is punished with death as qisas [[c:" in out
    assert "Citations (1):" in out
    assert "1. verified  s. 302  existence=pass support=pass" in out
    assert 'quote: "be punished with death as qisas"' in out
    assert "invalid_markers=0" in out and "prompt=answer-v1" in out
    # The raw reply is shown as the model wrote it, markers and all.
    assert "Raw model reply:" in out and "QUOTES:\n[p:" in out
    # The gateway was asked the way the route asks: the answer prompt at temperature 0.
    (gateway,) = cli.gateways
    assert gateway.posted[0]["temperature"] == 0.0
    assert gateway.posted[0]["messages"][-1]["content"].startswith("Question:") or (
        "[p:1]" in gateway.posted[0]["messages"][-1]["content"]
    )


def test_json_output_carries_the_response_the_trace_and_the_generation(
    cli: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli(cites_302(), "--json", "--show-prompt") == 0
    body = json.loads(capsys.readouterr().out)
    assert body["response"]["answerable"] is True
    assert len(body["response"]["citations"]) == 1
    assert body["trace"]["reranked"] >= 1 and body["trace"]["models"]["invalid_markers"] == 0
    assert body["generation"]["provider"] == "ollama"
    assert body["generation"]["finishReason"] == "stop"
    assert body["generation"]["rawReply"].startswith("ANSWER:")
    assert body["prompt"][-1]["role"] == "user" and "[p:1]" in body["prompt"][-1]["content"]


def test_not_answerable_is_reported_not_failed(
    cli: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli(lambda _msg: "NOT_ANSWERABLE") == 0
    out = capsys.readouterr().out
    assert "Answerable: no" in out and "Citations (0):" in out
    assert "Raw model reply:\n---\nNOT_ANSWERABLE\n---" in out


def test_markers_at_unknown_passages_are_counted(
    cli: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    def reply(msg: str) -> str:
        n = p(msg, "s. 302")
        return (
            f"ANSWER:\nDeath as qisas [[p:{n}]]. Also something [[p:99]].\n"
            f'QUOTES:\n[p:{n}] "be punished with death as qisas"'
        )

    assert cli(reply) == 0
    out = capsys.readouterr().out
    assert "Citations (1):" in out and "invalid_markers=1" in out


def test_a_provider_outside_the_allow_list_fails_closed(
    cli: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli(cites_302(), "--providers", "nvidia-nim") == 2
    err = capsys.readouterr().err
    assert err.startswith("FAIL  no generation provider")
    assert cli.gateways[-1].posted == []  # nothing was sent anywhere
