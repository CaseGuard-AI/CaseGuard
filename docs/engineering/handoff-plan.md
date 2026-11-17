# Plan: implement the whole handoff (`docs/engineering/handoff.md`)

> **Status:** written 2026-11-10, before the work started. Sections 1–4 and 6–9 are done (#147, #15, #21, #153, #16, #18, #19, #20). What's left, and the current state, is in [`session-handoff.md`](session-handoff.md).

## Context

The handoff (2026-11-09) is the team's "start here". Stream A is mostly done, but **M1's vertical slice doesn't work end to end**:
- the collector stores 0 statutes and 0 judgment files from the live sites (#147);
- there is no shared storage for the corpus (#151, #152, #154);
- `services/ai` is a skeleton: only `/info`, `/health` and `/ready`; no Alembic, tables, embeddings, retrieval or answer route.

So every Research Hub question gets 503.

**Goal:** one person can crawl the seed corpus, publish it, and build an embedded dump. Everyone else pulls that dump, and the Research Hub answers an English question with cited, status-checked passages. The held-out test set is frozen. That is M1's definition of done (PRD §16.2).

**Decisions made with the user:**
- bge-m3 and bge-reranker-v2-m3 run **in-process** (sentence-transformers, CPU by default, CUDA if available).
- The LLM gateway is **config-switched** between local Ollama, free-tier cloud and **NVIDIA NIM** (`nvidia-nim` is already in the api's provider seed, `apps/api/drizzle/0003_providers.sql`).
- Manual items are a **checklist**, and the code is ordered so nothing waits on them.

**Already there, to reuse:**
- `packages/contracts/openapi/ai.v1.yaml` already defines `answerQuestion`, `getCitation` and `getSource`, with `Verification {status, flags, checks, lastVerifiedAt}` and `[[c:<id>]]` markers.
- `apps/api/src/clients/ai.ts` already calls all of them.
- The api's `checkAnswer` (`apps/api/src/routes/conversations.ts:43`) accepts any status, but rejects an unanswerable answer that carries citations.
- **No contract changes are needed for M1.**

**Housekeeping first** (done at the time): start every branch from an up-to-date `staging`; a stray nested copy of the repo was deleted.

## Conventions for every PR (from CONTRIBUTING and the handoff)

- One issue per PR, under ~400 lines where possible, Conventional Commit title, branch prefix `feature/` or `fix/`.
- Assign yourself on the issue first.
- Plan file `plans/NNNN-<issue#>-<slug>.md` with a status line. 0028 is taken by #83, so start at **0029** and check `ls plans` each time.
- Add CHANGELOG `[Unreleased]` entries, and update `handoff.md` §1/§2 in the same PR when an item finishes.
- Commit with `git commit -F <file>` from Git Bash (the PowerShell gotcha).
- Python rules: ruff, `mypy --strict` on new modules, pytest, deps via `uv add`. Never log keys or document contents.
- DB tests run against a separate bootstrapped test DB, never the dev DB.

## Order of work (tracks run in parallel)

```text
Week-1 parallel:
  B: #147 collector live fix ──► #153 partitions ──► crawl pk-code-seed, shc-meta (+ a first shc-criminal/civil batch)
  C: #15 Alembic schemas ──► #16 load JSONL ──► #18 chunk+embed ──► #19 hybrid retrieval ──► #20 research/answer (+ citations/sources)
  C: #21 model gateway (independent) ─────────────────────────────────────────────────────┘
  B: #152 snapshot tooling (offline-tested now; publish once #151 exists)
  Human: #151 HF org/repo, PKLEGAL_USER_AGENT contact, integrator choice
Then: #154 dump build/restore (needs #15, #18, #152) · #22 test set (needs loaded corpus to pick gold refs) · #17 SCP probe (human, any time)
```

---

## 1. #147: collector live-site fix (`fix/collector-live-sites`)

Files are under `services/collector/`.

1. **TLS** (`utils/http_client.py`, `utils/robots.py`, `config.py`).
   - Commit the public intermediate `certs/gogetssl-rsa-dv-ca.pem`, converted from `http://crt.usertrust.com/GoGetSSLRSADVCA.crt`.
   - Add `utils/tls.py::ssl_context()`: an `ssl.create_default_context(cafile=certifi.where())`, plus `load_verify_locations(<bundled pem>)`.
   - Pass it as `verify=` to `httpx.Client` when `verify_tls` is true. Use the same context in `RobotsCache._parser_for` (`urlopen(..., context=ctx)`).
   - Make a robots TLS failure **log a warning and skip the host**, not silently allow everything (NFR-14).
   - Add `certifi` as an explicit dependency (`uv add certifi`). Never add a way to turn verification off.
2. **Link resolution helper** (new `utils/links.py`):
   - `base_url_of(soup, page_url)` honours `<base href>`.
   - `resolve(soup, page_url, href)` joins against that base.
   - `strip_comments(soup)` removes `bs4.Comment` nodes.
3. **pakistan_code** (`scrapers/pakistan_code.py`):
   - `_parse_index` resolves each href first, then matches `DETAIL_HREF` against the resolved URL's path. Relax it to `-sg-j+$` without requiring `/english/` in the raw href.
   - `PDF_HREF` becomes `(?:^|/)pdffiles/[^"'?#]+\.pdf`.
   - `_find_pdf` resolves against the base and runs `strip_comments` before the raw-string pass.
4. **SHC** (`scrapers/shc_caselaw.py::_row_to_item`):
   - `DOWNLOAD_LINK` becomes `(?:^|/)download-file\.php\?`, resolved with `resolve()` so it honours `<base href="/caselaw/">`.
   - The commented-out `view-file` links stay ignored. Add a test that proves it.
5. **Non-PDF downloads** (`scrapers/base_scraper.py::ingest_pdf`):
   - Keep the magic-byte rejection. Also apply it to bytes already on disk.
   - Set an explicit `raw["file_status"]` = `ok | not_pdf | empty | missing_link`, and a note distinct from "head-note only".
   - Also set an explicit **`raw["headnote_only"]: bool`** on SHC records. Later stages (#16, #18) read this flag instead of parsing `notes`.
6. **Tests** (`tests/`, existing `httpx.MockTransport` + `fixture_html` pattern). Add fixtures saved from today's live pages (trimmed):
   - a relative pakistan_code index;
   - a detail page with relative `pdffiles/`;
   - an SHC table with `<base href="/caselaw/">`, a relative `download-file.php` and a commented `view-file`;
   - an empty body and an HTML body served as "PDF";
   - a TLS context test (a bundled cert loads, `verify` is never False).
7. **Live acceptance:**
   - `uv run python main.py --source pakistan_code --limit 5` and `--source shc_caselaw --limit 5`.
   - The report shows statutes with PDFs and SHC judgments with files.
   - Update collector README §7/§10 and the handoff gotcha (the TLS workaround is no longer needed).

## 2. #15: Alembic + `corpus`/`ai` schemas (`feature/ai-alembic-corpus-schema`)

1. Run `uv add alembic sqlalchemy pgvector` in `services/ai`. Add `services/ai/alembic.ini` and `alembic/env.py`, reading `get_settings().ai_database_url`.
   - Put the version table at `ai.alembic_version`. The dump gate (#154) reads it.
2. Add table metadata in `src/caseguard_ai/db/tables.py` (SQLAlchemy Core, used by the loader, ingestion and retrieval).
3. **Revision 0001, corpus:**
   - **`corpus.documents`**:
     - identity: `id text pk` (the collector id), `source_key`, `kind` (`statute|judgment|rule|other`, as in the ai.v1 `Source.kind`);
     - descriptive: `title`, `citation`, `case_number`, `court`, `matter_type`, `decided_on`, `language`;
     - links and text: `official_url NOT NULL` (NFR-1), `document_file_url`, `full_text`, `summary`;
     - provenance and trust: `headnote_only`, `third_party`, `source_tier smallint`, `content_hash UNIQUE`, `retrieved_at`, `extraction_status`, `raw jsonb`, `snapshot` (`partition@date`);
     - taxonomy, nullable: `area`, `subcategory`, `proceeding_type`.
   - **`corpus.chunks`**:
     - `id uuid`, `document_id fk`, `ordinal`, `locator` (e.g. "s. 302", "para 14"), `section_id`, `text`, `token_count`;
     - denormalised `headnote_only`, `third_party`;
     - `embedding vector(1024)` with an HNSW `vector_cosine_ops` index;
     - `tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED` with a GIN index.
   - **`corpus.corpus_meta`** (single row): embedding model id + revision, dims, normalised, chunker version + settings jsonb, FTS config, input snapshots jsonb, built_at.
   - Graph tables wait for M2 (ADR-0003).
4. **Revision 0002, ai:**
   - **`ai.citations`**: `id uuid`, `request_id`, `document_id`, `chunk_id`, `claim`, `locator`, `quote`, `quote_language`, `created_at`.
   - **`ai.verifications`**, the **single trust store** (FR-TRUST-10):
     - `citation_id unique fk`;
     - `status` with CHECK `verified|needs_review|unverified`;
     - `flags text[]`, `checks jsonb`, `last_verified_at`, `verifier_version`.
   - **`ai.answer_traces`**: `request_id pk`, the dense/sparse/fused/reranked id+score lists (FR-RES-2), model ids, provider, latency. Don't store the question text (the api already writes the audit row).
   - **`ai.case_chunks`**, the upload chunks (#145): `user_id`, `case_id`, `document_id`, the same chunk columns. Empty until #101.
5. Write a **downgrade for each revision**. Add a test (`tests/test_migrations.py`, skipped without `AI_TEST_DATABASE_URL`): upgrade→downgrade→upgrade, the CHECK constraints, and that `caseguard_app` can SELECT `corpus.documents` but nothing in `ai`.
6. Wiring:
   - root `package.json` gets `db:migrate:ai` (`uv run --directory services/ai alembic upgrade head`);
   - the ai Dockerfile runs `alembic upgrade head` before uvicorn, as the api image does;
   - the CI ai job runs the migration test against its Postgres service.
7. The collector's `storage/database.py` `create_all` tables are superseded. Mark `--load-db` deprecated in the collector README, pointing to #16.

## 3. #21: model gateway (`feature/ai-model-gateway`)

1. Add `src/caseguard_ai/gateway/providers.py`: a registry keyed by ai.v1 `ProviderId`.
   - Ids: `ollama` (local), `nvidia-nim`, `gemini`, `groq`, `openrouter`, `openai`, `anthropic`. They match the api seed exactly.
   - Each is configured by env: `LLM_<ID>_BASE_URL`, `_API_KEY`, `_MODEL` per role, or the existing `LLM_GENERATION_*` / `LLM_JUDGE_*` with an `LLM_GENERATION_PROVIDER=<id>` tag.
   - Extend `config.Settings`. Add the vars to `.env.example`, including `OLLAMA_BASE_URL` and the NIM preset already documented there.
2. Add `gateway/client.py::ModelGateway.chat(role, messages, allowed_providers)`.
   - Use httpx with OpenAI-compatible `/chat/completions`.
   - Selection: the configured providers for the role, filtered by `allowedProviders`. An omitted list means **local only**, which fails closed. No match raises `NoProviderError`, and the route maps that to 503 Problem (SEC-11).
   - Timeouts and one retry on 429/5xx. Keys are never logged.
3. Refactor `gateway/check.py` (`pnpm llm:check`) to reuse the provider config. Keep its tests passing.
4. Tests with `httpx.MockTransport`: selection and fail-closed rules, NIM/Ollama/Gemini request shapes, and 503 mapping.
5. User keys wait for ADR #92 and #93. Leave a `credential` hook point, unused.
6. **ADR-0008:** "Embeddings and reranker run in-process, LLM calls through the gateway". It amends ADR-0005's "gateway for embeddings" and justifies it with NFR-17 and the absence of a reranker endpoint in Ollama.

## 4. #153: partition support (`feature/collector-partitions`)

1. Add `partitions.py` with presets selected by `--partition <name>`. Each partition writes to its own output dir, `data/partitions/<name>/`, so snapshots pack cleanly.
   - **`pk-code-seed`:** `pakistan_code` limited by a committed title list `selections/pk-code-seed.txt` (the PRD §15.3 statutes, their amendment acts and the Constitution). Matched case-insensitively on the index title.
   - **`shc-meta`:** `shc_caselaw`, `PKLEGAL_SHC_SCOPE=all`, `--no-pdfs`.
   - **`shc-criminal` / `shc-civil`:** `--selection selections/<p>.csv`. Discovery yields only the listed case ids and fetches their files.
2. Add `tools/make_selection.py`:
   - takes `--from <shc-meta dir or snapshot> --map selections/matter_type_map.csv --partition shc-criminal --n 3000 --seed 42`;
   - stratifies by matter_type × year and writes `case_id, matter_type, reason`.
   - The map marks ambiguous types (H.C.A, I.A, Const. P) as `ambiguous`, and they are excluded until #148 is decided.
3. Record the partition, selection file SHA-256 and source snapshot in the state.db `runs` table, for the #152 manifest.
4. Add `services/collector/PARTITIONS.md` (partition, bounds, owner, selection file). Tests use fixtures for selection-only discovery and the generator's stratification and determinism.
5. **Then crawl** `pk-code-seed` and `shc-meta`, and a first small `shc-criminal`/`shc-civil` batch (a few hundred each) so that M1 has judgments.

## 5. #152: snapshot push/pull/status (`feature/collector-data-snapshots`)

1. Run `uv add huggingface_hub` in `services/collector`. Add a new package `snapshots/` with these modules:
   - **`manifest.py`:** identity, provenance (git commit + dirty flag, settings, run ids, selection), the counts listed in spec §3, and per-file bytes + SHA-256.
   - **`pack.py`:**
     - `records.jsonl.gz` from the combined `documents/<source>.jsonl`;
     - `state.db` copied with the `sqlite3` backup API;
     - an uncompressed `files.tar` of `raw/` + `text/`, using forward-slash arcnames for Windows.
   - **`gate.py`:** refuses on a checksum or count mismatch, a dirty `services/collector` tree, `.env`/token/upload-looking files, or `hf_*` records in a non-bootstrap partition.
   - **`hub.py`:**
     - `HfApi` with `HF_TOKEN` / `HF_CORPUS_REPO`;
     - `<date>[-N]` folder selection, so nothing is ever overwritten (check that the path exists first);
     - `upload_folder`, and `create_tag snap/<p>/<date>`.
   - **`pull.py`:** downloads and verifies against the manifest, skips `files.tar` unless `--with-files`, and unpacks into `data/partitions/<p>/`.
   - **`status.py`:** lists snapshots and dumps, and shows repo usage against 100 GB (warns at 75 GB).
2. Add the CLI `python -m snapshots push|pull|status`.
3. Add `scripts/data.mjs` (Node, cross-platform), which routes `pnpm data:push|pull|status|dump`:
   - `--snapshot` goes to the collector;
   - `--dump` and `dump` go to services/ai (#154).
   - Add root `package.json` scripts, and `HF_TOKEN=` and `HF_CORPUS_REPO=` to `.env.example`, both with comments.
4. Offline tests: manifest build, each gate refusal, a pack→unpack round trip, and `-N` folder selection with a mocked `HfApi`.
5. Once #151 exists, publish the first `pk-code-seed` and `shc-meta` snapshots and have a teammate pull them.

## 6. #16: load JSONL into `corpus` (`feature/collector-load-corpus`)

The loader lives in **services/ai** because it shares the #15 table metadata and owns the `corpus` writes. It runs as `caseguard_ai`. Expose it as `pnpm data:load`.

1. Add `src/caseguard_ai/ingest/load.py` (`python -m caseguard_ai.ingest.load <partition dir|records.jsonl.gz>...`). It maps the collector's `LegalDocument` fields as follows:
   - `kind`: from `document_type`.
   - `official_url`: from `source_url` / `document_url`.
   - `headnote_only`: from `raw.headnote_only` (#147).
   - `third_party`: `source.startswith("hf_")`.
   - `source_tier`: from config.
   - `snapshot`: from the manifest.
2. Upserts are idempotent: on `id`, and dedup on `content_hash`. Skip records with no usable text (under 40 characters) or no URL, and count and report them.
3. Tests against the test DB with fixture records: provenance kept, head-note flag kept, the third-party label, idempotent re-runs, and dedup.

## 7. #18: chunking + bge-m3 embeddings + FTS (`feature/ai-ingestion-embeddings`)

1. Run `uv add sentence-transformers` (torch CPU wheels by default). Pin the model ids and **revisions** in `Settings`: `EMBEDDING_MODEL`, `EMBEDDING_REVISION`, `RERANKER_MODEL`, `RERANKER_REVISION` (the first two names already exist in `.env.example`).
2. Add `ingest/chunker.py` (`CHUNKER_VERSION = "1"`). This is pure, deterministic and fully unit-tested.
   - **Statutes:** split on section headings (e.g. `^\s*\d+[A-Z]?\.\s`). Split long sections by sub-section `(1)`, `(a)` up to about 600 tokens. Use locators like `s. 302`, `s. 497(2)`. Chunks never cross a section.
   - **Judgments:** paragraph windows of 400–600 tokens, with paragraph-number locators.
   - **Head-note-only records:** the chunk is the summary, flagged `headnote_only`.
   - Token counts use the bge-m3 tokenizer.
3. Add `ingest/embedder.py`: an `Embedder` protocol with a `BgeM3Embedder` (normalised, dim 1024) and a deterministic `HashEmbedder` for tests and CI (no model download).
4. Add `ingest/embed.py` (`python -m caseguard_ai.ingest.embed [--rebuild]`), exposed as `pnpm data:embed`.
   - Chunk any document whose content_hash or chunker version changed, embed in batches, and write `corpus_meta`.
   - **Refuse if `corpus_meta` has a different model or revision**, unless `--rebuild` is given.
5. Tests:
   - chunker rules on real PPC/CrPC fixture text, including the no-boundary-crossing rule;
   - idempotent re-runs;
   - the meta mismatch refusal;
   - the FTS column filled.

## 8. #19: hybrid retrieval (`feature/ai-hybrid-retrieval`)

1. Add `retrieval/hybrid.py::retrieve(query, scope, k)`:
   - **Dense:** `embedding <=> :q`, LIMIT 50.
   - **Sparse:** `ts_rank_cd(tsv, websearch_to_tsquery('english', :q))`, LIMIT 50.
   - **Scope inside SQL:** the public corpus, `UNION` `ai.case_chunks WHERE user_id = :uid AND case_id = ANY(:allowedCaseIds)`. An empty list means corpus only (FR-CASE-6).
   - Then RRF k=60 (`retrieval/rrf.py`) → top 20 → `CrossEncoder` rerank (`retrieval/reranker.py`, with a stub in tests) → top 5–8.
   - Return every ranked list for the trace.
2. Add `retrieval/guard.py`: refuses to run if the query-side embedding model doesn't match `corpus_meta`.
3. Tests:
   - RRF math as unit tests;
   - integration on the test DB with `HashEmbedder`;
   - **a scope leakage test:** a marker chunk in another user's case is never returned (release-blocking per FR-CASE-6);
   - the mismatch guard.

## 9. #20: `research/answer` + citations/sources (`feature/ai-research-answer`)

1. Add `research/answer.py`. It retrieves, then sends a prompt with numbered passages to the gateway's generation role. The prompt requires `[[p:N]]` markers, verbatim quotes, and `NOT_ANSWERABLE` when the passages don't cover the question.
   - Version the prompts in `research/prompts/`. They must work on a 7–8B model (NFR-19).
   - Parse the markers and quotes.
2. Add `trust/existence.py`, a deterministic check (FR-TRUST-9). It passes only if:
   - the cited passage is one of the retrieved chunks, and
   - its document exists in `corpus`, and
   - the quote is a byte-for-byte substring of the chunk text (FR-RES-10).
3. Add `trust/status.py`, which applies the PRD §7.2 rules.
   - In M1 the support check is `not_run`, so passing citations are **`needs_review`** and failures are **`unverified`**. They are never shown as verified without a support check (FR-TRUST-8).
   - Flags: `headnote_only`, `third_party_source`.
   - Unit tests get 100% branch coverage (CONTRIBUTING).
4. Persistence:
   - Write `ai.citations`, then `ai.verifications`, then `ai.answer_traces` in one transaction.
   - The response reads statuses **back from the store** (FR-TRUST-10).
   - Replace the markers with `[[c:<citationId>]]`.
   - Unanswerable answers, whether from the model or from too little retrieval, return `answerable=false` with no citations (FR-RES-9).
5. Routes in `api/v1.py`:
   - `POST /ai/v1/research/answer`;
   - `GET /ai/v1/citations/{id}` (the stored verification);
   - `GET /ai/v1/sources/{id}` (from `corpus.documents`).
   - Errors: `NoProviderError`/gateway failure → 503 Problem; validation → 400.
   - Validate responses against `ai.v1.yaml` in tests (a schema check like the api's `expectContract`).
6. Tests with a fake gateway and `HashEmbedder` on the test DB: answerable, unanswerable, a fabricated quote → unverified, a status read from the store, and the 503 paths.
7. **End to end:** with `pnpm stack:up` and a migrated, loaded, embedded DB, sign in on the web, enable a provider in the admin console, and ask "What is the punishment under s.302 PPC?". You get a cited answer with statuses, and the api audit row is written.

## 10. #154: dump build/restore (`feature/ai-corpus-dump`)

1. Add `src/caseguard_ai/data/dump.py` (`pnpm data:dump [--freeze eval-frozen-<n>]`).
   - Run `pg_dump --data-only --schema=corpus -Fc`, through `docker compose exec db` when no local `pg_dump` exists (Windows).
   - The manifest holds the Alembic revision (`ai.alembic_version`), the `corpus_meta` contents, the input snapshots and a SHA-256.
   - Upload `dumps/<date>[-N]/`, tag `dump/<date>`, and rewrite `dumps/LATEST`.
   - Reuse the collector's hub helpers by duplicating a small `hub` module. Both are thin wrappers over `huggingface_hub`.
2. Add `data/restore.py` (`pnpm data:pull --dump latest|<date>|eval-frozen-<n>`).
   - Verify the checksum, **refuse on a revision mismatch**, show the currently loaded dump (from `corpus_meta`), and confirm (`--yes` to skip).
   - Then `TRUNCATE` the corpus tables and `pg_restore --data-only` as `caseguard_ai`, with ADR-0002 roles intact.
3. Tests: the revision gate, the model-mismatch refusal, and a restore into an empty migrated test DB (dump built from fixtures).
4. Spec §4 and handoff §2 row 7: done when a teammate restores the dump and the Research Hub answers.

## 11. #22: evaluation test set (`feature/eval-test-set`)

1. Add `eval/testset/schema.json`, plus `dev.jsonl` (60) and `heldout.jsonl` (40). Each entry has:
   - `id`, `question`, `area` (civil|criminal), `answerable`;
   - `gold` (`document_id` + `locator`), `reference_answer` (quoting the gold text);
   - optional `law_as_of`.
2. Composition:
   - half civil, half criminal; about 10% unanswerable;
   - civil questions lean on the CPC, Contract, Specific Relief and Limitation statutes, given #148's shortage of civil judgments.
3. Add `eval/validate.py`. It checks the schema, the balance, that no question appears in both sets, and that every gold `document_id`/`locator` exists in the loaded corpus.
4. **Freeze before any tuning.** Commit `eval/testset/FROZEN.md` with the SHA-256 of `heldout.jsonl`, and tag `eval-heldout-v1`. Then build a frozen dump with `pnpm data:dump --freeze eval-frozen-1`.
5. Claude may draft candidate questions from the loaded statutes. **The team reviews and approves every question.**

## Human checklist (not PRs)

| Item | Who | Unblocks |
|---|---|---|
| ✅ Done 2026-11-18 (`caseguard/corpus`). #151: create the free HF org and the private `corpus` dataset (empty `snapshots/`, `dumps/`, README), invite members as write; each member makes a token and adds it to `.env` | Repo lead | Publishing in #152 and #154 (the code is built and tested before this) |
| Set `PKLEGAL_USER_AGENT` to a team contact address before any full crawl | Whoever crawls first | Full crawls in #153 |
| #17: `uv run python main.py --source supreme_court --probe` from a home or university network; record the results in the collector README §1 | Anyone | SCP as a source |
| #148 + case taxonomy proposal: civil share, the `matter_type` → civil/criminal map, the area and proceeding labels | Team + supervisor | Final selection sizes, test-set balance |
| Pick the **integrator** (strongest machine: it embeds with bge-m3) | Team | #154 dumps |
| LHC permission letter; choose demo hosting | Team lead | Later sources and the demo |

## Verification (overall)

- **Per PR:** `uv run ruff check`, `ruff format --check`, `mypy` and `pytest` in the service; DB tests against a bootstrapped `caseguard_test` (as in plan 0024); CI `ci-ok` green.
- **Collector:** live `--limit 5` runs for pakistan_code and SHC, then `--partition pk-code-seed` and `--partition shc-meta`.
- **Data path:**
  1. `pnpm db:up`
  2. `pnpm db:migrate`
  3. `pnpm db:migrate:ai`
  4. `pnpm data:load`
  5. `pnpm data:embed`
  6. `pnpm data:dump`
  7. on a second machine or a fresh volume: `pnpm data:pull --dump latest`
- **M1 demo:** `pnpm stack:up`, sign in, enable a provider (Ollama, NIM or Gemini), ask a seed-statute question. You get cited passages, each with a stored status, and an audit row written. `eval/validate.py` passes, and the held-out set is frozen and tagged.
