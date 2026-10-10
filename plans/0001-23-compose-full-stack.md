> **Status:** In progress · **Issue:** [#23](https://github.com/CaseGuard-AI/CaseGuard/issues/23) · **PR:** [#32](https://github.com/CaseGuard-AI/CaseGuard/pull/32)

# Plan: #23 — Full Docker stack (api, ai, web in docker-compose)

## Context
#23 is the last open issue in **M0: Foundation**. The Dockerfiles for api (#5), ai (#7) and web (#8) exist, but `docker-compose.yml` only runs `db`; the app services are commented stubs. Goal: `docker compose up --build` brings the whole stack up healthy, with the FastAPI service unreachable from the host and from web (ADR-0002, SEC-14). Branch: `chore/infra-compose-full-stack` off `staging`, PR title `chore(infra): run api, ai and web in docker compose`.

## Step 0: Plan tracking
- Create `plans/` at the repo root with a short `plans/README.md` (one plan per file, named `NNNN-<issue#>-<slug>.md`, status line at the top: Draft / In progress / Done, plus a link to the issue and PR).
- Save this plan as `plans/0001-23-compose-full-stack.md` and commit it on the feature branch so it ships with the PR.
- Save a memory so future plans also go to `plans/`.

## Gaps found in the current stubs
1. **Build contexts are wrong.** `apps/api/Dockerfile` and `apps/web/Dockerfile` build from the **repo root** (they copy `pnpm-lock.yaml`), but the stubs use `build: ./apps/api`. `services/ai/Dockerfile` builds from its own dir.
2. **Hostnames.** `.env` URLs point at `localhost:5432/5433` and `localhost:8000`. Inside containers these must be `db:5432` and `ai:8000`. On this machine `.env` uses 5433, but that is only the host-side port.
3. **The network the stubs sketch is broken.** `ai` is only on `internal`, but `db` is only on `default`, so ai can't reach the DB. Also, `internal: true` cuts **all outbound traffic**, so ai couldn't reach free-tier LLM APIs or download bge-m3 from Hugging Face (#18, #21).
4. **Web has no healthcheck**, so `depends_on`/`--wait` can't gate on it.
5. CI only runs `docker compose config`. Nothing proves the stack actually boots.

## Changes

### `docker-compose.yml`
- **api**: `build: { context: ., dockerfile: apps/api/Dockerfile }`, `env_file: .env`, and `environment` overrides:
  - `NODE_ENV: production`
  - `API_DATABASE_URL: postgresql://caseguard_app:${APP_DB_PASSWORD}@db:5432/${POSTGRES_DB}`
  - `AI_SERVICE_URL: http://ai:8000`
  - `depends_on`: db `service_healthy`, ai `service_healthy`. Ports `127.0.0.1:4000:4000`. Networks: `edge`, `internal`.
- **ai**: `build: ./services/ai`, `env_file: .env`, override `AI_DATABASE_URL: postgresql+psycopg://caseguard_ai:${AI_DB_PASSWORD}@db:5432/${POSTGRES_DB}`, depends on db healthy, **no `ports:`**. Networks: `internal` + `ai-egress` (see decision below). The Dockerfile already has a HEALTHCHECK on `/health`.
- **web**: `build: { context: ., dockerfile: apps/web/Dockerfile, args: { NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL} } }`, depends on api `service_healthy`, ports `127.0.0.1:3000:3000`, network `edge` only. Add a compose `healthcheck` with the same `node -e fetch(...)` pattern the api Dockerfile uses, against `http://127.0.0.1:3000/`. Use `restart: unless-stopped` for all three, matching db.
- **db**: join `edge` (for the host port) + `internal`.
- **networks**: `edge` (normal), `internal` (`internal: true`), `ai-egress` (normal, **ai is the only member**). Web is never on a network with ai, and ai never publishes a port.
  - **Decided:** ai needs outbound internet. Users will bring their own OpenAI / OpenRouter / Anthropic / Gemini keys and pick a model, alongside the recommended free-tier default (#21, ADR-0005). So "internal only" means *not reachable inbound* (no published port, not on web's network), **not** "no egress". Add a compose comment and a line in the PR description explaining this reading of SEC-14.
- Leave `ollama` commented. It belongs to #21; just fix its network comment.
- Update the header comment: `docker compose up --build` = full stack, `docker compose up -d db` = DB only.

### CI: `.github/workflows/ci.yml`
- Add a `stack` path filter: `docker-compose.yml`, `**/Dockerfile`, `**/.dockerignore`, `infra/**`, `.env.example`.
- New job `compose-smoke` (runs only when that filter matches): `cp .env.example .env`, then `docker compose up --build --wait --wait-timeout 300`, then `curl -fsS localhost:4000/api/v1/ready` (proves db + ai + token), then `curl -fsS localhost:3000/`, then assert `curl localhost:8000` **fails**. Always run `docker compose logs` on failure and `down -v` at the end.
- Add `compose-smoke` to `ci-ok.needs`.
- `.env.example` placeholders pass the zod mins (JWT_SECRET ≥32, token ≥16). Verify that, and lengthen a placeholder if needed.

### Docs and scripts
- `docs/engineering/local-setup.md` §7: the real commands, the port map, the network diagram (edge / internal / ai-egress), and a note that `.env` hostnames are overridden in compose.
- Root `package.json`: add `stack:up` (`docker compose up --build -d --wait`) and `stack:down`, next to the existing `db:up`.
- `CHANGELOG.md` entry if the repo keeps an Unreleased section.

## Reuse
- The healthcheck pattern from `apps/api/Dockerfile` (node fetch, no curl in slim images).
- The readiness endpoints already exist: api `/api/v1/ready` checks DB + AI with the token (`apps/api/src/routes/health.ts`), and ai `/ready` (`services/ai/src/caseguard_ai/main.py`). The smoke test only has to call api `/ready`.
- The DB init script `infra/db/init/01-schemas-and-roles.sh` already creates `caseguard_app`/`caseguard_ai` from the env passwords.

## Verification (local, Windows + Docker Desktop)
1. `docker compose config --quiet`
2. `docker compose up --build --wait`. All 4 services should show `healthy` in `docker compose ps`.
3. `curl localhost:4000/api/v1/ready` → `{"status":"ok","database":"up","ai":"up"}`
4. Open `http://localhost:3000` and check the page renders.
5. Isolation: `curl localhost:8000` fails from the host. `docker compose exec web node -e "fetch('http://ai:8000/health')..."` fails (web can't resolve or reach ai). `docker compose exec ai python -c "urllib…('https://api.openai.com')"` reaches the internet (egress for user-key providers works).
6. `docker compose down -v`, then push the branch and confirm `compose-smoke` and `ci-ok` pass on the PR.

## Out of scope / notes
- Images use `node:22-slim` while `.nvmrc` is 24. Not changed here; worth a follow-up issue.
- Ollama, model download caching (HF volume) → #18/#21.
