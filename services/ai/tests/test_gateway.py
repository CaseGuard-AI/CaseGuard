"""Model gateway (#21): provider selection under the allow-list, request shape, failures."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from caseguard_ai.config import Settings
from caseguard_ai.gateway.client import GatewayError, ModelGateway, NoProviderError
from caseguard_ai.gateway.providers import candidates, infer_provider_id, select

NIM = "https://integrate.api.nvidia.com/v1"
GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai/"
OLLAMA = "http://localhost:11434/v1"


def settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "ai_service_token": "t",
        "llm_generation_base_url": "",
        "llm_generation_model": "",
        "llm_generation_api_key": "",
        "llm_generation_provider": "",
        "llm_judge_base_url": "",
        "llm_judge_model": "",
        "llm_judge_api_key": "",
        "llm_judge_provider": "",
        "ollama_base_url": "",
        "ollama_model": "",
    }
    base.update(overrides)
    return Settings(_env_file=None, **base)  # type: ignore[call-arg]  # pydantic-settings test hook


def nim(**extra: Any) -> Settings:
    return settings(
        llm_generation_base_url=NIM,
        llm_generation_model="nvidia/nemotron-3-super-120b-a12b",
        llm_generation_api_key="nvapi-secret",
        ollama_base_url=OLLAMA,
        ollama_model="qwen2.5:7b",
        **extra,
    )


# ── provider ids ──────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (NIM, "nvidia-nim"),
        (GEMINI, "gemini"),
        ("https://api.groq.com/openai/v1", "groq"),
        ("https://openrouter.ai/api/v1", "openrouter"),
        ("https://api.openai.com/v1", "openai"),
        ("https://api.anthropic.com/v1/", "anthropic"),
        (OLLAMA, "ollama"),
        ("http://ollama:11434/v1", "ollama"),
        ("https://llm.example.com/v1", ""),
    ],
)
def test_provider_ids_are_inferred_from_the_preset_urls(url: str, expected: str) -> None:
    assert infer_provider_id(url) == expected


def test_an_explicit_provider_tag_wins() -> None:
    s = settings(
        llm_generation_base_url="https://llm.example.com/v1",
        llm_generation_model="m",
        llm_generation_provider="OpenRouter",
    )
    assert [p.id for p in candidates(s, "generation")] == ["openrouter"]


def test_an_unnamed_endpoint_is_never_used() -> None:
    # It couldn't be matched against the Admin's allow-list, so it must not be reachable.
    s = settings(llm_generation_base_url="https://llm.example.com/v1", llm_generation_model="m")
    assert candidates(s, "generation") == []


# ── selection (SEC-11) ────────────────────────────────────────────────────────────────────


def test_the_roles_own_provider_comes_first_then_local_ollama() -> None:
    assert [p.id for p in candidates(nim(), "generation")] == ["nvidia-nim", "ollama"]


def test_an_allowed_cloud_provider_is_chosen() -> None:
    chosen = select(nim(), "generation", ["nvidia-nim", "ollama"])
    assert chosen is not None and chosen.id == "nvidia-nim"


def test_a_disallowed_cloud_provider_falls_back_to_local() -> None:
    chosen = select(nim(), "generation", ["ollama"])
    assert chosen is not None and chosen.id == "ollama"


def test_an_omitted_allow_list_means_local_only() -> None:
    chosen = select(nim(), "generation", None)
    assert chosen is not None and chosen.id == "ollama"
    no_local = settings(llm_generation_base_url=NIM, llm_generation_model="m")
    assert select(no_local, "generation", None) is None


def test_nothing_allowed_means_no_provider() -> None:
    assert select(nim(), "generation", []) is None
    assert select(nim(), "generation", ["gemini"]) is None
    with pytest.raises(NoProviderError):
        ModelGateway(nim()).provider_for("generation", ["gemini"])


def test_roles_are_configured_separately() -> None:
    s = nim(llm_judge_base_url=GEMINI, llm_judge_model="gemini-2.5-flash")
    assert [p.id for p in candidates(s, "judge")] == ["gemini", "ollama"]


# ── chat ──────────────────────────────────────────────────────────────────────────────────


def gateway(s: Settings, handler: Any) -> ModelGateway:
    return ModelGateway(s, client=httpx.Client(transport=httpx.MockTransport(handler)))


def ok(text: str = "Section 302 PPC.", finish: str = "stop") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [{"message": {"content": text}, "finish_reason": finish}],
            "usage": {"completion_tokens": 4},
        },
    )


def test_an_openai_compatible_request_is_sent_to_the_chosen_provider() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok()

    result = gateway(nim(), handler).chat(
        "generation", [{"role": "user", "content": "q"}], ["nvidia-nim"]
    )
    assert result.text == "Section 302 PPC."
    assert (result.provider_id, result.model) == ("nvidia-nim", "nvidia/nemotron-3-super-120b-a12b")
    request = seen[0]
    assert str(request.url) == "https://integrate.api.nvidia.com/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer nvapi-secret"
    body = json.loads(request.content)
    assert body["model"] == "nvidia/nemotron-3-super-120b-a12b"
    assert body["messages"] == [{"role": "user", "content": "q"}]
    assert body["temperature"] == 0.0


def test_ollama_gets_no_authorization_header() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok()

    gateway(nim(), handler).chat("generation", [{"role": "user", "content": "q"}], None)
    assert str(seen[0].url) == "http://localhost:11434/v1/chat/completions"
    assert "authorization" not in seen[0].headers


def test_one_retry_on_a_rate_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("caseguard_ai.gateway.client.time.sleep", lambda s: None)
    calls = iter([httpx.Response(429, headers={"retry-after": "2"}), ok()])
    result = gateway(nim(), lambda r: next(calls)).chat("generation", [], ["nvidia-nim"])
    assert result.text


def test_a_second_failure_is_a_gateway_error_without_the_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("caseguard_ai.gateway.client.time.sleep", lambda s: None)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="upstream echoed Bearer nvapi-secret")

    with pytest.raises(GatewayError) as err:
        gateway(nim(), handler).chat("generation", [], ["nvidia-nim"])
    assert "HTTP 503" in str(err.value)
    assert "nvapi-secret" not in str(err.value)


def test_a_client_error_is_not_retried() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(401)

    with pytest.raises(GatewayError, match="HTTP 401"):
        gateway(nim(), handler).chat("generation", [], ["nvidia-nim"])
    assert len(calls) == 1


def test_an_empty_answer_from_a_reasoning_model_is_an_error() -> None:
    with pytest.raises(GatewayError, match="whole budget reasoning"):
        gateway(nim(), lambda r: ok(text="", finish="length")).chat(
            "generation", [], ["nvidia-nim"]
        )


def test_a_connection_failure_is_a_gateway_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(GatewayError, match="cannot connect"):
        gateway(nim(), handler).chat("generation", [], ["ollama"])


def test_a_malformed_response_is_a_gateway_error() -> None:
    with pytest.raises(GatewayError, match="unexpected response"):
        gateway(nim(), lambda r: httpx.Response(200, json={"choices": []})).chat(
            "generation", [], ["nvidia-nim"]
        )


def test_the_key_is_not_in_the_provider_repr() -> None:
    chosen = select(nim(), "generation", ["nvidia-nim"])
    assert "nvapi-secret" not in repr(chosen)
