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

The container runs `infra/db/sql/bootstrap.sql` the first time it starts. To rebuild it from scratch, run `docker compose down -v`. Then create the app tables:

```bash
pnpm db:migrate   # app schema migrations as caseguard_app (ADR-0007); safe to re-run
```

To see the email the api sends (password reset, #61), also start Mailpit. It catches every message, and you read them at http://localhost:8025:

```bash
docker compose up -d mailpit   # SMTP on localhost:1025, matching SMTP_HOST/SMTP_PORT in .env.example
```

### Sending real email (Gmail)

Mailpit only catches mail. To have password-reset emails reach real inboxes, send them through a Gmail account with an **app password**:

1. Turn on **2-Step Verification** for the Google account (myaccount.google.com → Security). Google only offers app passwords after that.
2. Open <https://myaccount.google.com/apppasswords>, create one named `CaseGuard`, and copy the 16-character password without the spaces Google shows between groups.
3. In `.env` (never commit it), set:
   ```bash
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURE=true
   SMTP_USER=you@gmail.com                 # the full address, not a display name
   SMTP_PASSWORD=abcdefghijklmnop          # the app password, not your Google password
   MAIL_FROM="CaseGuard <you@gmail.com>"   # Gmail rewrites any other From address
   ```
4. Check it: `pnpm mail:check --to you@gmail.com`. It sends one test email, or explains the failure (wrong password, wrong port, and so on).
5. Restart the api (`pnpm dev`), then try **Forgot password?** on the sign-in page. The email links to `RESET_URL_BASE?token=…`.

Notes:
- Gmail allows about 500 emails a day, which is fine for development and demos. A shared or production deploy should use a dedicated sender (for example Brevo or Amazon SES), configured with the same six variables.
- The full Docker stack (`pnpm stack:up`) always points the api at Mailpit (`SMTP_HOST`/`SMTP_PORT` in `docker-compose.yml`). For Gmail there, add an untracked `docker-compose.override.yml` that sets `SMTP_HOST: smtp.gmail.com` and `SMTP_PORT: 465` under `services.api.environment`.
- To go back to Mailpit, restore the `.env.example` values (`localhost`, `1025`, `false`, empty user and password).

### Option B: Fully native (no Docker)

1. Install PostgreSQL 17 and **pgvector** (see below).
2. In `.env`, set `POSTGRES_USER` / `POSTGRES_PASSWORD` to an existing superuser (on Windows this is usually `postgres` and the password you picked at install), and keep `POSTGRES_PORT=5432`.
3. Run:
   ```bash
   pnpm db:bootstrap   # creates the database, roles and schemas; safe to re-run
   pnpm db:migrate     # creates the app tables as caseguard_app; safe to re-run
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

### Corpus data

The app runs without a corpus, but research, precedent search and drafting assist return 503 until there is one. Restore the published database dump: see "Downloading the database" in [`session-handoff.md`](session-handoff.md#hugging-face-caseguard-org). You need `HF_TOKEN` in `.env`, with read access to `caseguard/corpus`.

### Low on RAM? Run the AI service on Colab

The AI service loads three models: the bge-m3 embedder, the reranker and the NLI checker. Together they need about 5 GB of RAM, which an 8 GB laptop can't spare next to Docker. [`notebooks/colab-ai-service.ipynb`](../../notebooks/colab-ai-service.ipynb) runs `services/ai` on a free Colab GPU, with its own Postgres and a copy of the corpus dump. Your local api then talks to it through a tunnel.

1. Open the notebook in Colab: https://colab.research.google.com/github/CaseGuard-AI/CaseGuard/blob/staging/notebooks/colab-ai-service.ipynb
2. **Runtime → Change runtime type → T4 GPU.** Add the three secrets the notebook's first cell lists: `HF_TOKEN`, `CASEGUARD_ENV` (your `LLM_*` lines from `.env`) and `AI_SERVICE_TOKEN` (32+ random characters).
3. **Runtime → Run all.** It takes about 15–20 minutes, and it runs the smoke tests for research, precedents and drafting. Step 10 prints a `https://….trycloudflare.com` URL.
4. On your laptop, set `AI_SERVICE_URL=<that URL>` in `.env`, and set `AI_SERVICE_TOKEN` to the same value as the Colab secret. Then run `pnpm dev:web` and `pnpm dev:api` only, not `dev:ai`.
5. When you're done, set `AI_SERVICE_URL` back to `http://localhost:8000`.

Any Google account works. A Colab Pro plan only gives longer sessions and more RAM. A free session lasts up to about 12 hours, and the URL changes each time you run the notebook. Your cases, drafts and users stay in your local database; only the questions and draft text the api sends go to Colab.

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

Runs db, ai, api and web in containers, the same images CI builds.

```bash
cp .env.example .env     # if you haven't already
pnpm stack:up            # docker compose up --build -d --wait (returns once every service is healthy)
pnpm stack:down          # stop everything (add -v to the docker command to wipe the database)
```

| Service | URL on your machine | Notes |
|---|---|---|
| web | http://localhost:3000 | Next.js standalone build |
| api | http://localhost:4000/api/v1 | `/health` (liveness), `/ready` (db + ai) |
| db | localhost:`POSTGRES_PORT` | same data volume as Option A |
| mailpit | http://localhost:8025 | catches all mail the api sends (#61) |
| ai | *not published* | only api can reach it (ADR-0002, SEC-14) |

**Networks.** `edge` (web, api, db, mailpit) carries the published ports. `internal` (api, ai, db) has no outside access. `ai-egress` has only ai on it, which lets the AI service call model providers (Gemini, OpenAI, OpenRouter, Anthropic, user-supplied keys) and download models, while nothing can connect *in* to it. Web never shares a network with ai.

**Hostnames.** The URLs in `.env` point at `localhost` for native runs. `docker-compose.yml` overrides them with container hostnames (`db:5432`, `ai:8000`, `mailpit:1025`), so the same `.env` works for both, whatever `POSTGRES_PORT` is.

**Changing `NEXT_PUBLIC_API_URL`** needs a rebuild (`pnpm stack:up` rebuilds), because Next.js bakes it into the browser bundle.
