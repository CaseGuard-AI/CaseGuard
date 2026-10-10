> **Status:** In progress · **Issue:** groundwork for [#21](https://github.com/CaseGuard-AI/CaseGuard/issues/21) · **PR:** [#33](https://github.com/CaseGuard-AI/CaseGuard/pull/33)

# Plan: model provider presets (incl. NVIDIA NIM) + `pnpm llm:check`

## Context
The user wants to test with an NVIDIA NIM key now. Users will also bring OpenAI / OpenRouter / Anthropic keys alongside the recommended free-tier default. Per ADR-0005, providers are **configuration, not code**. NIM is OpenAI-compatible (`https://integrate.api.nvidia.com/v1`, `nvapi-…` keys), so no provider-specific client is needed. The real gateway (per-user keys, fallbacks, Admin allow-list) stays in #21. This PR only makes providers configurable and testable.

## Changes
- `.env.example`: a preset table for NVIDIA NIM, Gemini, Groq, OpenRouter, OpenAI, Anthropic (OpenAI-compatible endpoint) and Ollama.
- `services/ai/src/caseguard_ai/config.py`: optional `LLM_GENERATION_*` / `LLM_JUDGE_*` settings (keys are `SecretStr`).
- `services/ai/src/caseguard_ai/gateway/check.py`: stdlib-only connectivity check. It sends one chat completion or lists models, never prints the key, and gives clear errors for empty config, HTTP errors and failed connections.
- Root `package.json`: `pnpm llm:check`. Inside Docker: `docker compose exec ai python -m caseguard_ai.gateway.check`.
- Tests: URL joining, the auth header, no header for Ollama, refusing non-http URLs, the key never printed, model listing, the missing-config message, pnpm's `--`.
- Docs: `services/ai/README.md` "Testing a model provider", plus the CHANGELOG.

## Findings while building
- NVIDIA had already retired `meta/llama-3.3-70b-instruct` (HTTP 410). The example is now `nvidia/nemotron-3-super-120b-a12b`, and the docs say to run `--list-models` first because catalogs change.
- NIM's `/v1/models` answers without a key. Chat needs one (401 without).
- pnpm 10 forwards `--` literally, so the CLI drops it.

## Verification
- `ruff`, `mypy --strict`, `pytest` (13 passed).
- Against the live NIM API with no key: `--list-models` → 80 models. Chat → `HTTP 401 … authorization missing`, the expected result without a key.
- With a key: `pnpm llm:check` → `OK integrate.api.nvidia.com model=… reply='OK'`.
