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
LLM_GENERATION_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b
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

## Loading the corpus (#16)

```bash
pnpm data:load -- <collector output dir | records.jsonl[.gz]>... [--snapshot <partition>@<date>] [--dry-run]
```

It reads the collector's `documents/<source>.jsonl` (the dated per-run copies are skipped) and upserts into `corpus.documents` as `caseguard_ai`. A run prints what happened: `inserted`, `updated`, `unchanged`, `duplicate text`, `kept full text`, and skipped records with a reason.

- **Idempotent:** keyed on the collector's id, so a re-run changes nothing. The same text under another id (one judgment listed under two judges) is stored once.
- **Provenance (NFR-1):**
  - `official_url`, `retrieved_at` and `snapshot` are kept;
  - `third_party` (and `source_tier = 2`) for `hf_*` records;
  - `headnote_only` from the collector's `raw.headnote_only` flag (#147), or its note for older records.
- **Never a downgrade:** a head-note-only record (e.g. from a later metadata-only pass) never replaces a stored full judgment.
- **Skipped, never half-loaded:** records with under 40 characters of text, or no source URL.
- `kind`: Acts, Ordinances, Codes and the Constitution load as `statute`, and so does an `order` from a legislation source (a President's Order). Rules and regulations load as `rule`; court judgments and orders as `judgment`.
- The taxonomy columns (`area`, `subcategory`, `proceeding_type`) stay empty until the taxonomy is agreed (`docs/engineering/case-taxonomy.md`).

## Chunking and embedding (#18)

```bash
pnpm data:embed [-- --rebuild] [-- --limit N]
```

This turns `corpus.documents` into `corpus.chunks`, embedding with **BAAI/bge-m3 in-process** (ADR-0008). It's a job: stop it any time, and the next run carries on.

- **Chunking** (`ingest/chunker.py`) is deterministic and model-free:
  - **statutes** are split by section ("s. 302"; "Art. 199" in the Constitution; "O. XXI r. 60" in the CPC's First Schedule), and a chunk never crosses a section. The table of contents, page headers and amendment footnotes are left out, and each schedule is its own section;
  - **judgments** are windows of whole paragraphs of about 500 estimated tokens ("paras 4-6");
  - **head-note-only records** are one chunk, located "head-note" and flagged.

  Section headings are chosen as the longest run of section numbers in order, so a "1." list inside a section, a year, or a schedule listing another statute's sections can't derail it. On the CPC, CrPC and Contract Act from the live site, every section was found except the ones repealed.
- **Only what changed is redone.** A document is re-chunked when it has no chunks, its chunks come from another chunker version, or the loader changed it since. A chunk is embedded when it has no vector yet.
- **One model per corpus.** `corpus.corpus_meta` records the model, revision, chunker settings and input snapshots. A run with a different `EMBEDDING_MODEL` / `EMBEDDING_REVISION` is refused (exit 2) unless `--rebuild` is given, which re-embeds everything.
- **The full-text column** (`tsv`) is generated by Postgres, so it is always filled.
- **CPU by default:** torch comes from the CPU-only index on every platform, which keeps the image and CI small. On a machine with an NVIDIA GPU, install a CUDA build of torch into the venv (`uv pip install torch --index-url https://download.pytorch.org/whl/cu124`); `EMBEDDING_DEVICE` empty means CUDA when available.
- **The first run downloads bge-m3** (about 2.3 GB) into the Hugging Face cache.
- **Tests use `HashEmbedder`** (bag-of-words feature hashing), so nothing is downloaded. `--embedder hash` exists for trying the job, never for a real corpus.

## Corpus dumps (#154)

One person embeds and everyone else pulls, so nobody re-embeds for hours (data-storage spec §4).

```bash
pnpm data:dump [-- --no-upload] [--out DIR] [--freeze eval-frozen-N] [--yes]   # integrator
pnpm data:pull -- --dump latest|<date>[-N]|eval-frozen-N [--from DIR] [--yes]  # everyone
```

- **What's in it:**
  - `corpus.dump`: a tar of binary `COPY`s of `corpus_meta`, `documents` and `chunks`. `chunks.tsv` is regenerated on restore;
  - `manifest.json`: the Alembic revision, the embedding and chunker settings, input snapshots, row counts, SHA-256 and the git commit.
  - **Only `corpus`**; `app` and `ai` are never dumped. No `pg_dump` is needed: it uses `COPY` through psycopg as `caseguard_ai`.
- **`data:dump` refuses** an empty corpus, an unfinished `data:embed`, or chunks without vectors. It builds into `services/ai/.dumps/<today>/` (git-ignored), then asks before publishing to `HF_CORPUS_REPO`:
  - a new `dumps/<date>[-N]/` (never overwritten), with `dumps/LATEST` moved in the same commit;
  - tagged `dump/<folder>`, and `dump/eval-frozen-<n>` with `--freeze`.
- **`data:pull --dump`:**
  - downloads into the Hugging Face cache (`HF_HOME`), pinned to the dump's tag, and checks the SHA-256;
  - **refuses another Alembic revision** (run `pnpm db:migrate:ai` first);
  - shows the corpus loaded now and the incoming one, asks, then replaces `corpus` in one transaction.

  `--from` takes a local folder with both files (give a full path: `pnpm` runs it from `services/ai`).
- **Settings:** `HF_TOKEN` (a fine-grained token; empty uses `hf auth login`) and `HF_CORPUS_REPO` (default `caseguard/corpus`). The token is never printed.
- **After a restore**, retrieval still refuses a query model that differs from the dump's (`EMBEDDING_MODEL` / `EMBEDDING_REVISION`).
- Dumps made by hand with `pg_dump` can't be restored this way.

## Retrieval (#19)

`retrieval.hybrid.retrieve(conn, question, scope, embedder, reranker)` returns the best 8 passages for a question, best first. The pipeline: dense (pgvector cosine) top 50 + sparse (Postgres FTS, the question's words ORed) top 50 → RRF, k = 60 → top 20 → bge-reranker-v2-m3 → top 8.

- **Scope (FR-CASE-6):**
  - the public corpus, plus `ai.case_chunks` only where `user_id` is the caller's **and** `case_id` is in `allowedCaseIds`;
  - it's in every SQL statement that can touch case chunks, and an empty list means the public corpus only;
  - `tests/test_retrieval.py` holds the release-blocking marker-document test.
- **Law as of (FR-RES-11):** `retrieve(..., law_as_of=date)` leaves out judgments decided after that date, inside both searches and before their `LIMIT`. Judgments with no `decided_on` and all statutes stay in. With a date, the dense search turns on `hnsw.iterative_scan = strict_order` for that query, so the HNSW filter still fills k. The answer then carries an `asOfNote`.
- **Trace:** `Retrieval.trace()` gives the dense, sparse, fused and reranked lists (ids and scores, no text), for `ai.answer_traces`.
- **Guard:** search refuses a corpus that was never embedded, or one embedded with a different model or revision than the query embedder.
- **The reranker** loads in-process like the embedder (pinned by `RERANKER_MODEL` / `RERANKER_REVISION`; about 2.3 GB on first use). Tests use `OverlapReranker`.

## Answering questions (#20)

`POST /ai/v1/research/answer` (contract: `packages/contracts/openapi/ai.v1.yaml`):

1. **Allow-list first:** with no configured generation provider in `allowedProviders`, the answer is 503 before any work (SEC-11).
2. **Retrieve** the best 8 passages (#19).
3. **Generate** with prompt `answer-v1` (`research/prompts/`). The model cites with `[[p:N]]` and gives one verbatim quote per passage, or replies `NOT_ANSWERABLE`.
4. **Check existence** (`trust/existence.py`): the passage was retrieved, its document exists, and the quote is a verbatim span. Only whitespace is forgiven, because PDF line breaks fall mid-sentence. The stored quote is the source's own text.
5. **Decide the status** (`trust/status.py`, PRD §7.2). M1 has no support check, so citations are `needs_review` (existence passed) or `unverified` (it failed), never `verified`. `headnote_only` and `third_party_source` are flagged.
6. **Store** the trace, citations and verifications in one transaction, then build the response from what was read back. Markers become `[[c:<citationId>]]`.

- **Unanswerable** (nothing retrieved, `NOT_ANSWERABLE`, or no valid citation): `answerable: false`, no citations.
- **Errors:** 503 problem+json when no provider is allowed, the provider fails, or the corpus isn't embedded. 400 for an invalid request (fields named, the question never echoed).
- `GET /ai/v1/citations/{id}` returns the stored verification; `GET /ai/v1/sources/{id}` returns the corpus record.
- **To try it end to end:**
  - load and embed the corpus;
  - set a generation provider in `.env` (or `OLLAMA_MODEL`);
  - `pnpm stack:up`, sign in, enable that provider in the admin console, and ask in the Research Hub.
  
  The first question loads bge-m3 and the reranker, which takes a while.

## The procedural linter (#214)

`GET /ai/v1/lint/rulesets` and `POST /ai/v1/lint` ([ADR-0012](../../docs/adr/0012-deterministic-read-only-linter.md)). No database and no model: the same text and rule-set version always give the same findings.

- **Rule sets** are `linter/rules/bail_application.yaml` (ss.497 and 498 CrPC) and `linter/rules/plaint.yaml` (Order VII CPC, verification under Order VI r.15). Each is versioned; bump `version` whenever a rule changes, since apps/api stores it with every report.
- **A rule** has `id`, `kind` (`missing_section`, `missing_particular`, `structure`), `severity`, `title`, `message` and `source` (`{provision, reference}`, or `null` when the requirement is practice rather than a provision; FR-LINT-2). Its `detect` is one of:
  - `anyOf: [patterns]`, or `allOf: [[patterns], ...]` (every group must match);
  - either with `near: {anchor, window, direction}`: the match must start within `window` characters of an anchor. A particular missing beside its anchor gets the anchor's span;
  - `order: [ruleA, ruleB]`: B must not come entirely before A.

  `when` / `unless` (a detection) switch a rule on or off, e.g. the s.498 apprehension-of-arrest rule. Patterns are Python regexes, case-insensitive and multi-line.
- **Loading is strict** (`linter/rules.py`): an unknown key, bad id, unknown kind or severity, duplicate id, bad pattern or missing `source` fails at import and in the tests.
- **Findings** are in document order, then those without a span in rule order. Spans are UTF-16 code units; `inputSha256` is the SHA-256 of the text's UTF-8 bytes (FR-LINT-3). Text with a lone surrogate is a 400 on `text`.
- **Adding a rule:** add it to the YAML, then add its seeded defect to `SEEDED` in `tests/test_linter.py`. The test that every rule has one fails until you do.

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
  linter/        procedural linter (ADR-0012): rules/*.yaml, rules.py, engine.py, router.py
  db/            tables.py (corpus + ai), engine.py
migrations/      Alembic revisions (alembic.ini beside it)
tests/
Dockerfile       production image (uv, non-root, healthcheck)
```

Add new capabilities as modules beside `api/` (for example `retrieval/`, `trust/`, `graph/`, `temporal/`, `gateway/`), each with its own tests. Dependencies such as LangGraph or embeddings are added with `uv add` in the PR that first needs them.
