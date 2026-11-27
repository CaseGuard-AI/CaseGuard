"""The model gateway: the one way services/ai calls an LLM (ADR-0005, NFR-16).

Every provider speaks the OpenAI-compatible ``/chat/completions`` API, so switching between
NVIDIA NIM, a free-tier cloud and local Ollama is configuration only. Pipelines call
``ModelGateway.chat(role, messages, allowed_providers)`` and never a provider SDK.

A key (from the env or a user's credential) goes only into the ``Authorization`` header. Logs
and ``GatewayError`` messages carry the provider id, model and HTTP status, never the key, the
headers or the provider's response body.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx
import structlog

from caseguard_ai.config import Settings
from caseguard_ai.gateway.providers import ProviderConfig, Role, allowed_set, select

log = structlog.get_logger("gateway")

RETRYABLE = {429, 500, 502, 503, 504}
MAX_RETRY_WAIT_S = 10.0


class NoProviderError(Exception):
    """No configured provider is in the request's allow-list. The route answers 503."""

    def __init__(self, role: Role) -> None:
        super().__init__(f"no allowed model provider is configured for the {role} role")
        self.role = role


class GatewayError(Exception):
    """The chosen provider failed or answered with nothing usable. The route answers 503."""

    def __init__(self, provider_id: str, message: str) -> None:
        super().__init__(f"{provider_id}: {message}")
        self.provider_id = provider_id
        # Safe to log: built from a status code or a fixed phrase, never the upstream body.
        self.reason = message


@dataclass(frozen=True)
class ChatResult:
    text: str
    provider_id: str
    model: str
    latency_ms: int
    finish_reason: str | None
    usage: dict[str, Any]


class ModelGateway:
    def __init__(
        self,
        settings: Settings,
        client: httpx.Client | None = None,
        timeout: float = 120.0,
    ) -> None:
        self._settings = settings
        self._client = client or httpx.Client(timeout=httpx.Timeout(timeout, connect=10.0))

    def close(self) -> None:
        self._client.close()

    def provider_for(
        self,
        role: Role,
        allowed_providers: list[str] | None,
        override: ProviderConfig | None = None,
    ) -> ProviderConfig:
        """The provider for a role. ``override`` (a user's own key, FR-SET-2) replaces the
        configured choice for the generation role only, and only if the allow-list has it."""
        if override is not None and role == "generation":
            # The route checked this already; never widen the allow-list (SEC-11).
            if override.id not in allowed_set(allowed_providers):
                raise NoProviderError(role)
            return override
        provider = select(self._settings, role, allowed_providers)
        if provider is None:
            raise NoProviderError(role)
        return provider

    def chat(
        self,
        role: Role,
        messages: list[dict[str, str]],
        allowed_providers: list[str] | None,
        *,
        override: ProviderConfig | None = None,
        max_tokens: int | None = None,
        temperature: float = 0.0,
    ) -> ChatResult:
        """``max_tokens`` defaults to the role's LLM_<ROLE>_MAX_TOKENS."""
        provider = self.provider_for(role, allowed_providers, override)
        if max_tokens is None:
            max_tokens = (
                self._settings.llm_judge_max_tokens
                if role == "judge"
                else self._settings.llm_generation_max_tokens
            )
        body = {
            "model": provider.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        started = time.perf_counter()
        data = self._post(provider, body)
        latency_ms = round((time.perf_counter() - started) * 1000)
        try:
            choice = data["choices"][0]
            text = (choice["message"].get("content") or "").strip()
            finish = choice.get("finish_reason")
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            raise GatewayError(provider.id, "unexpected response shape") from exc
        if not text:
            # Reasoning models can spend the whole budget thinking and return no content.
            hint = " (the model used its whole budget reasoning)" if finish == "length" else ""
            raise GatewayError(provider.id, "empty answer" + hint)
        log.info(
            "llm_call",
            role=role,
            provider=provider.id,
            model=provider.model,
            latency_ms=latency_ms,
            finish=finish,
        )
        return ChatResult(
            text, provider.id, provider.model, latency_ms, finish, data.get("usage") or {}
        )

    def _post(self, provider: ProviderConfig, body: dict[str, Any]) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        if provider.api_key:  # Ollama needs none
            headers["Authorization"] = f"Bearer {provider.api_key}"
        url = provider.url("chat/completions")
        for attempt in (1, 2):
            try:
                response = self._client.post(url, json=body, headers=headers)
            except httpx.TimeoutException as exc:
                if attempt == 1:
                    continue
                raise GatewayError(provider.id, "timed out") from exc
            except httpx.TransportError as exc:
                raise GatewayError(provider.id, f"cannot connect ({type(exc).__name__})") from exc
            if response.status_code in RETRYABLE and attempt == 1:
                time.sleep(_retry_after(response))
                continue
            if response.status_code >= 400:
                # The body may echo the request; keep only the status in logs and errors.
                raise GatewayError(provider.id, f"HTTP {response.status_code}")
            try:
                parsed: dict[str, Any] = response.json()
            except ValueError as exc:
                raise GatewayError(provider.id, "response is not JSON") from exc
            return parsed
        raise GatewayError(provider.id, "gave up after a retry")


def _retry_after(response: httpx.Response) -> float:
    try:
        return min(MAX_RETRY_WAIT_S, max(0.0, float(response.headers.get("retry-after", "1"))))
    except ValueError:
        return 1.0
