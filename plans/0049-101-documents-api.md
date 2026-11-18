> **Status:** In progress · **Issue:** [#101](https://github.com/CaseGuard-AI/CaseGuard/issues/101) · **PR:** —

# #101: document uploads, storage and the job queue (API)

## Context

The documents contract is merged (#100, PR #197): api.v1 has `uploadDocument`, `listDocuments`, `getDocument`, `deleteDocument`, `downloadDocument` and `retryDocument`, and ai.v1 has the ingestion handoff (`startIngestion`, `getIngestion`, `purgeDocument`), where apps/api submits each attempt and polls it ([ADR-0010](../docs/adr/0010-document-ingestion-handoff.md)). [`data-storage.md` §6](../docs/engineering/data-storage.md) fixes the storage: a blob store in apps/api selected by `STORAGE_DRIVER`, keys `users/{user_id}/cases/{case_id}/{document_id}`, uploads and downloads through the API, and a retryable purge after a delete.

None of it existed in apps/api: no pg-boss, no multipart parser, no blob store, no `uploads` volume. services/ai doesn't serve the ingestion routes yet (Stream C), so until it does a real upload ends `failed` after its retries, which is the contracted path (NFR-13: never dropped).

This is the second step of roadmap item A8 (contract → **API** → web). It runs in parallel with #102 (web, built against the contract) and #103 (notifications, which hooks into this PR's status changes once it merges).

**Requirements:** FR-DOC-1, FR-DOC-2, FR-DOC-3, SEC-6, NFR-13, FR-AUTH-4.

## Decisions

- **Migration `0012_documents`.** `app.documents` (owner, account, case, all FKs cascading; filename, media type, size, storage key, status, flags jsonb, error, pages, attempt, `processed_at`, `deleted_at`, timestamps), indexed on `(owner_user_id, created_at)` and `(case_id, created_at)`. `app.document_stages`: one row per document, attempt and stage, with the owner columns like every owned table (FR-DOC-2 "each stage outcome is logged"). Hand-written `.down.sql`.
- **Delete** sets `deleted_at` and enqueues `document.purge`; the API never shows a deleted row (404). The purge drops the row last.
- **Blob store `src/storage/`:** `put/get/delete/deletePrefix`, only the `fs` driver (`UPLOADS_DIR`). Compose volume `uploads` at `/data/uploads`, read-write in api and read-only in ai; native runs use the git-ignored `/uploads` at the repo root. Keys are checked against a strict pattern so nothing else can become a path. `s3` is a follow-up once demo hosting is decided.
- **Upload:** `busboy` with `files: 1, fields: 0, fileSize: UPLOAD_MAX_MB` (at most 25). Above the limit is a 413, the rest of the body is discarded and the connection closed. The type comes from the bytes (`file-type`), one of `DocumentMediaType`, else 415. The filename loses any directory and control characters and is capped at 255. The case is checked first: missing or foreign is a 404, archived is a 400 on `caseId`. Blob, then row, then job, then 201 `queued`. 60 uploads per user per 15 minutes (the contract's 429).
- **pg-boss 12** in-process, on schema `pgboss` with `createSchema: false`: pg-boss's `CREATE SCHEMA IF NOT EXISTS` fails for `caseguard_app` even when the schema exists, because the role has no CREATE on the database (ADR-0007). `bootstrap.sql` creates `pgboss` owned by `caseguard_app`. `WORKERS_ENABLED` (default true) runs the workers in the api process.
- **`document.ingest` is one step per job:** submit the attempt, or poll it once, then enqueue the next step with `startAfter`. So no worker is held for 30 minutes, and the step is a plain function tested without timers. The poll starts at 2 s, doubles to 30 s, and an attempt gives up after 30 minutes. `running` → `processing`; while an automatic retry waits, the document shows `processing`.
- **Retries (NFR-13):** a `failed` + `retryable` status, an unreachable services/ai or a timeout starts attempt + 1 after 30 s × n, up to `DOCUMENT_MAX_ATTEMPTS` (3) per run; then `failed` with an `error` for the user. A 400 from services/ai fails at once; a 409 means services/ai holds a newer attempt and the step stops. A poll that errors is retried later; a 404 submits again. A step whose document was deleted, or whose attempt was superseded by a user retry, stops.
- **`document.purge`:** ai `purgeDocument`, then the blob, then the row; pg-boss retries it with backoff up to an hour, for about four days. A 404 from services/ai counts as nothing to purge (the contract answers 204 for an unknown document, so a 404 means no ingestion there).
- **`retryDocument`:** only from `failed` or `flagged` (else 409). `attempt + 1`, `queued`, `error` cleared, flags kept until the new attempt replaces them (FR-DOC-4).
- **One funnel for status changes:** `setDocumentStatus(db, documentId, change)` in `src/documents/store.ts` locks the row, applies the change only if the document is still on `change.ifAttempt`, moves `updatedAt` only when the status changes, and returns `{ document, previous }`. #103 hooks in there, inside its transaction.
- **ai client:** `startIngestion`, `getIngestion` and `purgeDocument` in `clients/ai.ts`; `ingestionStatusSchema` in `ai-schemas.ts` (flag and error sizes checked, since they reach the user).
- **Download** streams the blob with the stored media type, `Content-Length`, `Content-Disposition: attachment` (ASCII fallback plus RFC 5987 `filename*`), `nosniff` and `Cache-Control: private, no-store`.
- **Env:** `STORAGE_DRIVER`, `UPLOADS_DIR`, `UPLOAD_MAX_MB` (max 25), `DOCUMENT_MAX_ATTEMPTS`, `WORKERS_ENABLED`, in `config/env.ts`, `.env.example` and Compose.

Branch: `feature/101-documents-api` off `staging`. PR title: `feat(api): document uploads, blob storage and ingestion jobs (FR-DOC-1, FR-DOC-2, FR-DOC-3, SEC-6, NFR-13)`.

## Changes

1. **`apps/api/src/db/schema.ts`**, **`drizzle/0012_documents.sql`** (+ `.down.sql`, snapshot, journal): the two tables.
2. **`apps/api/src/storage/blob-store.ts`**: the interface, `documentKey`, the `fs` driver.
3. **`apps/api/src/documents/store.ts`**: insert, find (own, for jobs), list, `setDocumentStatus`, `recordStages`, `markDeleted`, `removeDocumentRow`. **`documents/upload.ts`**: the multipart reader, `cleanFilename`, `sniffMediaType`.
4. **`apps/api/src/jobs/`**: `queue.ts` (job types, `startBoss`, `pgBossQueue`), `ingest.ts`, `purge.ts`, `workers.ts`.
5. **`apps/api/src/routes/documents.ts`**, mounted in **`app.ts`** (`AppDeps` gains `storage` and `jobs`); **`server.ts`** starts pg-boss before listening and stops it on shutdown; `uploadLimiter` in **`middleware/rate-limit.ts`**.
6. **`apps/api/src/clients/ai.ts`**, **`ai-schemas.ts`**: the ingestion types, methods and schemas.
7. **`apps/api/src/config/env.ts`**, **`.env.example`**, **`docker-compose.yml`** (`uploads` volume), **`apps/api/Dockerfile`** (`/data/uploads` owned by `node`), **`infra/db/sql/bootstrap.sql`** (`pgboss` schema).
8. **Tests:** `test/documents.test.ts` (routes, `expectContract` on every one), `test/document-jobs.test.ts` (ingest and purge steps against the DB with a scripted ai), `test/job-queue.test.ts` (real pg-boss on `pgboss`), `test/documents-unit.test.ts` (filename, disposition, sniffing, fs store), `test/files.ts` (tiny files of each type), `test/stubs.ts` (memory store, recording queue, ingestion stubs, used by every existing test file); `test/contract.ts` picks the served media type and skips binary bodies; `test/migrations.test.ts` and `test/app.test.ts` updated.
9. **Docs:** `apps/api/README.md` (routes, "Documents and jobs", layout), `CHANGELOG.md`, `docs/engineering/work-log.md`, the roadmap's A8 note, `data-storage.md` §6.
10. This plan.

## Verification

- `pnpm --filter ./apps/api run lint` and `typecheck`.
- `pnpm --filter ./apps/api test` with `APP_TEST_DATABASE_URL` on a database bootstrapped by `bootstrap.sql` (it needs the `pgboss` schema).
- `docker compose config` with the `uploads` volume.
- A native smoke test: upload → 201 `queued`, a non-file → 415, download headers, then with no services/ai listening `queued` → `processing` → `failed` ("processing service is unavailable") after three attempts, retry → 202 `queued`, delete → 202 then 404.
- Push, open the PR against `staging`, wait for `ci-ok`. Merging needs the user's explicit go-ahead (`--squash`, never `--delete-branch`).

## Notes from implementation

- **Local test database.** The run used a throwaway `pgvector/pgvector:pg17` container on port 5441, bootstrapped exactly like CI (`app_pw=caseguard_app`), rather than the shared Docker DB, whose credentials stay in the developer's `.env`.
- **pg-boss and the schema:** confirmed that pg-boss 12 fails with "permission denied for database" even with `pgboss` already created, until `createSchema: false`. That's why the schema lives in `bootstrap.sql`. An existing volume needs `pnpm db:rebootstrap`.
- **busboy's `parts: 1`** fires `partsLimit` on a single valid file part, so the limits are `files: 1, fields: 0`, and a second file or any field is a 400.
- **Indexes:** `(owner_user_id, created_at)` and `(case_id, created_at)` rather than the planned single `(owner_user_id, case_id, created_at)`, so both the unfiltered list and the case's list are indexed.
- **Smoke test result:** the purge job retries while services/ai is unreachable (connection refused), keeping the row and file, as intended. In Compose `ai` is always up when `api` is.
