# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [SemVer](https://semver.org/). Release process: [`docs/engineering/branching-and-release.md`](docs/engineering/branching-and-release.md#6-releases).

## [Unreleased]

### Added
- Product Requirements Document v1.0 (`docs/PRD.md`)
- Repository foundation: monorepo layout, branching model (`main` / `staging` / feature branches), contribution guide, ADRs 0001–0006, CI workflows, PR/issue templates, local Postgres + pgvector compose file
- Full Docker stack: `docker compose up --build` (or `pnpm stack:up`) runs db, ai, api and web healthy. ai is unreachable from the host and from web, with outbound-only egress for model providers. A CI `compose-smoke` job boots the stack on infra changes (#23)
- `app` schema migrations with Drizzle (ADR-0007): `users` and `accounts` tables, `pnpm db:migrate` / `db:migrate:down`, run as `caseguard_app` and applied by the api image on start (#9)
- Auth for `/api/v1/auth/*` (register, login, refresh, logout, me): argon2id passwords, a 15-minute access JWT and a rotating 14-day refresh token in the `cg_refresh` HttpOnly cookie with reuse detection, rate-limited login, `requireAuth` / `requireRole` for User/Admin, and contract tests against `api.v1.yaml` (#10)
- Transactional email for the api: an SMTP mailer (nodemailer) configured by `SMTP_*` / `MAIL_FROM`, and Mailpit in docker-compose and the CI api job to catch dev and test mail at http://localhost:8025 (#61)
- Password reset for the api (`POST /auth/password-reset`, `POST /auth/password-reset/confirm`): an emailed single-use link that expires in 30 minutes, always 202 with no account enumeration, rate limits, and a confirm that revokes every session (#53)
- `pnpm db:create-admin --email … [--name …]`: promotes an existing user to Admin, or creates one with the password typed at a hidden prompt or read from stdin, never taken as an argument (#54)
- Admin endpoints for the api: `GET /admin/users` (paged), `PATCH /admin/users/{userId}` to turn AI on or off for a user, and the provider allow-list `GET /admin/providers` / `PATCH /admin/providers/{id}`, seeded with only Ollama (local) enabled; plus `requireAiEnabled` for AI routes (#55)
- Conversations and the ask route for the api (`/conversations*`): proxies to ai.v1 `research/answer` with the resolved scope, accepts only answers whose citations are all verified (FR-RES-6), saves question and answer together, writes an append-only audit record keyed by `requestId` (FR-TRUST-12), returns 403 when AI is disabled, and rate-limits questions (#13)
- api.v1 contract: `getCitation` and `getSource` declare `503 Unavailable` for when the AI service can't answer (#70)
- api.v1 contract: password reset, with `POST /auth/password-reset` (always 202) and `POST /auth/password-reset/confirm` (204, revokes existing sessions) (#53)
- Model provider presets in `.env.example` (NVIDIA NIM, Gemini, Groq, OpenRouter, OpenAI, Anthropic, Ollama) and `pnpm llm:check` to test a configured provider and key
- api.v1 contract: Admin endpoints for AI access, with `GET /admin/users`, `PATCH /admin/users/{userId}` (`aiEnabled`), and the provider allow-list `GET /admin/providers` and `PATCH /admin/providers/{providerId}` (#55)
