# apps/api: CaseGuard API

**Stream A · Node.js LTS, Express, TypeScript, Zod, Pino** ([ADR-0002](../../docs/adr/0002-two-backends-with-strict-boundary.md))

## Owns

Auth (Lawyer/Researcher/Admin), sessions, **the access decision**, cases, documents and uploads, settings, encrypted user API keys, notifications, audit writes and background jobs. It implements `/api/v1` from `packages/contracts`.

## Rules

- Writes only the `app` schema (DB role `caseguard_app`). It reads `corpus` through granted SELECT only.
- Every call to `services/ai` carries the service token and the **resolved scope** (`user_id`, `account_id`, `allowed_case_ids`). The AI service never decides access.
- Keys are encrypted with AES-256-GCM, never returned and never logged (SEC-4).
- Rate limiting is applied to the auth, AI and upload routes (SEC-15).

## Run locally

```bash
pnpm install                 # from the repo root (or: pnpm setup)
pnpm dev:api                 # tsx watch → http://localhost:4000/api/v1
```

Config is validated at startup (`src/config/env.ts`). It's read from real environment variables, then `apps/api/.env`, then the repo-root `.env`. A missing or weak value stops the server with a readable message.

| Endpoint                                   | Purpose                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `GET /api/v1/health`                       | Liveness                                                                            |
| `GET /api/v1/ready`                        | Readiness: Postgres as `caseguard_app` **and** `services/ai` with the service token |
| `POST /api/v1/auth/register`               | Create an account and sign in                                                       |
| `POST /api/v1/auth/login`                  | Sign in (rate-limited)                                                              |
| `POST /api/v1/auth/refresh`                | Rotate the refresh cookie, get a new access token                                   |
| `POST /api/v1/auth/logout`                 | Revoke the refresh token and clear the cookie                                       |
| `GET /api/v1/auth/me`                      | The signed-in user                                                                  |
| `POST /api/v1/auth/password-reset`         | Email a reset link (always 202)                                                     |
| `POST /api/v1/auth/password-reset/confirm` | Set a new password with the emailed token; ends every session                       |
| `GET /api/v1/me/settings`                  | Your own settings: name, language, theme                                            |
| `PATCH /api/v1/me/settings`                | Change some of your own settings (strict, partial)                                  |
| `GET /api/v1/cases`                        | The user's cases, most recently updated first (`state=active\|archived\|all`, `cursor`, `limit`) |
| `POST /api/v1/cases`                       | Create a case (only `title` required; Table 4.29 fields)                            |
| `GET /api/v1/cases/{id}`                   | One case (404 if it isn't yours)                                                    |
| `PATCH /api/v1/cases/{id}`                 | Partial edit; `null` and `[]` clear                                                 |
| `POST /api/v1/cases/{id}/archive`          | Archive (idempotent; nothing is deleted)                                            |
| `POST /api/v1/cases/{id}/unarchive`        | Restore an archived case (idempotent)                                               |
| `POST /api/v1/cases/{id}/documents`        | Upload one file (`multipart/form-data`, part `file`) to an active case; 201 `queued` |
| `GET /api/v1/documents`                    | The user's documents, newest first (`caseId`, `cursor`, `limit`)                    |
| `GET /api/v1/documents/{id}`               | One document and its processing status (poll while `queued`/`processing`)           |
| `DELETE /api/v1/documents/{id}`            | Delete (202); the file and chunks are purged by a background job                    |
| `GET /api/v1/documents/{id}/file`          | Download the original (attachment, `nosniff`)                                       |
| `POST /api/v1/documents/{id}/retry`        | Process a `failed` or `flagged` document again (409 from any other status)          |
| `GET /api/v1/notifications`                | The user's notifications, newest first (`unread=true`, `cursor`, `limit`), with `unreadCount` |
| `POST /api/v1/notifications/{id}/read`     | Mark one read (idempotent; 404 if it isn't yours)                                     |
| `POST /api/v1/notifications/read-all`      | Mark all of yours read                                                              |
| `GET /api/v1/conversations`                | The user's conversations, most recently active first (`cursor`, `limit`, `caseId`)  |
| `POST /api/v1/conversations`               | Start a conversation (`title`, `caseId`: one of your active cases)                  |
| `GET /api/v1/conversations/{id}`           | A conversation with its messages (404 if it isn't yours)                            |
| `PATCH /api/v1/conversations/{id}`         | Save to one of your active cases, or detach with `caseId: null`                     |
| `POST /api/v1/conversations/{id}/messages` | Ask a question; answers only with verified citations (rate-limited, AI must be on)  |
| `GET /api/v1/citations/{id}`               | A citation from your own answers, with its current verification                     |
| `GET /api/v1/sources/{id}`                 | A corpus source record with its official URL                                        |
| `GET /api/v1/lint/rulesets`                | The linter's rule sets, each rule with its source or `null`                         |
| `POST /api/v1/lint-reports`                | Lint a bail application or plaint and keep the report (`caseId`, `draftId` optional) |
| `GET /api/v1/lint-reports`                 | Your lint reports, newest first (`caseId`, `cursor`, `limit`), with finding counts  |
| `GET /api/v1/lint-reports/{id}`            | A report with its text and findings (404 if it isn't yours)                         |
| `DELETE /api/v1/lint-reports/{id}`         | Delete a report (204)                                                               |
| `GET /api/v1/admin/users`                  | Admin: every user, oldest first (`cursor`, `limit`)                                 |
| `PATCH /api/v1/admin/users/{userId}`       | Admin: turn AI on or off for a user (`aiEnabled`)                                   |
| `GET /api/v1/admin/providers`              | Admin: the model-provider allow-list                                                |
| `PATCH /api/v1/admin/providers/{id}`       | Admin: switch a provider on or off (`enabled`)                                      |

## Auth

- Passwords are hashed with **argon2id** (`src/auth/password.ts`).
- Sign-in returns a 15-minute **access JWT** (HS256, `JWT_SECRET`) in the body, sent back as `Authorization: Bearer`. The 14-day **refresh token** is set only in the `cg_refresh` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`). Only its SHA-256 is stored, in `app.refresh_tokens`.
- Each refresh spends the token and issues a new one in the same family. Presenting a spent token again revokes the whole family.
- **Roles** (FR-AUTH-2): `lawyer`, `researcher` and `admin`. `POST /auth/register` takes an optional `role` of `lawyer` (the default) or `researcher`; `admin` or any other value is a 400, so admins come only from `pnpm db:create-admin`. Migration `0008` renamed the old `user` role to `lawyer`. An access token signed before it (role `user`) gets a 401, and the web's refresh issues one with the new role.
- Protect a route with `requireAuth(jwtSecret)`, and add `requireRole("admin")` for admin-only routes (403 for Lawyers and Researchers).
- Rate limits (SEC-15): 10 failed sign-ins per IP and email, 20 register and password-reset requests per IP, and a separate 120 refreshes per IP, each per 15 minutes. Refresh has its own budget because the web refreshes on every page load (#83). The store is in memory, so limits are per process; use a shared store before running more than one API instance.
- **Password reset** (#53):
  - `POST /auth/password-reset` answers 202 before it looks anything up, so neither the status nor the timing reveals whether an account exists. If the account does exist, it emails `RESET_URL_BASE?token=…` in the background.
  - The token is valid for 30 minutes and works once. Only its SHA-256 is stored, in `app.password_reset_tokens`, and requesting a new link spends the older ones.
  - Confirming sets the new password (argon2id) and revokes every refresh token the user has.
  - Rate limits: 5 requests per IP and email, plus the shared 20 per IP, each per 15 minutes.
- **Making an admin** (#54):

  ```bash
  pnpm db:create-admin --email ops@example.com                  # promote an existing user (no password asked)
  pnpm db:create-admin --email ops@example.com --name "Ops"     # create a new admin: prompts for the password twice
  echo "$PASSWORD" | pnpm db:create-admin --email … --name …   # non-interactive: first line of stdin
  docker compose exec api node dist/db/create-admin.js --email …   # in the running container
  ```

  The password is never accepted as an argument, because it would land in shell history and the process list. The command runs as `caseguard_app` (`API_DATABASE_URL`). The role takes effect at the user's next sign-in or refresh.

## Research (conversations and ask)

`POST /conversations/{id}/messages` runs as follows:

1. **Checks:** `requireAuth`, then `aiLimiter` (30 questions per user per 15 minutes, SEC-15), then `requireAiEnabled` (403 when AI is off, FR-AUTH-3). A conversation that isn't the user's gives 404 (FR-AUTH-4).
2. **The AI call:** `ai.answer()` (`/ai/v1/research/answer`, with the service token and a 120 s timeout) gets a fresh `requestId`, up to 20 earlier turns, and the scope `{ userId, accountId, allowedCaseIds }`: `[caseId]` for a conversation saved to a case, else `[]` (the public corpus only). `case_id` can only be set to one of the caller's own active cases, so the scope never names another user's case (FR-CASE-6, SEC-8).
3. **Checking the answer:** it's accepted only if its `requestId` matches and every citation has a stored verification (FR-RES-6), and an unanswerable answer must carry no citations (FR-RES-9). Anything else, or an AI error, returns **503**. Nothing is added to the conversation, and the failure is audited with `outcome = 'error'`.
4. **Saving:** on success, the question, the answer and the audit row are saved in one transaction.

**The audit record** (PRD §13.3, FR-TRUST-12) lives in `app.ai_audit_records`, keyed by `request_id`. It holds the user, account, conversation, case, question, language, `lawAsOf`, outcome, response, the citations with their verifications, the error, the latency and the time. A trigger makes it append-only. `services/ai` writes the other half under the same `request_id` (the model, provider, chunks, graph context, guardrails and translated query) with #20.

**Citations and sources** (#70) proxy to ai.v1 `getCitation` and `getSource`.

- `GET /citations/{id}` first checks that the citation appears in one of the user's own answers. It's a GIN-indexed `citations @>` lookup on `app.messages`. If it doesn't, the route returns 404 without asking `services/ai` (FR-AUTH-4).
- A citation comes back with its **current** stored verification, so re-verification shows up (FR-TRUST-5).
- Sources from the public corpus are readable by any signed-in user.
- Every response from `services/ai` is checked against `src/clients/ai-schemas.ts`. An ai.v1 404 stays a 404. Any other failure, or a malformed record, becomes 503.

`services/ai` doesn't serve `research/answer` yet (#20), so in the running stack an ask returns 503 for now. The tests use a fake that follows ai.v1.

## Documents and jobs

Uploads (#101) follow [data-storage §6](../../docs/engineering/data-storage.md) and [ADR-0010](../../docs/adr/0010-document-ingestion-handoff.md).

- **Upload** (FR-DOC-1, SEC-6): one `file` part, read into memory with a hard limit of `UPLOAD_MAX_MB` (at most 25; larger is 413). The type is sniffed from the content with `file-type`: PDF, DOCX, PNG, JPEG or TIFF, else 415. The part's `Content-Type` and the extension are ignored. The case must be the caller's (404) and active (400 on `caseId`). The filename loses any directory and control characters and lives only in `app.documents`. 60 uploads per user per 15 minutes.
- **Storage:** `src/storage/blob-store.ts`, `STORAGE_DRIVER=fs` (the only driver so far). Files are kept at `UPLOADS_DIR/users/{userId}/cases/{caseId}/{documentId}`: the Compose `uploads` volume (read-write in api, read-only in ai), or the git-ignored `/uploads` at the repo root for native runs. Downloads stream through the API after the ownership check.
- **Jobs:** pg-boss on the `pgboss` schema, which `bootstrap.sql` creates (`caseguard_app` can't CREATE SCHEMA, so pg-boss runs with `createSchema: false`). The workers run in the api process when `WORKERS_ENABLED` (default on).
  - `document.ingest` (`src/jobs/ingest.ts`) is one step per job: submit the attempt to services/ai, or poll it once, then enqueue the next step with a delay (2 s doubling to 30 s; an attempt gives up after 30 minutes). Each poll copies the stage outcomes into `app.document_stages` (FR-DOC-2). A retryable failure, or services/ai being unreachable, starts the next attempt after 30 s × n, up to `DOCUMENT_MAX_ATTEMPTS` (3); the document shows `processing` meanwhile. Then it's `failed` with an `error`, and stays listed for the user to retry (NFR-13).
  - `document.purge` (`src/jobs/purge.ts`), after a delete: ai `purgeDocument`, then the blob, then the row. Retried by pg-boss for about four days.
  - Every status change goes through `setDocumentStatus` (`src/documents/store.ts`), which is where notifications (#103) hook in.
- **Existing databases:** a volume bootstrapped before #101 has no `pgboss` schema, and the api won't start. Run `pnpm db:rebootstrap` (or `CREATE SCHEMA pgboss AUTHORIZATION caseguard_app;` as the superuser).
- `services/ai` doesn't serve ingestion yet (Stream C), so in the running stack an upload ends `failed` after its retries. The tests use a fake that follows ai.v1.

## Lint reports

The procedural linter (#215, [ADR-0012](../../docs/adr/0012-deterministic-read-only-linter.md)) runs in services/ai. apps/api keeps the reports in `app.lint_reports` (migration `0015_lint_reports`).

- **Create:** the case, if given, must be the caller's and active (400 on `caseId`), checked before services/ai is asked. `draftId` is only checked as a uuid and recorded; checking it is the caller's draft waits for the drafts table (Track D). The text is limited to 200,000 characters (code points, as the contract counts) and must be valid Unicode.
- **Read-only (FR-LINT-3):** the text is stored exactly as sent. services/ai's `inputSha256` must equal apps/api's own SHA-256 of the same UTF-8 bytes, the result must be for this request, and every span must lie within the text; otherwise the answer is 503 and nothing is stored.
- **No model provider is called,** so the routes work with AI features off and nothing is written to `ai_audit_records`. The text is never logged. 60 reports per user per 15 minutes.
- Owner only: another user's report is a 404. A case's reports are deleted with the case.

## Settings

- `GET`/`PATCH /api/v1/me/settings` (FR-SET-1) read and change the signed-in user's `name`, `locale` and `theme`. There's no user id in the path, so a user can only ever reach their own (FR-AUTH-4).
- `PATCH` is **strict and partial**. Send only what changes. An empty body, or any field the contract doesn't list (`role`, `email`, `aiEnabled`), is a 400 with `errors[]`, and nothing is saved. `name` follows the same rules as at registration (trimmed, 1–120).
- `theme` is `light`, `dark` or `system`, stored on `app.users` (migration `0007`). Users who never chose one have `system`.
- `/auth/me` and `/auth/refresh` read the user from the database, so a changed `name` or `locale` shows there straight away. The web picks it up on its next refresh. The access token carries neither.

## Admin

- Everything under `/api/v1/admin` requires `requireAuth` and `requireRole("admin")`, so Lawyers and Researchers get 403. Create the first admin with `pnpm db:create-admin` (see Auth).
- **AI access** (FR-AUTH-3): `PATCH /admin/users/{userId} { aiEnabled }`. Mount `requireAiEnabled(db)` after `requireAuth` on every AI route. It reads `ai_enabled` from the database on each request, so a change applies to the user's very next request.
- **Provider allow-list** (SEC-11): `app.providers` is seeded by migration `0003` from the ADR-0005 presets. Only `ollama` (local) starts enabled, so an Admin switches cloud providers on. The API only toggles entries and never stores provider keys.
- **Sending the allow-list** (#75): every question sends the enabled ids explicitly as `allowedProviders`, read fresh on each request. To services/ai, an omitted list means "local only". With nothing enabled, the ask route returns 503 without calling services/ai. The list in effect is stored on the audit row (`allowed_providers`). Enforcement inside `services/ai` is #21.

## Email

`src/lib/mailer.ts` sends over SMTP with nodemailer, configured by `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and `MAIL_FROM`. Routes get it as `deps.mailer`, and tests inject a fake.

- **Dev:** Mailpit catches everything (`docker compose up -d mailpit`, then open http://localhost:8025). In Docker the api uses `mailpit:1025` automatically.
- **Real email (Gmail):** see [Sending real email](../../docs/engineering/local-setup.md#sending-real-email-gmail). `pnpm mail:check --to <email>` (`src/lib/mail-check.ts`) sends one test message with the current `.env` and explains common failures.
- **No `SMTP_HOST`:** the API still starts, but every send rejects with `MailNotConfiguredError` and logs an error.
- **Logging:** only the subject and message id are logged, never the recipient or the body, because bodies can hold reset links.
- **Tests:** `test/mailer.test.ts` sends to a real Mailpit when `MAILPIT_URL` is set (CI runs Mailpit as a service container). `MAILPIT_SMTP_PORT` defaults to 1025.

## Scripts

`dev`, `build`, `start`, `lint`, `typecheck`, `test` (vitest + supertest) and `format`. CI runs `lint`, `typecheck` and `test` against a Postgres service container (`DATABASE_URL`).

## Layout

```
src/
  server.ts            process entry: env, logger, pg pool, AI client, graceful shutdown
  app.ts               createApp(deps): middleware + /api/v1 router (dependencies injected, so it's testable)
  config/env.ts        Zod-validated environment
  clients/ai.ts        /ai/v1 client (bearer service token)
  routes/              one router per contract tag (health, auth, settings, admin, cases, documents, conversations, sources)
  documents/           document store (incl. setDocumentStatus) and the multipart upload reader
  lint/                lint report store
  storage/             blob store for uploaded files (fs driver)
  jobs/                pg-boss queue and the document.ingest / document.purge workers
  auth/                passwords (argon2id), tokens (JWT + refresh), store, requireAuth/requireRole
  settings/            store for the user's own settings (FR-SET-1)
  middleware/          errors (RFC 9457 problem+json), rate limits
  lib/                 logger (secrets redacted), HttpProblem, mailer (SMTP)
  db/                  Drizzle schema, client and migration runner (up/down)
drizzle/               generated SQL migrations + hand-written .down.sql
test/                  vitest + supertest
Dockerfile             production image (build from the repo root)
```

## Database migrations

The `app` schema is managed with **Drizzle** ([ADR-0007](../../docs/adr/0007-drizzle-for-app-schema.md)). Migrations run as `caseguard_app` (`API_DATABASE_URL`). The schema itself comes from `pnpm db:bootstrap`.

```bash
pnpm db:migrate                               # apply pending migrations (from the repo root)
pnpm --filter ./apps/api db:migrate:down      # revert the newest migration
```

To change the schema:

1. Edit `src/db/schema.ts`.
2. Run `pnpm --filter ./apps/api db:generate`. It writes `drizzle/NNNN_<tag>.sql`. Review it and remove any `CREATE SCHEMA "app"`.
3. Write `drizzle/NNNN_<tag>.down.sql` by hand to reverse it. A test fails without it.
4. Run `pnpm db:migrate`, then `pnpm --filter ./apps/api test`. The DB tests run when `APP_TEST_DATABASE_URL` points at a bootstrapped database as `caseguard_app`.

The Docker image applies pending migrations before it starts the server.
