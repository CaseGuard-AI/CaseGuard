# services/ai: CaseGuard AI service

**Stream C · Python 3.12, FastAPI, LangGraph, uv** ([ADR-0002](../../docs/adr/0002-two-backends-with-strict-boundary.md), [ADR-0005](../../docs/adr/0005-model-abstraction-and-desktop-readiness.md))

> Not scaffolded yet. CI skips this service until `pyproject.toml` exists.

## Owns

Hybrid retrieval, GraphRAG, temporal queries, the **trust layer** (the single writer of verification results), the model gateway, the Urdu query flow, drafting and linter AI, ingestion workers and the evaluation harness. It implements `/ai/v1` from `packages/contracts`.

## Rules

- **Internal only.** No published port, and every request must carry `AI_SERVICE_TOKEN` (SEC-14).
- Applies the scope it receives **inside SQL**. It never fetches unscoped results and filters them afterwards (FR-CASE-6).
- Writes only the `corpus` and `ai` schemas (DB role `caseguard_ai`), with Alembic migrations.
- Every LLM call goes through the OpenAI-compatible gateway. No provider SDK is called directly from pipelines.

## Scaffold (first PR: `feature/ai-scaffold`)

```bash
cd services/ai && uv init --app --python 3.12 && uv add fastapi uvicorn[standard] && uv add --dev ruff mypy pytest
```
