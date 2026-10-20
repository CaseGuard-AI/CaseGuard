# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [SemVer](https://semver.org/). Release process: [`docs/engineering/branching-and-release.md`](docs/engineering/branching-and-release.md#6-releases).

## [Unreleased]

### Added
- Product Requirements Document v1.0 (`docs/PRD.md`)
- Repository foundation: monorepo layout, branching model (`main` / `staging` / feature branches), contribution guide, ADRs 0001–0006, CI workflows, PR/issue templates, local Postgres + pgvector compose file
- Full Docker stack: `docker compose up --build` (or `pnpm stack:up`) runs db, ai, api and web healthy. ai is unreachable from the host and from web, with outbound-only egress for model providers. A CI `compose-smoke` job boots the stack on infra changes (#23)
- `app` schema migrations with Drizzle (ADR-0007): `users` and `accounts` tables, `pnpm db:migrate` / `db:migrate:down`, run as `caseguard_app` and applied by the api image on start (#9)
- Auth for `/api/v1/auth/*` (register, login, refresh, logout, me): argon2id passwords, a 15-minute access JWT and a rotating 14-day refresh token in the `cg_refresh` HttpOnly cookie with reuse detection, rate-limited login, `requireAuth` / `requireRole` for User/Admin, and contract tests against `api.v1.yaml` (#10)
- Model provider presets in `.env.example` (NVIDIA NIM, Gemini, Groq, OpenRouter, OpenAI, Anthropic, Ollama) and `pnpm llm:check` to test a configured provider and key
