> **Status:** In progress · **Issue:** [#100](https://github.com/CaseGuard-AI/CaseGuard/issues/100) · **PR:** —

# #100: documents and the ingestion handoff in the contracts

## Context

FR-DOC-1 (P1) asks to accept PDF, DOCX and image or scanned files, reject the rest, and enforce a size limit (default 25 MB). FR-DOC-2 asks to process uploads asynchronously (OCR where needed → extract → clean → structure → chunk → embed → index) with each stage's outcome logged; FR-DOC-3 to show `queued / processing / done / flagged / failed`; FR-DOC-4 to flag uncertain OCR or extraction and never show it as clean; FR-DOC-6 that a processed document is retrievable within the owner's scope only. NFR-13: a failed document is flagged and retried, never dropped. SEC-6: type and size limits, stored outside the web root, processed off the request path.

Neither contract has documents today. `docs/engineering/data-storage.md` §6 (#145) already fixes the storage: a blob store in `apps/api` (`fs` or `s3`), uploads and downloads through the API with an ownership check, keys `users/{user_id}/cases/{case_id}/{document_id}`, jobs carrying `{document_id, user_id, case_id, storage_key}`, chunks in the private `ai` schema (`ai.case_chunks`, already migrated in #15), and deletion purging the blob and the chunks through a retryable job. ADR-0002 gives documents and the access decision to `apps/api`; `services/ai` is internal, takes a service token and applies the scope in SQL.

This is item A8 of [`docs/engineering/stream-a-roadmap.md`](../docs/engineering/stream-a-roadmap.md): #100 (this contract) → #101 (API: storage, jobs) → #102 (web) → #103 (notifications); the workers that do OCR, chunking and embedding are Stream C. Under `packages/contracts/README.md`, a contract change is its own PR, so, as with #97, this PR changes only the contracts, the generated types and the docs.

**Requirements:** FR-DOC-1, FR-DOC-2, FR-DOC-3, FR-DOC-4, FR-DOC-6, NFR-13, SEC-6 (and FR-AUTH-4: the caller's own documents only).

## Decisions

**Owner (2026-11-18):**
- **The handoff is submit + poll.** apps/api's pg-boss job calls `POST /ai/v1/documents/{documentId}/ingestion` (202, idempotent) and then polls `GET …/ingestion`. services/ai never calls apps/api, and apps/api stays the only writer of the `app` schema. Recorded as ADR-0010.

**From the PRD, `data-storage.md` §6 and the existing contracts:**
- **Upload is `POST /cases/{caseId}/documents`**, `multipart/form-data` with one part `file`. A document always belongs to a case (the storage key has the case in it). 201 with the `Document` in status `queued`: the blob is stored and the job enqueued before the response, nothing is processed on the request path (SEC-6).
- **Allowed types are one enum, `DocumentMediaType`** (`application/pdf`, DOCX, `image/png`, `image/jpeg`, `image/tiff`), defined in ai.v1 and `$ref`'d by api.v1 like `Language`, because services/ai must be able to process every type the API accepts. The type is found by sniffing the content, never from the client's `Content-Type` or the extension. 415 for anything else, 413 above 25 MB (26 214 400 bytes).
- **Errors on upload.** A case that doesn't exist or isn't the caller's is a 404 (the case is a path parameter, as in `getCase`); an archived case is a 400 with `errors[].path` of `caseId` (the same rule as saving a conversation to it).
- **`listDocuments` is `GET /documents?caseId=`**, newest first, cursor paged, like `listConversations?caseId=`: a case that isn't the caller's gives an empty page. This is the case dashboard's documents link (FR-CASE-4).
- **Download goes through the API** (`GET /documents/{documentId}/file`), streamed with the stored media type, `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. No presigned URLs in P1 (§6).
- **Delete is 202.** The document is gone from the API at once (404 afterwards); the blob and the chunks are purged by a retryable job (§6). A document can be deleted in any status, also in an archived case.
- **Retry is `POST /documents/{documentId}/retry`**, from `failed` or `flagged` only, else 409. It starts a new attempt and returns the document `queued`.
- **`flagged` means processed and retrievable, with uncertain parts.** `Document.flags` says which stage, page and why; the web never shows such a document as clean (FR-DOC-4).
- **`DocumentFlag { stage, code, message, page }` is defined once, in ai.v1**, and api.v1 `$ref`s it. `stage` is the PRD's seven stages (`ocr`, `extract`, `clean`, `structure`, `chunk`, `embed`, `index`); `code` is a snake_case string with known examples rather than an enum, so Stream C can add a code without a contract change.
- **Ingestion is idempotent per `(documentId, attempt)`.** The same attempt again returns its current status; a higher attempt supersedes the running one; a lower one is a 409. services/ai reports `retryable`; apps/api decides whether to retry (NFR-13).
- **Ingestion uses no remote model provider in P1** (OCR is local, embeddings in-process per ADR-0008), so `IngestionRequest` has no `allowedProviders`. Adding one later is additive and fails closed (omitted = local only).
- **services/ai reads the blob read-only by `storageKey`**, which must equal `users/{scope.userId}/cases/{caseId}/{documentId}` (else 400), so a request can't point at another user's file. With `fs` that is the shared `uploads` volume; for `s3`, read-only credentials, decided with demo hosting.
- **Additive, no `!`, no version bump.** The existing `Conflict` response's description is widened from "Already exists" to cover a conflicting state.

Branch: `feature/100-documents-contract` off `staging`. PR title: `feat(contracts): documents and the ingestion handoff (FR-DOC-1, FR-DOC-2, FR-DOC-3, FR-DOC-4, FR-DOC-6)`.

## Changes

1. **`packages/contracts/openapi/api.v1.yaml`**
   - Tag `documents`; an M3 line in the info description.
   - Parameters `DocumentId` (path), `DocumentCaseId` (`caseId` query filter).
   - Responses `PayloadTooLarge` (413), `UnsupportedMediaType` (415); `Conflict` description widened.
   - Paths: `POST /cases/{caseId}/documents` (`uploadDocument`), `GET /documents` (`listDocuments`), `GET` and `DELETE /documents/{documentId}` (`getDocument`, `deleteDocument`), `GET /documents/{documentId}/file` (`downloadDocument`), `POST /documents/{documentId}/retry` (`retryDocument`).
   - Schemas: `DocumentStatus`, `Document`, `DocumentUpload` (the multipart body), and the aliases `DocumentFlag`, `DocumentMediaType` to ai.v1.
2. **`packages/contracts/openapi/ai.v1.yaml`**
   - Tag `ingestion`; parameter `DocumentId`; response `Conflict`.
   - Paths: `POST` and `GET /ai/v1/documents/{documentId}/ingestion` (`startIngestion`, `getIngestion`), `DELETE /ai/v1/documents/{documentId}` (`purgeDocument`).
   - Schemas: `DocumentMediaType`, `DocumentStage`, `DocumentFlag`, `IngestionRequest`, `IngestionState`, `IngestionStage`, `IngestionStatus`.
   - The polling rules for the caller (backoff, timeout, retries, status mapping) are written in the operation descriptions.
3. **`packages/contracts/generated/api.v1.ts`**: regenerated with `pnpm gen:contracts`. Never edited by hand.
4. **`docs/adr/0010-document-ingestion-handoff.md`**: submit + poll, the alternatives, idempotency and who owns retries.
5. **`packages/contracts/README.md`**: the Status line mentions documents and the ingestion handoff.
6. **`CHANGELOG.md`**: an Added entry under Unreleased. **`docs/engineering/work-log.md`**: a heading. **`docs/engineering/stream-a-roadmap.md`**: the A8 note says the contract is done (#100).
7. This plan.

## Left for the implementation PRs

- **#101 (API):** `app.documents` (owner, account, case, filename, media type, size, status, flags as jsonb, error, pages, attempt, timestamps) and `app.document_stages` (one row per attempt and stage: FR-DOC-2 "each stage outcome is logged"), migration with `.down.sql`; the blob store (`STORAGE_DRIVER=fs|s3`, put/get/delete/deletePrefix); multipart parsing with a hard 25 MB stream limit and content sniffing; the pg-boss jobs `document.ingest` (submit, poll with backoff, map state, retry) and `document.purge` (ai purge, then blob delete, retried); the routes with `expectContract` tests; a typed ai client plus zod schemas for `IngestionStatus` in `clients/ai-schemas.ts`; the `uploads` volume in Compose (api read-write).
- **#102 (web):** upload on the case dashboard (drag and drop, client-side type and size check mirroring the contract), the documents list with status chips and polling while `queued`/`processing`, flags shown per page, download, delete with confirmation, retry; en/ur strings.
- **#103 (notifications):** a notification when a document reaches `done`, `flagged` or `failed`, driven by the job's status change.
- **Stream C (services/ai ingestion workers):** the three ai.v1 routes; an `ai.ingestions` table (document, attempt, state, stages, flags) so a restart does not lose state; OCR, extract, clean, structure, chunk, embed, index into `ai.case_chunks` with `user_id`/`case_id` from the request (FR-DOC-6); the `uploads` volume mounted read-only; retrieval of case chunks inside the scope (FR-CASE-6).

## Verification

- `npx @redocly/cli lint packages/contracts/openapi/*.yaml` passes (config `/redocly.yaml`).
- `pnpm gen:contracts` leaves no diff after the commit (the CI `contracts` job's staleness check).
- `pnpm --filter ./apps/web run typecheck` and `pnpm --filter ./apps/api run typecheck` still pass (additive types).
- In the generated `api.v1.ts`: `operations["uploadDocument"]` has a `multipart/form-data` body with `file`; `operations["downloadDocument"]` has a binary 200; `components["schemas"]["Document"]` has every field required; `DocumentFlag` and `DocumentMediaType` come from ai.v1.
- CI `ci-ok` is green, including the `contracts` job.
