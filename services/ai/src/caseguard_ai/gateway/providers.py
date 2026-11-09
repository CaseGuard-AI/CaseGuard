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
    if allowed_providers is None:
        allowed = set(LOCAL_PROVIDERS)  # omitted = local only, fail closed
    else:
        allowed = {p.strip().lower() for p in allowed_providers}
    for provider in candidates(settings, role):
        if provider.id in allowed:
            return provider
    return None
