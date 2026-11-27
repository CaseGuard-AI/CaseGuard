"""Model gateway (#21): provider selection under the allow-list, request shape, failures."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import structlog.testing

from caseguard_ai.config import Settings
from caseguard_ai.gateway.client import GatewayError, ModelGateway, NoProviderError
from caseguard_ai.gateway.providers import (
    _HOSTS,
    LOCAL_PROVIDERS,
    PRESET_BASE_URLS,
    candidates,
    from_credential,
    infer_provider_id,
    select,
)

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


def _sent_budgets(s: Settings, *calls: tuple[str, int | None]) -> list[int]:
    seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content)["max_tokens"])
        return ok()

    gw = gateway(s, handler)
    for role, budget in calls:
        kwargs = {} if budget is None else {"max_tokens": budget}
        gw.chat(role, [], ["nvidia-nim"], **kwargs)  # type: ignore[arg-type]
    return seen


def test_the_default_budgets_leave_room_for_a_reasoning_model() -> None:
    # Reasoning models spend ~1,000 tokens thinking before the first word of the answer (#244).
    s = nim(llm_judge_base_url=NIM, llm_judge_model="m")
    assert _sent_budgets(s, ("generation", None), ("judge", None)) == [4096, 1024]


def test_each_role_uses_its_configured_budget() -> None:
    s = nim(
        llm_judge_base_url=NIM,
        llm_judge_model="m",
        llm_generation_max_tokens=8000,
        llm_judge_max_tokens=300,
    )
    assert _sent_budgets(s, ("generation", None), ("judge", None)) == [8000, 300]


def test_a_callers_budget_wins() -> None:
    assert _sent_budgets(nim(), ("generation", 50)) == [50]


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


# ── a user's own key (FR-SET-2) ───────────────────────────────────────────────────────────

USER_KEY = "user-key-gateway-test-0123456789"


@pytest.mark.parametrize(("provider_id", "base_url"), sorted(PRESET_BASE_URLS.items()))
def test_each_preset_url_infers_back_to_its_id(provider_id: str, base_url: str) -> None:
    assert infer_provider_id(base_url) == provider_id
    assert provider_id not in LOCAL_PROVIDERS


def test_every_known_cloud_host_has_a_preset() -> None:
    assert set(PRESET_BASE_URLS) == {infer_provider_id(f"https://{h}/") for h in _HOSTS}


@pytest.mark.parametrize("provider_id", ["ollama", "mistral", ""])
def test_only_a_preset_cloud_provider_takes_a_credential(provider_id: str) -> None:
    with pytest.raises(ValueError, match="not a known cloud provider") as err:
        from_credential(provider_id, "m", USER_KEY)
    assert USER_KEY not in str(err.value)


def test_a_credential_provider_hides_its_key() -> None:
    provider = from_credential("groq", "llama-3.3-70b-versatile", USER_KEY)
    assert provider.base_url == "https://api.groq.com/openai/v1"
    assert USER_KEY not in repr(provider)


def test_an_override_sends_the_users_key_and_model_to_the_preset() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok()

    override = from_credential("gemini", "gemini-2.5-flash", USER_KEY)
    result = gateway(nim(), handler).chat(
        "generation",
        [{"role": "user", "content": "q"}],
        ["nvidia-nim", "gemini"],
        override=override,
    )
    assert (result.provider_id, result.model) == ("gemini", "gemini-2.5-flash")
    (request,) = seen
    assert str(request.url) == f"{PRESET_BASE_URLS['gemini']}/chat/completions"
    assert request.headers["authorization"] == f"Bearer {USER_KEY}"
    assert json.loads(request.content)["model"] == "gemini-2.5-flash"


def test_without_an_override_the_configured_provider_is_used() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok()

    gw = gateway(nim(), handler)
    gw.chat("generation", [], ["nvidia-nim", "gemini"], override=None)
    assert str(seen[0].url) == "https://integrate.api.nvidia.com/v1/chat/completions"
    assert seen[0].headers["authorization"] == "Bearer nvapi-secret"


@pytest.mark.parametrize("allowed", [["nvidia-nim"], [], None])
def test_an_override_outside_the_allow_list_is_refused(allowed: list[str] | None) -> None:
    calls: list[httpx.Request] = []
    override = from_credential("gemini", "gemini-2.5-flash", USER_KEY)
    gw = gateway(nim(), lambda r: calls.append(r) or ok())
    with pytest.raises(NoProviderError) as err:
        gw.chat("generation", [], allowed, override=override)
    assert calls == []
    assert USER_KEY not in str(err.value)


def test_an_override_is_for_the_generation_role_only() -> None:
    s = nim(
        llm_judge_base_url=GEMINI, llm_judge_model="gemini-2.5-flash", llm_judge_api_key="env-key"
    )
    override = from_credential("groq", "llama-3.3-70b-versatile", USER_KEY)
    chosen = gateway(s, lambda r: ok()).provider_for("judge", ["gemini", "groq"], override)
    assert (chosen.id, chosen.api_key) == ("gemini", "env-key")


@pytest.mark.parametrize("failure", ["http-500", "http-401", "timeout", "connect"])
def test_a_failing_override_never_shows_the_key(
    failure: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("caseguard_ai.gateway.client.time.sleep", lambda s: None)

    def handler(request: httpx.Request) -> httpx.Response:
        if failure == "timeout":
            raise httpx.ReadTimeout(f"timed out {request.headers}", request=request)
        if failure == "connect":
            raise httpx.ConnectError("refused", request=request)
        status = 500 if failure == "http-500" else 401
        return httpx.Response(status, text=f"echo {request.headers['authorization']}")

    override = from_credential("openai", "gpt-4o-mini", USER_KEY)
    with structlog.testing.capture_logs() as logs, pytest.raises(GatewayError) as err:
        gateway(nim(), handler).chat("generation", [], ["openai"], override=override)
    assert err.value.provider_id == "openai"
    assert USER_KEY not in str(err.value) and USER_KEY not in repr(err.value)
    assert USER_KEY not in str(logs)
