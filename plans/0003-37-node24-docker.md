> **Status:** In progress · **Issue:** [#37](https://github.com/CaseGuard-AI/CaseGuard/issues/37) · **PR:** pending

# Plan: clear the open PR queue (#31, #34, #35, #36) and align Docker on Node 24 LTS

## Context
Before we pick the next issue, the four open PRs need to be resolved:

| PR | What | State | Verdict |
|---|---|---|---|
| #34 | docs(infra): keep merged feature branches | 11/11 green, clean | Merge |
| #31 | Dependabot: collector py group (httpx 0.27→0.28, bs4, lxml, dotenv, pdfplumber, pytest) | 12/12 green, `needs-review` | Safe. The httpx 0.28 breaking changes (`proxies=`, `app=`, string `verify`/`cert`) are not used. `utils/http_client.py` passes only `verify=<bool>`, and the tests use `MockTransport`. Merge |
| #35 / #36 | Dependabot: node 22-slim → 26-slim in apps/api and apps/web | compose smoke test fails, so `ci-ok` fails | Close and replace with this fix |

**Root cause of #35/#36:** Node 25+ no longer bundles corepack. `RUN corepack enable` fails with `/bin/sh: corepack: not found` (exit 127).
**Second problem:** the Docker images ran Node 22, but CI uses `.nvmrc` = 24.
**Decision:** standardise on Node 24 LTS now, and move to 26 on purpose after it goes LTS (~2026-10-28).

## Changes
1. `apps/api/Dockerfile`, `apps/web/Dockerfile`: `node:22-slim` → `node:24-slim` in both the base and runtime stages. `RUN corepack enable` becomes `RUN npm install -g corepack@latest && corepack enable`, which still honours `packageManager` and works on Node 24 and 26+.
2. `package.json`: `engines.node` `>=22` → `>=24`.
3. `.github/dependabot.yml`: the docker block ignores `node >=25` until the deliberate move to 26.
4. Merge #34 and #31. Close #35 and #36 with a link to this PR.

## Verification
- `docker compose build api web && docker compose up -d`, then check that api `/api/v1/health` and the web root return 200.
- `node:26-slim` + `npm i -g corepack@latest && corepack enable && pnpm --version` works, so the move to 26 later is just a tag change.
- PR CI is green, including `docker compose · full stack boots healthy` and `ci-ok`.
