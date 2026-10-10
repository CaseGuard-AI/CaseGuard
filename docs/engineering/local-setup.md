# Local setup

CaseGuard runs **with or without Docker**. Production and CI use containers. For day-to-day development, each service can run natively on your machine.

| Part | Runs natively with | Port |
|---|---|---|
| `apps/web` (Next.js) | Node ≥ 22 + pnpm | 3000 |
| `apps/api` (Express) | Node ≥ 22 + pnpm | 4000 |
| `services/ai` (FastAPI) | Python 3.12 + uv → `services/ai/.venv` | 8000 |
| `services/collector` | Python 3.12 + uv → `services/collector/.venv` | (CLI) |
| Database | PostgreSQL 17 + **pgvector**, natively **or** in Docker | 5432 |

> **`.env` vs `.venv`:** `.env` (repo root) holds configuration and secrets, copied from `.env.example`. `.venv` is a Python virtual environment, one per Python service, created by `uv sync`. Both are git-ignored.

## 1. Install the toolchain (once)

| Tool | Windows | macOS / Linux |
|---|---|---|
| Node.js ≥ 22 LTS | <https://nodejs.org> | `nvm install` (reads `.nvmrc`) |
| pnpm | `npm i -g pnpm` | `npm i -g pnpm` |
| uv (manages Python 3.12 and the venvs) | `winget install astral-sh.uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| PostgreSQL 17 *(native DB only)* | EDB installer from postgresql.org | `brew install postgresql@17` / apt |
| Docker Desktop *(Docker DB only)* | docker.com | docker.com |

You don't need to install Python yourself: uv downloads 3.12 when it's missing (`.python-version`).

## 2. Set up the repo

```bash
git clone https://github.com/CaseGuard-AI/CaseGuard.git && cd CaseGuard
git switch staging
pnpm setup        # creates .env, runs pnpm install, uv sync for each Python service
```

Then open `.env` and replace every `change-me-…` value.

## 3. Start a database (pick one)

### Option A: Docker for the database only (easiest)

```bash
pnpm db:up        # docker compose up -d db → pgvector/pgvector:pg17
```

The container runs `infra/db/sql/bootstrap.sql` the first time it starts. To rebuild it from scratch, run `docker compose down -v`.

### Option B: Fully native (no Docker)

1. Install PostgreSQL 17 and **pgvector** (see below).
2. In `.env`, set `POSTGRES_USER` / `POSTGRES_PASSWORD` to an existing superuser (on Windows this is usually `postgres` and the password you picked at install), and keep `POSTGRES_PORT=5432`.
3. Run:
   ```bash
   pnpm db:bootstrap   # creates the database, roles and schemas; safe to re-run
   ```
   It finds `psql` on PATH, under `C:\Program Files\PostgreSQL\<ver>\bin`, or in `PG_BIN`.

#### Install pgvector

- **macOS:** `brew install pgvector`
- **Ubuntu/Debian:** `sudo apt install postgresql-17-pgvector`
- **Windows:** build it once with the Visual Studio C++ Build Tools. Open the *x64 Native Tools Command Prompt* **as Administrator** and run:
  ```bat
  set "PGROOT=C:\Program Files\PostgreSQL\17"
  cd %TEMP%
  git clone --branch v0.8.1 https://github.com/pgvector/pgvector.git
  cd pgvector
  nmake /F Makefile.win
  nmake /F Makefile.win install
  ```
  Use the newest release tag from <https://github.com/pgvector/pgvector/releases>. Afterwards, `pnpm db:bootstrap` confirms it's installed.

### Running both Docker and a native Postgres

Both listen on 5432 by default. To use Docker anyway, set `POSTGRES_PORT=5433` in `.env` and change `:5432` to `:5433` in `API_DATABASE_URL`, `AI_DATABASE_URL` and `PKLEGAL_DATABASE_URL`.

## 4. Run the services

```bash
pnpm dev          # web + api + ai together, with prefixed logs
# or one at a time:
pnpm dev:web
pnpm dev:api
pnpm dev:ai       # uv run uvicorn … inside services/ai/.venv
```

Collector:

```bash
cd services/collector
uv run python main.py --help
```

Each service also has its own README with its commands.

## 5. Checks before you push

```bash
pnpm lint && pnpm typecheck && pnpm test      # JS/TS workspaces
pnpm test:py                                  # pytest for ai + collector
cd services/ai && uv run ruff check . && uv run ruff format --check .
```

CI runs the same checks on every PR into `staging` (see `branching-and-release.md`).

## 6. Using the virtual environments in your editor

- **VS Code / Cursor:** *Python: Select Interpreter* → `services/ai/.venv` (or `services/collector/.venv`).
- **Activating by hand** (not needed with `uv run`):
  - PowerShell: `services\ai\.venv\Scripts\Activate.ps1`
  - bash/zsh: `source services/ai/.venv/bin/activate`

## 7. Full Docker stack (production-like)

Once each service's Dockerfile exists, `docker compose up --build` runs everything in containers on an internal network. FastAPI is exposed only to the API, never to the host (ADR-0002, SEC-14).
