# ADR-0010: Document ingestion is submitted and polled by apps/api

- **Status:** Accepted
- **Date:** 2026-11-18
- **Deciders:** Stream A (apps/api, apps/web), Stream C (services/ai ingestion)
- **PRD refs:** FR-DOC-2, FR-DOC-3, FR-DOC-4, FR-DOC-6, NFR-13, SEC-6, ADR-0002, data-storage §6

## Context
A user uploads a file to a case (FR-DOC-1). apps/api owns the upload, the blob store, the `app.documents` row, the status the user sees (FR-DOC-3) and the access decision (ADR-0002). The processing (OCR, extract, clean, structure, chunk, embed, index; FR-DOC-2) is Python and runs in services/ai, which writes the chunks to `ai.case_chunks` (data-storage §6). It must run off the request path (SEC-6), and a failure must be retried, never dropped (NFR-13).

So the two services need a handoff: how a job gets from apps/api to services/ai, and how its progress, flags and failures get back into `app.documents`. Each schema has one writer (ADR-0002): services/ai can't write `app`, and apps/api can't write `ai`.

## Decision
apps/api submits each processing attempt to services/ai and polls it until it finishes. services/ai never calls apps/api.

- **Submit.** apps/api's pg-boss job `document.ingest` calls `POST /ai/v1/documents/{documentId}/ingestion` with the scope, case, `storageKey`, media type, filename and `attempt`. services/ai answers 202 at once and does the work in its own workers.
- **Poll.** The same job calls `GET /ai/v1/documents/{documentId}/ingestion` every 2 s at first, backing off to 30 s, for at most 30 minutes. It maps `state` to the document's status (`running` → `processing`, the others by name) and stores the stage outcomes and flags in `app`.
- **Idempotency.** The key is `(documentId, attempt)`. Submitting the same attempt twice changes nothing and returns its status, so a pg-boss job that crashes and runs again is safe. A higher attempt supersedes a running one; a lower one is a 409. services/ai persists its ingestion state, so a restart loses nothing: an attempt cut off by a restart is reported `failed` and `retryable`.
- **Retries are owned by apps/api.** services/ai reports `retryable`; apps/api decides. On a retryable failure it submits `attempt + 1` after a delay, up to 3 attempts (a setting). When they run out, or the failure isn't retryable, the document is `failed` with a user-facing `error` and stays listed for a manual retry (`POST /documents/{documentId}/retry`). Nothing is dropped (NFR-13).
- **Files.** services/ai reads the blob read-only by `storageKey`, which it checks against `users/{userId}/cases/{caseId}/{documentId}`. With `STORAGE_DRIVER=fs` that is the shared `uploads` volume, mounted read-only in `ai`. For `s3`, read-only credentials, decided with demo hosting.
- **Scope.** The request carries the owner's scope; chunks are written with its `userId` and the `caseId`, and retrieval applies the scope in SQL (FR-CASE-6, FR-DOC-6).
- **Delete.** apps/api's retryable `document.purge` job calls `DELETE /ai/v1/documents/{documentId}` (idempotent, stops a running attempt, deletes chunks), then deletes the blob.

The shapes are in `packages/contracts/openapi/ai.v1.yaml` (tag `ingestion`) and the user-facing ones in `api.v1.yaml` (tag `documents`). `DocumentFlag` and `DocumentMediaType` are defined once in ai.v1.

## Alternatives considered
| Option | Why not |
|---|---|
| services/ai calls back into apps/api (a webhook per stage) | apps/api would need an inbound internal endpoint and a second service credential, and ai would need to know where api is. A lost callback leaves a document stuck in `processing` unless apps/api polls anyway, so it still needs the polling path. |
| services/ai writes the status into `app.documents`, or apps/api reads an `ai` view | Breaks single-writer ownership (ADR-0002) and couples the `app` migrations to ai's tables. The user-facing status would change without apps/api knowing, so no notification (#103) could be sent. |
| A shared queue (pg-boss in both services, or Redis) | Two services would share a job table's internals across languages (pg-boss is a Node library), so its schema would become a second contract. A new broker is one more operated dependency against ADR-0005's free-tier, desktop-ready constraints. |
| apps/api sends the file bytes in the request | Up to 25 MB per call over HTTP, sent again on every retry, and services/ai would have to hold them while it works. The blob store already exists and ai only needs to read it. |
| Synchronous processing in the upload request | OCR and embedding take far longer than a request should; SEC-6 asks for processing off the request path. |

## Consequences
- apps/api has one place that knows a document's state, and it sees every change, so notifications (#103) and the stage log (FR-DOC-2) come from there.
- Polling costs a request every few seconds per document in flight. That is small at prototype scale; if it isn't, the poll interval is a setting and a callback can be added later without changing the submit side.
- A status in the web lags the real state by up to one poll interval.
- services/ai must persist ingestion state (an `ai.ingestions` table) and answer from it after a restart.
- The ai service needs read access to the blob store: a read-only volume now, read-only credentials with `s3`.
- Ingestion sends no document text to a remote model provider in P1 (local OCR, in-process embeddings per ADR-0008). If a stage later needs an LLM, `IngestionRequest` gains `allowedProviders` the same way `AnswerRequest` has it (omitted = local only).
