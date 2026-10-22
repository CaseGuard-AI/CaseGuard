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
- Citation and source routes for the api (`GET /citations/{id}`, `GET /sources/{id}`): proxy to ai.v1 with the service token, only citations from the user's own answers (404 otherwise, without calling the AI service), the current verification, and every AI response validated (#70)
- ai.v1 contract: `AnswerRequest.allowedProviders`, the Admin's provider allow-list passed to services/ai, which may call only those providers (omitted = local only; 503 if no allowed provider fits). `ProviderId` now lives in ai.v1 and api.v1 references it (#21)
- The api's ask route sends the Admin's provider allow-list as `allowedProviders` on every question, records it on the audit row, and returns 503 without calling services/ai when no provider is enabled (#75)
- api.v1 contract: password reset, with `POST /auth/password-reset` (always 202) and `POST /auth/password-reset/confirm` (204, revokes existing sessions) (#53)
- Web app shell ported from the prototype: shadcn/ui (new-york, RTL), the oklch design tokens, Inter + Noto Nastaliq Urdu, a collapsible navy sidebar (a sheet on mobile) with all 10 screens + Settings, a header with breadcrumb and language switch, placeholder routes, a localized not-found page and an RTL class check in the tests (#11)
- Generated TypeScript types for api.v1 (`pnpm gen:contracts`, openapi-typescript) in `@caseguard/contracts`, a CI check that fails when they are stale, and a typed `openapi-fetch` client in apps/web with a `problemOf()` helper for problem+json errors (#79)
- Login and register pages for the web (`/login`, `/register`) with an in-memory session: restored through the refresh cookie, refreshes serialised across tabs (Web Locks) to respect reuse detection, the session shared and sign-out mirrored across tabs, localised problem+json field errors, every app screen guarded with `?next=`, and the user's name, role and Sign out in the shell (#12)
- Forgot-password and reset-password pages for the web (`/forgot-password`, `/reset-password`) in English and Urdu: always "check your inbox" so no account is revealed, the token removed from the URL and never sent as a Referer, an invalid or expired link offering a new one, sign-out in every tab after a reset, and a "Forgot password?" link on login (#62)
- Research Hub for the web (`/research`): ask box and thread kept in `?c=`, answers with `[[c:id]]` markers as numbered citation chips, an evidence list and a source panel with trust badge, flags, last-verified date, the verbatim quote in its original language and the official URL. Every view of a citation shares one stored status (FR-TRUST-10), and AI-off, rate-limit and service-unavailable errors are localised (#14)
- Admin console for the web (`/admin`, Admins only): per-user AI access switches with paging, and the model-provider allow-list labelled local or cloud, with a confirmation before turning on a cloud provider and a warning when none is enabled. Changes show only once the API confirms them (#91)
- api.v1 contract: user settings, with `GET /me/settings` and a partial `PATCH /me/settings` for `name`, `locale` (en/ur) and `theme` (light/dark/system, default system). The caller's own settings only (#88)
- User settings API: `GET /me/settings` and a strict partial `PATCH /me/settings` for name, language and theme, with a `theme` column on `app.users` (migration `0007_user_theme`, default `system`, check constraint) and contract tests (#89)
- Settings page for the web (`/settings`): edit your name, language and theme (light, dark or system). The saved language and theme apply wherever you sign in. The header's language switch also saves to the account. The dark theme is back as a full token set, with a pre-paint script so a reload never flashes light (#90)
- Model provider presets in `.env.example` (NVIDIA NIM, Gemini, Groq, OpenRouter, OpenAI, Anthropic, Ollama) and `pnpm llm:check` to test a configured provider and key
- api.v1 contract: Admin endpoints for AI access, with `GET /admin/users`, `PATCH /admin/users/{userId}` (`aiEnabled`), and the provider allow-list `GET /admin/providers` and `PATCH /admin/providers/{providerId}` (#55)

### Fixed
- The theme script no longer logs React's "Encountered a script tag" error when switching language. The browser renders its copy as a `text/plain` data block, and the server copy still applies the theme before the first paint (#115)
