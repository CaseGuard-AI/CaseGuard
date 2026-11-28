> **Status:** In review · **Issue:** [#253](https://github.com/CaseGuard-AI/CaseGuard/issues/253) · **PR:** [#256](https://github.com/CaseGuard-AI/CaseGuard/pull/256) · **Contract:** [0046](0046-100-documents-contract.md), "Stream C"

# #253: Document ingestion routes and worker in services/ai

## Context
apps/api already uploads documents, submits each attempt to services/ai and polls it (#101, ADR-0010, `apps/api/src/jobs/ingest.ts`). services/ai had no `ingestion` routes, so every upload ended in `failed`. Plan 0046 left the services/ai side for Stream C: the three ai.v1 routes, an `ai.ingestions` table so a restart keeps state, and the stages OCR, extract, clean, structure, chunk, embed and index into `ai.case_chunks` with the request's `user_id` and `case_id` (FR-DOC-6). Retrieval of case chunks in scope already exists (`retrieval/hybrid.py`).

## Steps
1. Alembic `0003_ingestions` adds `ai.ingestions` with one row per document: the current attempt, user, case, storage key, media type, filename, state, stages and flags as jsonb, error, retryable, pages, chunk count and timestamps. Mirror it in `db/tables.py` and add it to the `TABLES` set in `test_migrations.py`.
2. Add `DocumentSettings` to the config: `UPLOADS_DIR` (the same variable as apps/api; empty means the repo-root `/uploads`, Compose sets `/data/uploads` for `ai`), `INGEST_WORKERS_ENABLED`, `INGEST_POLL_SECONDS` and `INGEST_MAX_CHARS`. Document them in `.env.example`.
3. `api/ingestion.py` (service token required):
   - `POST /ai/v1/documents/{id}/ingestion` answers 202. It is an upsert guarded by `attempt <`: the same attempt returns its current status, a higher attempt resets the row to `queued`, and a lower one is a 409. It answers 400 when the `storageKey` is not exactly `users/{userId}/cases/{caseId}/{documentId}`, when `allowedCaseIds` is not `[caseId]`, or when the media type is unsupported. All of these answers are RFC 9457 problems.
   - `GET` returns the row as an `IngestionStatus`, or a 404.
   - `DELETE /ai/v1/documents/{id}` deletes the row and the chunks, and always answers 204.
4. `ingest/documents.py` holds the pure stages:
   - Check the file's magic bytes against the declared type.
   - Read PDFs with PyMuPDF and DOCX files with python-docx (paragraphs and table rows, in order).
   - OCR with Tesseract, only with the optional `ocr` extra and the binary installed. Without them, a scanned page is flagged `unreadable_page`.
   - Clean the text: NFKC, control characters, words hyphenated across lines, running headers and footers, and a length cap flagged `truncated`.
   - Structure: flag `not_english` when Arabic script dominates.
   - Chunk with `chunk_document` (paragraph windows) and give each chunk a locator with its page and paragraph, such as `p. 3, para 4`.
5. `ingest/ingestion.py`:
   - The store: submit, status, purge, claim (`FOR UPDATE SKIP LOCKED`) and recover (rows left `running` become `failed` and `retryable` at start-up).
   - `Attempt` runs the stages. Every write is `WHERE attempt = mine`, so a newer attempt or a purge stops the run at its next stage.
   - `index` locks the row, checks the attempt, replaces the chunks and finishes the attempt in one transaction.
   - Error mapping: a `DocumentError` fails the attempt as not retryable. A database or disk error is retryable. Anything else fails with a generic message.
   - `Worker` is an asyncio task started in the FastAPI lifespan. It calls `run_once` in a thread and uses the routes' engine and embedder, including test overrides.
6. Dependencies: `pymupdf` and `python-docx`, plus an optional `ocr` extra with `pytesseract` and `pillow`. The Docker image installs `tesseract-ocr` with English and the `ocr` extra.
7. Tests in `tests/test_ingestion.py`:
   - The pure stages.
   - Route validation and auth.
   - With a database: a PDF round trip (with a scanned page flagged) and a DOCX round trip into `ai.case_chunks`, both with HashEmbedder.
   - With a database: idempotency, the 409, supersede before and during a run, restart recovery, purge, bad files, and the background worker itself.
   - The worker is off in tests (conftest), so the tests run the queue themselves.

## Decisions
- If OCR is needed but unavailable, the `ocr` stage is `flagged` (not `skipped`) with `unreadable_page` per page. The contract keeps `skipped` for a stage that isn't needed. If no text is left at all, the attempt fails with `no_text` and is not retryable.
- A missing blob, a file whose bytes don't match its type, a damaged file and an encrypted file (`encrypted_file`) all fail as not retryable, because another attempt would read the same bytes.
- The recovery at start-up assumes one services/ai process per database, as Compose runs it.
- The contract's media types have no `text/plain`, so there is no text-file path.

## Review fixes (PR #256)
Each fix has its own regression test in `tests/test_ingestion.py`.
1. Scanned PDF pages and TIFF frames are rendered one at a time inside `run_ocr` and freed after OCR. Before, every page was rendered to a 300 DPI PNG up front. The open file is now closed when OCR and extraction are done.
2. Running headers and footers are removed only from a page's first and last non-empty lines, so a bare number mid-page survives.
3. The queue is ordered by `created_at`, and a resubmit keeps it, so a retry keeps its place. apps/api's deadline is set at submit time (`ingest.ts`), so it does count time spent queued. Fixing that needs more than a config change, so it is left for a follow-up (see the PR).
4. `run_ocr` checks for a stop between pages; embedding already did between batches. `Worker.close()` now waits for the attempt in flight, at most `INGEST_SHUTDOWN_SECONDS`.
5. A line-break hyphen is dropped only between lower-case letters. Otherwise only the line break goes: `2019-2020`, `Anti-Terrorism`.
6. DOCX merged cells are deduplicated by their `<w:tc>` element, not by their text.
7. The "looks like a scan" hint is given only when a page needed OCR.
8. A chunk whose text isn't found after the previous chunk gets no page locator. There is no fallback search from the start.
9. Every `DBAPIError` is a 503 problem, including a `ProgrammingError` when `0003` hasn't been applied.

## Verification
- `uv run pytest` in services/ai, with `AI_TEST_DATABASE_URL` pointing at a bootstrapped pgvector database.
- `ruff check`, `ruff format --check` and `mypy` pass.
- CI `ci-ok` is green.
