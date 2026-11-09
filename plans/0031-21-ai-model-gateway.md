> **Status:** In progress · **Issue:** [#21](https://github.com/CaseGuard-AI/CaseGuard/issues/21) · **PR:** _TBD_

# #21: model gateway (OpenAI-compatible; NIM, free-tier clouds, Ollama)

## Context

#20 (`research/answer`) needs one way to call an LLM that respects the Admin's provider allow-list. The api already sends that list as `allowedProviders` on every question (#75). Owner decision (2026-11-10): config-switched between local Ollama, free-tier clouds **and NVIDIA NIM**.

**Requirements:** NFR-11, NFR-16, NFR-19, SEC-11, ADR-0005.

## Decisions

- **Provider ids = ai.v1 `ProviderId`**, the same as the api seed (`nvidia-nim`, `gemini`, `groq`, `openrouter`, `openai`, `anthropic`, `ollama`).
  - Each role's endpoint is tagged with `LLM_<ROLE>_PROVIDER`, or inferred from the preset base URL.
  - **An endpoint we can't name is never used**, since it couldn't be checked against the allow-list.
- **Candidates per role:** the role's own endpoint, then local Ollama (`OLLAMA_BASE_URL` + `OLLAMA_MODEL`).
- **Selection:** the first candidate in `allowedProviders`. Omitted means **local only** (fail closed, per the contract). No match raises `NoProviderError`, and the route answers 503, never a different cloud.
- **httpx**, OpenAI-compatible `/chat/completions`.
  - One retry on 429/5xx/timeout (`Retry-After`, capped at 10 s); 4xx is not retried.
  - An empty answer is an error (reasoning models out of budget).
  - Errors carry only the HTTP status, never the body, which can echo the key.
- User keys wait for #92/#93. `gateway/check.py` (`pnpm llm:check`) is unchanged.
- **ADR-0008** records that embeddings and the reranker run in-process, amending ADR-0005's "chat/embeddings through the gateway".

## Changes

- `gateway/providers.py`: ids, inference, candidates, `select`.
- `gateway/client.py`: `ModelGateway`, `ChatResult`, `NoProviderError`, `GatewayError`.
- `config.py`: `llm_<role>_provider`, `ollama_base_url`, `ollama_model`.
- `.env.example`: the new settings.
- `httpx` is now a runtime dependency.
- `tests/test_gateway.py`: the inference table, explicit tag, unnamed endpoint unused, ordering, allowed cloud, fallback to local, omitted = local only, nothing allowed, per-role config, request shape and auth, no auth for Ollama, retry on 429, second failure without the key, 4xx not retried, empty reasoning answer, connect error, malformed response, key not in repr.
- Docs: services/ai README (gateway section), ADR-0008, CHANGELOG.

## Verification

- `ruff`, strict `mypy` and `pytest` are clean (no network: `httpx.MockTransport`).
