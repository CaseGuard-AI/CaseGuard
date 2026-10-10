# apps/api: CaseGuard API

**Stream A · Node.js LTS, Express, TypeScript, Zod, Pino** ([ADR-0002](../../docs/adr/0002-two-backends-with-strict-boundary.md))

> Not scaffolded yet. CI skips this app until `package.json` exists.

## Owns

Auth (User/Admin), sessions, **the access decision**, cases, documents and uploads, settings, encrypted user API keys, notifications, audit writes and background jobs. It implements `/api/v1` from `packages/contracts`.

## Rules

- Writes only the `app` schema (DB role `caseguard_app`). It reads `corpus` through granted SELECT only.
- Every call to `services/ai` carries the service token and the **resolved scope** (`user_id`, `account_id`, `allowed_case_ids`). The AI service never decides access.
- Keys are encrypted with AES-256-GCM, never returned and never logged (SEC-4).
- Rate limiting is applied to the auth and AI routes (SEC-15).

## Scaffold (first PR: `feature/api-scaffold`)

The scripts CI expects are `lint`, `typecheck` and `test`. Tests run against the Postgres service container (`DATABASE_URL`).
