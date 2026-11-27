> **Status:** Done · **Issue:** [#79](https://github.com/CaseGuard-AI/CaseGuard/issues/79) · **PR:** [#80](https://github.com/CaseGuard-AI/CaseGuard/pull/80)

# #79: Generated TypeScript types for api.v1 and a typed web client (contracts, web)

## Context

#12 (login/register) is the first browser code that calls `apps/api` for real. ADR-0002 and `apps/web/README.md` say the browser talks to the API only through a client generated from `packages/contracts`, but no generator exists. `apps/web/src/lib/api.ts` is a hand-written `apiGet`, and `packages/contracts` is just YAML (no `package.json`). The contracts README already picks the tool, "TypeScript via `openapi-typescript`" into `generated/`, and says the generated client should "come with the first consumer PR". This issue is that dependency, done on its own before #12.

**Requirements:** ADR-0002 (strict boundary, contract first).

**Decisions:**
- **Types: `openapi-typescript`. Client: `openapi-fetch`.** The output is types only (`paths`, `components`), so there's no runtime code to transpile or bundle from the workspace package. `openapi-fetch` is about 6 kB, typed by `paths`, and returns `{ data, error, response }`.
- **The generated file is committed.** CI, Docker and the IDE work without running a generator. The contracts CI job regenerates and runs `git diff --exit-code`, so it fails on drift.
- **Only `api.v1` is generated.** Its `$ref`s into `ai.v1.yaml` are inlined by the generator. Types for `ai.v1` (used by apps/api) and Python wait for their own consumers.
- **There is one client instance in `@/lib/api`,** with `credentials: "include"` so the refresh cookie travels. #12 adds the bearer-token middleware.

Branch: `feature/contracts-ts-client` off `staging`. PR title: `feat(contracts): generate api.v1 types and a typed web client`.

## Changes

1. **`packages/contracts/package.json`** (new)
   - `@caseguard/contracts`, `private: true`, `type: module`.
   - `exports: { "./api.v1": { "types": "./generated/api.v1.ts" } }`, which is types only.
   - Script `generate`: `openapi-typescript openapi/api.v1.yaml -o generated/api.v1.ts`.
   - devDependency: `openapi-typescript` (exact current version).

2. **`packages/contracts/generated/api.v1.ts`**: the generated output, committed. Add `generated/` to the Prettier and ESLint ignore lists if they would touch it.

3. **Root `package.json`**: add `"gen:contracts": "pnpm --filter @caseguard/contracts run generate"`.

4. **CI** (`.github/workflows/ci.yml`, contracts job)
   - After the Redocly lint, add pnpm setup + `pnpm install --frozen-lockfile --filter @caseguard/contracts`, then `pnpm gen:contracts`, then `git diff --exit-code packages/contracts/generated`, with a clear failure message ("run pnpm gen:contracts and commit").
   - The `web` job already runs when `packages/contracts/**` changes.

5. **`apps/web`**
   - Dependencies: `openapi-fetch`, and `@caseguard/contracts: workspace:*`.
   - `src/lib/api.ts`:
     - `export const api = createClient<paths>({ baseUrl: API_URL, credentials: "include" })`.
     - Keep `API_URL`. Remove `apiGet`.
     - `export type Schemas = components["schemas"]`.
     - `problemOf(error)` narrows an error body to `{ title, detail?, status, errors?: {path, message}[] }`, which #12 uses for field errors.
   - `src/components/api-status.tsx`: `queryFn` calls `api.GET("/health")` and throws when `error` is set.
   - `Dockerfile` build stage:
     - Copy `packages/contracts/package.json` before `pnpm install`, so `--filter @caseguard/web...` resolves the workspace dependency.
     - Copy `packages/contracts/generated` (and the `openapi/` folder, which is small) before the build.

6. **Tests** (`apps/web/test/api.test.ts`)
   - Stub `fetch` and check that `api.GET("/health")` requests `${API_URL}/health` with `credentials: "include"` and returns `data.status === "ok"`.
   - Check that `problemOf` reads a 400 `problem+json` body with `errors[]` and handles a body that isn't a problem.
   - The typecheck catches a wrong path or wrong field names at compile time.

7. **Docs**
   - `packages/contracts/README.md`: update the Status line, and add a "Generate" section (`pnpm gen:contracts`, commit the output, CI checks drift).
   - `apps/web/README.md`: in the Layout section, `src/lib/api.ts` becomes the typed client.
   - `CHANGELOG.md` entry.
   - Commit this plan as `plans/0018-79-contracts-ts-client.md`.

## Not in this PR
- Auth calls, the session store, the bearer middleware and the login/register pages: #12.
- `ai.v1` TypeScript types for apps/api, and Python models for services/ai.

## Verification
- `pnpm gen:contracts` gives no diff. Editing a schema in `api.v1.yaml` and regenerating changes `generated/api.v1.ts`. Without regenerating, the CI drift step fails (simulate locally with `git diff --exit-code`).
- `pnpm --filter ./apps/web run lint`, `typecheck`, `test`, `build` all pass.
- `docker compose build web` succeeds, and the image serves `/en`. `ApiStatus` shows "up" against a running api (`pnpm dev`).
- CI `ci-ok` is green, including the contracts job.

## Deviations during implementation
- **The contracts CI job keeps its name** (`contracts · OpenAPI lint`), so any check that references it by name keeps matching. The drift check is an extra step in that job.
- **No ignore entries were needed.** `apps/web`'s ESLint and Prettier only cover `apps/web`, and `packages/contracts` has no lint or format script.
