# Contributing to CaseGuard AI

Read this before your first PR. The full branching and release model is in [`docs/engineering/branching-and-release.md`](docs/engineering/branching-and-release.md). This page is the short version.

## Golden rules

1. **Never push to `main` or `staging`.** All work goes through a PR from a short-lived branch cut from `staging`.
2. **One concern per PR**, under ~400 changed lines, with a Conventional Commit title (`feat(ai): …`).
3. **Reference the PRD.** Every PR lists the requirement IDs it implements (e.g. `FR-TRUST-4`). If a change isn't in the [PRD](docs/PRD.md), update the PRD in the same PR or open an issue first.
4. **Contracts first.** Changing an API between services means changing `packages/contracts` first, in its own PR, reviewed by both sides.
5. **Respect schema ownership.** `apps/api` writes only the `app` schema. `services/ai` and `services/collector` write only `corpus` and `ai` (ADR-0002).
6. **No secrets in git.** Use `.env` (git-ignored). Add every new variable to `.env.example` with a safe placeholder.
7. **Architecture decisions get an ADR.** Copy [`docs/adr/0000-template.md`](docs/adr/0000-template.md) when you introduce or change one: a new datastore, framework, external service or cross-service pattern.

## Getting started

```bash
git clone https://github.com/CaseGuard-AI/CaseGuard.git && cd CaseGuard
git switch staging
pnpm setup                       # .env, pnpm install, uv venvs for the Python services
pnpm db:up                       # Postgres 17 + pgvector in Docker, or: pnpm db:bootstrap (native Postgres)
pnpm dev                         # web :3000 · api :4000 · ai :8000
```

Running without Docker, the tools to install, and pgvector on Windows are all covered in [`docs/engineering/local-setup.md`](docs/engineering/local-setup.md).

## Workflow

```bash
git switch staging && git pull
git switch -c feature/<area>-<short-desc>     # areas: web, api, ai, collector, contracts, infra, docs, eval
# work, commit small
git fetch origin && git rebase origin/staging
git push -u origin HEAD                         # open PR → staging
```

## Review checklist (for reviewers)

- [ ] It does what the referenced requirement's acceptance criterion says, and tests prove it
- [ ] It doesn't widen data access: retrieval is still scoped in SQL, and there's no cross-user path
- [ ] No status is computed outside the trust layer, and no cached copies of trust status exist
- [ ] User-facing strings are externalised (i18n) and the layout is RTL-safe
- [ ] Errors are handled and logged without leaking secrets or case content
- [ ] Migrations are reversible and live in the owning service

## Coding standards

| Area | Standard |
|---|---|
| TypeScript (`apps/web`, `apps/api`, `packages/contracts`) | `strict` mode, ESLint + Prettier, Zod at boundaries, no `any` without a comment |
| Python (`services/*`) | 3.12, `ruff` (lint + format), `mypy --strict` on new modules, `pytest`, dependencies managed with `uv` |
| Tests | Unit tests next to the code, integration tests under each service's `tests/`. Trust-layer and access-control rules need 100% branch coverage. |
| Logging | Structured JSON (Pino / `structlog`). Never log API keys, passwords or document contents. |
