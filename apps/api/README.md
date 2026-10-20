# apps/api: CaseGuard API

**Stream A · Node.js LTS, Express, TypeScript, Zod, Pino** ([ADR-0002](../../docs/adr/0002-two-backends-with-strict-boundary.md))

## Owns

Auth (User/Admin), sessions, **the access decision**, cases, documents and uploads, settings, encrypted user API keys, notifications, audit writes and background jobs. It implements `/api/v1` from `packages/contracts`.

## Rules

- Writes only the `app` schema (DB role `caseguard_app`). It reads `corpus` through granted SELECT only.
- Every call to `services/ai` carries the service token and the **resolved scope** (`user_id`, `account_id`, `allowed_case_ids`). The AI service never decides access.
- Keys are encrypted with AES-256-GCM, never returned and never logged (SEC-4).
- Rate limiting is applied to the auth and AI routes (SEC-15).

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
| `GET /api/v1/conversations`                | The user's conversations, most recently active first (`cursor`, `limit`)            |
| `POST /api/v1/conversations`               | Start a conversation (`title`; `caseId` waits for cases, P1)                        |
| `GET /api/v1/conversations/{id}`           | A conversation with its messages (404 if it isn't yours)                            |
| `POST /api/v1/conversations/{id}/messages` | Ask a question; answers only with verified citations (rate-limited, AI must be on)  |
| `GET /api/v1/citations/{id}`               | A citation from your own answers, with its current verification                     |
| `GET /api/v1/sources/{id}`                 | A corpus source record with its official URL                                        |
| `GET /api/v1/admin/users`                  | Admin: every user, oldest first (`cursor`, `limit`)                                 |
| `PATCH /api/v1/admin/users/{userId}`       | Admin: turn AI on or off for a user (`aiEnabled`)                                   |
| `GET /api/v1/admin/providers`              | Admin: the model-provider allow-list                                                |
| `PATCH /api/v1/admin/providers/{id}`       | Admin: switch a provider on or off (`enabled`)                                      |

## Auth

- Passwords are hashed with **argon2id** (`src/auth/password.ts`).
- Sign-in returns a 15-minute **access JWT** (HS256, `JWT_SECRET`) in the body, sent back as `Authorization: Bearer`. The 14-day **refresh token** is set only in the `cg_refresh` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`). Only its SHA-256 is stored, in `app.refresh_tokens`.
- Each refresh spends the token and issues a new one in the same family. Presenting a spent token again revokes the whole family.
- Protect a route with `requireAuth(jwtSecret)`, and add `requireRole("admin")` for admin-only routes (403 for Users).
- Rate limits (SEC-15): 10 failed sign-ins per IP and email, and 20 register/refresh requests per IP, each per 15 minutes. The store is in memory, so limits are per process; use a shared store before running more than one API instance.
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
2. **The AI call:** `ai.answer()` (`/ai/v1/research/answer`, with the service token and a 120 s timeout) gets a fresh `requestId`, up to 20 earlier turns, and the scope `{ userId, accountId, allowedCaseIds: [] }`. The scope is the public corpus only until cases land (P1, FR-CASE-6).
3. **Checking the answer:** it's accepted only if its `requestId` matches and every citation has a stored verification (FR-RES-6), and an unanswerable answer must carry no citations (FR-RES-9). Anything else, or an AI error, returns **503**. Nothing is added to the conversation, and the failure is audited with `outcome = 'error'`.
4. **Saving:** on success, the question, the answer and the audit row are saved in one transaction.

**The audit record** (PRD §13.3, FR-TRUST-12) lives in `app.ai_audit_records`, keyed by `request_id`. It holds the user, account, conversation, case, question, language, `lawAsOf`, outcome, response, the citations with their verifications, the error, the latency and the time. A trigger makes it append-only. `services/ai` writes the other half under the same `request_id` (the model, provider, chunks, graph context, guardrails and translated query) with #20.

**Citations and sources** (#70) proxy to ai.v1 `getCitation` and `getSource`.

- `GET /citations/{id}` first checks that the citation appears in one of the user's own answers. It's a GIN-indexed `citations @>` lookup on `app.messages`. If it doesn't, the route returns 404 without asking `services/ai` (FR-AUTH-4).
- A citation comes back with its **current** stored verification, so re-verification shows up (FR-TRUST-5).
- Sources from the public corpus are readable by any signed-in user.
- Every response from `services/ai` is checked against `src/clients/ai-schemas.ts`. An ai.v1 404 stays a 404. Any other failure, or a malformed record, becomes 503.

`services/ai` doesn't serve `research/answer` yet (#20), so in the running stack an ask returns 503 for now. The tests use a fake that follows ai.v1.

## Admin

- Everything under `/api/v1/admin` requires `requireAuth` and `requireRole("admin")`, so Users get 403. Create the first admin with `pnpm db:create-admin` (see Auth).
- **AI access** (FR-AUTH-3): `PATCH /admin/users/{userId} { aiEnabled }`. Mount `requireAiEnabled(db)` after `requireAuth` on every AI route. It reads `ai_enabled` from the database on each request, so a change applies to the user's very next request.
- **Provider allow-list** (SEC-11): `app.providers` is seeded by migration `0003` from the ADR-0005 presets. Only `ollama` (local) starts enabled, so an Admin switches cloud providers on. The API only toggles entries and never stores provider keys. Enforcement in `services/ai` comes with #21.

## Email

`src/lib/mailer.ts` sends over SMTP with nodemailer, configured by `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and `MAIL_FROM`. Routes get it as `deps.mailer`, and tests inject a fake.

- **Dev:** Mailpit catches everything (`docker compose up -d mailpit`, then open http://localhost:8025). In Docker the api uses `mailpit:1025` automatically.
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
  routes/              one router per contract tag (health, auth; conversations, citations, sources next)
  auth/                passwords (argon2id), tokens (JWT + refresh), store, requireAuth/requireRole
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
