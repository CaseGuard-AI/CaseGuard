# services/ai: CaseGuard AI service

**Stream C · Python 3.12, FastAPI, LangGraph, uv** ([ADR-0002](../../docs/adr/0002-two-backends-with-strict-boundary.md), [ADR-0005](../../docs/adr/0005-model-abstraction-and-desktop-readiness.md))

## Owns

Hybrid retrieval, GraphRAG, temporal queries, the **trust layer** (the single writer of verification results), the model gateway, the Urdu query flow, drafting and linter AI, ingestion workers and the evaluation harness. It implements `/ai/v1` from `packages/contracts`.

## Rules

- **Internal only.** No published port, and every request must carry `AI_SERVICE_TOKEN` (SEC-14).
- Applies the scope it receives **inside SQL**. It never fetches unscoped results and filters them afterwards (FR-CASE-6).
- Writes only the `corpus` and `ai` schemas (DB role `caseguard_ai`), with Alembic migrations.
- Every LLM call goes through the OpenAI-compatible gateway. No provider SDK is called directly from pipelines.

## Run locally

```bash
cd services/ai
uv sync --all-extras --dev                                   # creates services/ai/.venv (Python 3.12)
uv run uvicorn caseguard_ai.main:app --reload --port 8000    # or from the repo root: pnpm dev:ai
```

Settings come from environment variables, then `services/ai/.env`, then the repo-root `.env`. `AI_SERVICE_TOKEN` is required.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness |
| `GET /ready` | none | Readiness: can it connect to Postgres as `caseguard_ai`? |
| `GET /ai/v1/info` | `Authorization: Bearer $AI_SERVICE_TOKEN` | Smoke test for the API → AI wiring |
| `GET /docs` | none | OpenAPI UI (dev) |

## Testing a model provider

Providers are configuration, not code (ADR-0005). Set a role in `.env` using a preset from `.env.example` (NVIDIA NIM, Gemini, Groq, OpenRouter, OpenAI, Anthropic, Ollama). For example:

```env
LLM_GENERATION_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_GENERATION_MODEL=nvidia/nemotron-3-super-120b-a12b
LLM_GENERATION_API_KEY=nvapi-...
```

Then send one test prompt (the key is never printed):

```bash
pnpm llm:check                        # from the repo root; LLM_GENERATION_* role
pnpm llm:check --list-models          # models this key can use
pnpm llm:check --role judge           # LLM_JUDGE_* role
docker compose exec ai python -m caseguard_ai.gateway.check   # same check from inside the stack
```

This is only a connectivity check. The real gateway (per-user keys, fallbacks, Admin allow-list) is #21.

## Checks

```bash
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest
```

## Layout

```
src/caseguard_ai/
  main.py        app factory, /health, /ready
  config.py      pydantic-settings (env → .env files)
  security.py    service-token guard for /ai/v1
  api/v1.py      /ai/v1 router: add feature routers here
  gateway/       model gateway (ADR-0005); check.py = provider connectivity check
tests/
Dockerfile       production image (uv, non-root, healthcheck)
```

Add new capabilities as modules beside `api/` (for example `retrieval/`, `trust/`, `graph/`, `temporal/`, `gateway/`), each with its own tests. Dependencies such as LangGraph, embeddings or Alembic are added with `uv add` in the PR that first needs them.
