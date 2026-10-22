> **Status:** Done · **Issue:** [#55](https://github.com/CaseGuard-AI/CaseGuard/issues/55) · **PR:** [#66](https://github.com/CaseGuard-AI/CaseGuard/pull/66)

# #55: admin endpoints for AI access and the provider allow-list (API)

## Context
FR-AUTH-3 says an Admin enables or disables AI for each user and picks which model providers are enabled. TBD-20 settled this as per user, plus a provider allow-list. The contract was merged in #58, and admins can now be created with `db:create-admin` (#54). This PR implements the four admin operations, plus the `requireAiEnabled` check that #13's AI routes will use.

**Decision (user):** seeded providers start **disabled, except Ollama**. Ollama is local, so data stays on the machine. Cloud providers need an Admin to switch them on (SEC-11).

Branch `feature/api-admin-ai-access` off `staging`. PR title: `feat(api): admin endpoints for per-user AI access and the provider allow-list`.

## Changes
1. **Schema and migration** `0003_providers` (plus a hand-written `.down.sql`):
   - The `app.providers` table:
     - `id text pk`, with a check that it matches the contract's `ProviderId` slug;
     - `name`;
     - `kind` (`cloud` or `local`, enforced by a check);
     - `enabled boolean not null default false`;
     - `updated_at`.
   - This is deployment configuration, not a row a user owns, so FR-AUTH-5's ownership columns don't apply.
   - The migration seeds the ADR-0005 presets: `nvidia-nim`, `gemini`, `groq`, `openrouter`, `openai` and `anthropic` (cloud, off), and `ollama` (local, on).
2. **`src/admin/store.ts`**:
   - `listUsers(db, { cursor, limit })`: oldest first, ordered by `(created_at, id)`. The cursor is opaque (base64url of `createdAt|id`).
   - `setUserAiEnabled`.
   - `listProviders` (by name) and `setProviderEnabled`.
3. **`src/routes/admin.ts`**: `adminRouter({ db, jwtSecret })`, with `requireAuth` and `requireRole("admin")` on everything under `/admin`.
   - `GET /admin/users`: takes `limit` (1–100, default 20) and `cursor`. Returns `{ items: AdminUser[], nextCursor }`, and 400 for a bad cursor or limit.
   - `PATCH /admin/users/{userId}`: takes a strict `{ aiEnabled }` body. Returns 200 `AdminUser`, 400 for extra or invalid fields, and 404 for a non-uuid or unknown id.
   - `GET /admin/providers`: returns `{ items: Provider[] }`.
   - `PATCH /admin/providers/{providerId}`: takes a strict `{ enabled }` body. Returns 200 `Provider`, plus 400 and 404.
   - `toAdminUserDto` is `toUserDto` plus `createdAt`.
4. **`src/auth/middleware.ts`**: `requireAiEnabled(db)`, mounted after `requireAuth`. It reloads `ai_enabled` from the database on every request, so a change applies to the user's very next request. If AI is disabled it returns 403, "AI features are disabled for your account." #13 mounts it on the AI routes.
5. **Wiring**: `src/app.ts` mounts `adminRouter`.
6. **Tests**:
   - `test/admin.test.ts`, which needs `APP_TEST_DATABASE_URL`:
     - every operation goes through `expectContract`;
     - a User gets **403 on all four** operations, and no token gets 401;
     - paging returns pages of 2 and then the rest, with `nextCursor` null on the last page; a bad cursor gives 400;
     - turning `aiEnabled` off makes a `requireAiEnabled` route return 403, and turning it back on makes it return 200;
     - an unknown user or provider gives 404, and an extra body field gives 400;
     - the seeded providers have the right kinds, only Ollama is enabled, and toggling a provider works.
   - `test/migrations.test.ts`: `0003` is added to the table list and the round trip.
7. **Docs**: `apps/api/README.md` (endpoints and admin notes) and `CHANGELOG.md`.

## Not in this PR
- Enforcing the allow-list in `services/ai`. That needs an ai.v1 contract change, which goes with #21.
- Mounting `requireAiEnabled` on AI routes. That's #13.

## Verification
- Lint and typecheck pass.
- `vitest` with temp Postgres and Mailpit passes with nothing skipped.
- CI is green.
