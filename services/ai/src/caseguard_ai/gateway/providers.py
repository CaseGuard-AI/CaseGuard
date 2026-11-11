"""Which model providers exist, how each is configured, and which one a request may use.

Provider ids are the ai.v1 ``ProviderId`` values, the same ids the api's admin allow-list seeds
(``apps/api/drizzle/0003_providers.sql``). A request says which ids it may use
(``AnswerRequest.allowedProviders``). This module never widens that list (SEC-11).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urlparse

from caseguard_ai.config import Settings

Role = Literal["generation", "judge"]

# Providers that run on the user's own machine or our server. An omitted allow-list means
# "local only" (ai.v1 AnswerRequest.allowedProviders), so a request never reaches the internet
# unless the api asked for it.
LOCAL_PROVIDERS = frozenset({"ollama"})

# Base-URL host → provider id, for the presets in .env.example. LLM_<ROLE>_PROVIDER overrides it.
_HOSTS = {
    "integrate.api.nvidia.com": "nvidia-nim",
    "generativelanguage.googleapis.com": "gemini",
    "api.groq.com": "groq",
    "openrouter.ai": "openrouter",
    "api.openai.com": "openai",
    "api.anthropic.com": "anthropic",
}

# Provider id → OpenAI-compatible base URL, for a user's own key (FR-SET-2, ADR-0009). These are
# the presets in .env.example, and each one's host infers back to its id through ``_HOSTS``.
# Local providers are absent on purpose: they are keyless and never take a credential.
PRESET_BASE_URLS: dict[str, str] = {
    "nvidia-nim": "https://integrate.api.nvidia.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
}


@dataclass(frozen=True)
class ProviderConfig:
    id: str
    base_url: str
    model: str
    api_key: str = field(default="", repr=False)  # never printed or logged

    @property
    def local(self) -> bool:
        return self.id in LOCAL_PROVIDERS

    def url(self, path: str) -> str:
        return self.base_url.rstrip("/") + "/" + path.lstrip("/")


def infer_provider_id(base_url: str) -> str:
    """The provider id for a base URL, or "" when it can't be told."""
    parsed = urlparse(base_url)
    host = (parsed.hostname or "").lower()
    if host in _HOSTS:
        return _HOSTS[host]
    if parsed.port == 11434 or "ollama" in host:
        return "ollama"
    return ""


def from_credential(provider_id: str, model: str, api_key: str) -> ProviderConfig:
    """The provider for a user's own key: the preset base URL for ``provider_id``.

    Raises ValueError for an id with no preset, which includes every local provider. The
    message names the id only, never the key.
    """
    if provider_id in LOCAL_PROVIDERS or provider_id not in PRESET_BASE_URLS:
        raise ValueError(f"{provider_id!r} is not a known cloud provider")
    return ProviderConfig(provider_id, PRESET_BASE_URLS[provider_id], model, api_key)


def allowed_set(allowed_providers: list[str] | None) -> set[str]:
    """The ids a request may use. Omitted means local only (fail closed, SEC-11)."""
    if allowed_providers is None:
        return set(LOCAL_PROVIDERS)
    return {p.strip().lower() for p in allowed_providers}


def _role_provider(settings: Settings, role: Role) -> ProviderConfig | None:
    base_url, model, key, tag = (
        (
            settings.llm_judge_base_url,
            settings.llm_judge_model,
            settings.llm_judge_api_key.get_secret_value(),
            settings.llm_judge_provider,
        )
        if role == "judge"
        else (
            settings.llm_generation_base_url,
            settings.llm_generation_model,
            settings.llm_generation_api_key.get_secret_value(),
            settings.llm_generation_provider,
        )
    )
    if not (base_url and model):
        return None
    provider_id = (tag or infer_provider_id(base_url)).strip().lower()
    if not provider_id:
        # An endpoint we can't name can't be matched against the allow-list: never use it.
        return None
    return ProviderConfig(provider_id, base_url, model, key)


def candidates(settings: Settings, role: Role) -> list[ProviderConfig]:
    """The providers configured for a role, in order of preference.

    First the role's own LLM_<ROLE>_* endpoint, then local Ollama (OLLAMA_BASE_URL +
    OLLAMA_MODEL) as the fallback that every allow-list can reach.
    """
    found: list[ProviderConfig] = []
    own = _role_provider(settings, role)
    if own is not None:
        found.append(own)
    if settings.ollama_base_url and settings.ollama_model:
        ollama = ProviderConfig("ollama", settings.ollama_base_url, settings.ollama_model)
        if not any(p.id == "ollama" and p.base_url == ollama.base_url for p in found):
            found.append(ollama)
    return found


def select(
    settings: Settings, role: Role, allowed_providers: list[str] | None
) -> ProviderConfig | None:
    """The first configured provider the request may use, or None (→ 503, no fallback)."""
    allowed = allowed_set(allowed_providers)
    for provider in candidates(settings, role):
        if provider.id in allowed:
            return provider
    return None
