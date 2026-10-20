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

| Endpoint                     | Purpose                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/v1/health`         | Liveness                                                                            |
| `GET /api/v1/ready`          | Readiness: Postgres as `caseguard_app` **and** `services/ai` with the service token |
| `POST /api/v1/auth/register` | Create an account and sign in                                                       |
| `POST /api/v1/auth/login`    | Sign in (rate-limited)                                                              |
| `POST /api/v1/auth/refresh`  | Rotate the refresh cookie, get a new access token                                   |
| `POST /api/v1/auth/logout`   | Revoke the refresh token and clear the cookie                                       |
| `GET /api/v1/auth/me`        | The signed-in user                                                                  |

## Auth

- Passwords are hashed with **argon2id** (`src/auth/password.ts`).
- Sign-in returns a 15-minute **access JWT** (HS256, `JWT_SECRET`) in the body, sent back as `Authorization: Bearer`. The 14-day **refresh token** is set only in the `cg_refresh` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`). Only its SHA-256 is stored, in `app.refresh_tokens`.
- Each refresh spends the token and issues a new one in the same family. Presenting a spent token again revokes the whole family.
- Protect a route with `requireAuth(jwtSecret)`, and add `requireRole("admin")` for admin-only routes (403 for Users).
- Rate limits (SEC-15): 10 failed sign-ins per IP and email, and 20 register/refresh requests per IP, each per 15 minutes. The store is in memory, so limits are per process; use a shared store before running more than one API instance.
- To make an admin for now: `UPDATE app.users SET role = 'admin' WHERE lower(email) = lower('…');`

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
  lib/                 logger (secrets redacted), HttpProblem
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
