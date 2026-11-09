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

Things we hit with NVIDIA NIM (October 2026):

- **Reasoning models** (Nemotron 3, gpt-oss, DeepSeek) think before answering and return the thinking in a separate `reasoning_content` field. With a small `max_tokens` they finish with `finish=length` and an **empty answer**. The check uses 512 tokens and reports an empty answer as a failure.
- **`--list-models` is not a guarantee.** It lists the whole catalog, and some listed models return 404 for a free key or never respond. `nvidia/nemotron-3-super-120b-a12b` and `openai/gpt-oss-20b` answered in about 1 s.
- Slow models: raise the wait with `--timeout 90`.

This is only a connectivity check.

## The model gateway (#21)

Every LLM call goes through `gateway/client.py::ModelGateway.chat(role, messages, allowed_providers)`. Pipelines never call a provider SDK.

- **Which provider:** each role (`generation`, `judge`) has one endpoint, `LLM_<ROLE>_*`. Its ai.v1 `ProviderId` is `LLM_<ROLE>_PROVIDER`, or is inferred from the base URL (the presets above).
  - Local Ollama (`OLLAMA_BASE_URL` + `OLLAMA_MODEL`) is the fallback for both roles.
  - An endpoint whose provider can't be named is never used, because it couldn't be checked against the allow-list.
- **Allow-list (SEC-11):** a request may use only the ids in `allowedProviders`, which the api fills from the Admin's provider list. **Omitted means local only.** With no match, `NoProviderError` (→ 503); there is never a silent fallback to another cloud.
- **Failures:** one retry on 429/5xx/timeout (honouring `Retry-After`, up to 10 s), then `GatewayError` (→ 503).
  - An empty answer (a reasoning model out of budget) is an error, not an empty reply.
  - Keys are never logged, printed or included in errors.
- **Not here yet:** user API keys (#92, #93). Embeddings and the reranker run in-process, not through the gateway (ADR-0008).

## Database: `corpus` and `ai` schemas (Alembic)

services/ai owns two schemas (ADR-0002) and migrates them with Alembic, as `caseguard_ai`:

| Schema | Tables | Shared? |
|---|---|---|
| `corpus` | `documents` (one per statute or judgment, with provenance and `headnote_only` / `third_party`), `chunks` (bge-m3 `vector(1024)` + HNSW, generated `tsvector` + GIN), `corpus_meta` (one row: the embedding and chunker settings the corpus was built with) | Yes, through corpus dumps (#154) |
| `ai` | `answer_traces` (ranked lists per question, never the question), `citations`, `verifications` (**the single trust store**, one row per citation), `case_chunks` (users' case files, #101) | Never |

```bash
pnpm db:migrate:ai          # alembic upgrade head (also run by the image on start)
pnpm db:migrate:ai:down     # back one revision
cd services/ai && uv run alembic revision --autogenerate -m "<what>"   # then review the file
```

- The tables are defined once in `src/caseguard_ai/db/tables.py`. `tests/test_migrations.py` runs `alembic check`, so the code and the migrations can't drift.
- The version table is `ai.alembic_version`. A corpus dump records it, and a restore refuses a mismatch (#154).
- Roles, schemas and the `vector` extension come from `infra/db/sql/bootstrap.sql`. **An existing Docker volume needs `pnpm db:rebootstrap` once**: #15 grants `caseguard_ai` USAGE on `public`, without which the `vector` type is invisible to it.
- `ai.citations` has no foreign key into `corpus`, on purpose: a dump restore truncates `corpus`.
- Migration tests need `AI_TEST_DATABASE_URL` (and `APP_TEST_DATABASE_URL` for the grant test) pointing at a **separate**, bootstrapped test database. They migrate it down and up. CI sets both.

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
  db/            tables.py (corpus + ai), engine.py
migrations/      Alembic revisions (alembic.ini beside it)
tests/
Dockerfile       production image (uv, non-root, healthcheck)
```

Add new capabilities as modules beside `api/` (for example `retrieval/`, `trust/`, `graph/`, `temporal/`, `gateway/`), each with its own tests. Dependencies such as LangGraph or embeddings are added with `uv add` in the PR that first needs them.
