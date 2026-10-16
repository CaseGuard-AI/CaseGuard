> **Status:** In progress · **Issue:** [#45](https://github.com/CaseGuard-AI/CaseGuard/issues/45) · **PR:** [#46](https://github.com/CaseGuard-AI/CaseGuard/pull/46)

# Fix the 6 red Dependabot PRs (#39–#44)

## Context
Dependabot's first big batch landed on `staging` and every PR but one is red. Root causes (from CI logs):

| PR | Bump | Why it fails | Verdict |
|---|---|---|---|
| #40 | js-minor-and-patch (zod, typescript-eslint, vitest, react-query) | CI green, but auto-merge job crashed: `GraphQL: Resource not accessible by integration (statusCheckRollup)` → workflow lacks `checks: read` / `statuses: read`, so it fell into "a check failed" and labelled `needs-review` | **merge** |
| #41 | eslint 9 → 10 (web) | only "Conventional PR title": scope `deps-dev` not in allowed list (api is already on eslint 10, web lint passed) | **merge** |
| #42 | concurrently 9 → 10 | only the `deps-dev` title scope | **merge** |
| #43 | @types/node 22 → 26 | title scope; and wrong anyway — runtime is held on Node 24 LTS (.nvmrc, engines, Docker) | **close**, pin types to Node 24 instead |
| #44 | typescript 5.9 → 7.0 | title scope + `typescript-eslint does not support TS 7.0` (api + web lint) | **close**, hold TS < 7 |
| #39 | python 3.12-slim → 3.14-slim (ai image) | `services/ai/pyproject.toml` has `requires-python = ">=3.12,<3.13"`, so `uv sync` in the 3.14 image silently downloads a managed 3.12 into root's home; the non-root `caseguard` user can't reach it → container unhealthy | **close**, hold Python on 3.12 |

## Changes (one PR: `chore/infra-dependabot-fixes` → staging, title `chore(infra): fix Dependabot policy, auto-merge permissions and version holds`)

1. `.github/workflows/pr-policy.yml` — add `deps-dev` to `scopes` (Dependabot uses it for devDependencies with `include: scope`).
2. `.github/workflows/dependabot-automerge.yml` — add `checks: read` and `statuses: read` to `permissions` so the "Wait for the other checks" step can read `statusCheckRollup`.
3. `.github/dependabot.yml` — version holds, each with a comment saying when to lift it (same style as the existing Node hold):
   - npm: ignore `typescript` `>=7` (until typescript-eslint supports TS 7); ignore `@types/node` `>=25` (track Node 24 LTS).
   - docker (`/services/ai`): ignore `python` `>=3.13` (lift together with `requires-python` + ruff/mypy targets).
4. `apps/api/package.json`, `apps/web/package.json` — `@types/node` `^22.20.5` → `^24` (match the Node 24 runtime); `pnpm install` to refresh `pnpm-lock.yaml`.
5. `plans/0004-45-dependabot-fixes.md` — copy of this plan with status line (per plans-folder convention).

## After that PR merges (needs your approval for each merge)
- Close #39, #43, #44 with a comment pointing to the new ignore rules (Dependabot won't reopen them).
- `@dependabot rebase` on #41 and #42 so the title check reruns with the new scope list; merge both when green.
- #40: remove `needs-review`, merge (it's already 11/11 green). Its next CI run also exercises the fixed auto-merge path.

## Verification
- Locally: `pnpm install`, `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test` pass with `@types/node@24`.
- `docker compose config --quiet` still valid; workflow YAML parses (`gh workflow view` / actionlint if available).
- On the fix PR: all CI checks green, including Conventional PR title.
- After rebase: #41, #42 show 11/11; open PR list ends at 0 red.
