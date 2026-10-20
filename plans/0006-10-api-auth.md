> **Status:** Done · **Issue:** [#10](https://github.com/CaseGuard-AI/CaseGuard/issues/10) · **PR:** [#56](https://github.com/CaseGuard-AI/CaseGuard/pull/56)

# #10: Auth — register, login, refresh, logout, me (api.v1)

## Context
`apps/api` now has `app.users` / `app.accounts` (#9, PR #51) but no auth. Issue #10 asks for `/auth/*` exactly as in `packages/contracts/openapi/api.v1.yaml`: a short-lived access JWT (`Authorization: Bearer`) plus a rotating refresh token in the `cg_refresh` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`), argon2id password hashing, a rate-limited login, and User/Admin roles.
**Requirements:** FR-AUTH-1, FR-AUTH-2, SEC-1, SEC-15.
**Done when:** contract tests pass; invalid credentials create no session; admin-only endpoints return 403 for Users.

Out of scope (not in the contract, and no existing issue covers them): password reset (rest of FR-AUTH-1), admin endpoints (e.g. FR-AUTH-3's per-user AI toggle), and a way to promote admins (SQL `UPDATE` for now). No contract changes in this PR.

**Follow-up issues (the user asked for these):** after the PR, open one new GitHub issue for each gap, matching the style of the existing starter issues (requirements, done-when, `area:api`/`stream:A` labels):
1. Password reset (FR-AUTH-1). Needs a contract PR first.
2. A `db:create-admin` CLI to create or promote an admin (FR-AUTH-2).
3. Admin endpoints for per-user AI enable/disable and provider selection (FR-AUTH-3). Needs a contract PR first.
Link them from the plan record's Follow-ups section and from the PR body.

Branch `feature/api-auth` off `staging`. PR title: `feat(api): auth with access JWT and rotating refresh cookie`.

## Changes
1. **Plan record** `plans/0006-10-api-auth.md` (copy of this plan, `> **Status:** In progress · **Issue:** #10 · **PR:** [#56](https://github.com/CaseGuard-AI/CaseGuard/pull/56)`).
2. **Dependencies** (`apps/api/package.json`): `jose` (HS256 JWT, pure ESM), `@node-rs/argon2` (prebuilt binaries for win32 and the Debian `node:24-slim` image, no node-gyp; argon2id by default), `express-rate-limit`, `cookie-parser` (+ `@types/cookie-parser`). Dev: `ajv`, `ajv-formats`, `yaml`, `@apidevtools/json-schema-ref-parser` for contract tests.
3. **Schema + migration** — `src/db/schema.ts` adds `app.refresh_tokens`:
   - `id uuid pk`, `owner_user_id → users(id) on delete cascade`, `account_id → accounts(id) on delete cascade` (FR-AUTH-5 rule), `family_id uuid not null`, `token_hash text not null unique` (SHA-256 of the token; raw token never stored), `expires_at`, `revoked_at` (nullable), `created_at`; indexes on `owner_user_id` and `family_id`.
   - `pnpm --filter ./apps/api db:generate` → `drizzle/0001_refresh_tokens.sql` (strip any `CREATE SCHEMA`), plus hand-written `0001_refresh_tokens.down.sql` (`DROP TABLE "app"."refresh_tokens";`).
4. **`src/auth/password.ts`**: `hashPassword`, `verifyPassword` via `@node-rs/argon2`; a lazily computed dummy hash so an unknown email still costs one verify (no user-enumeration timing).
5. **`src/auth/tokens.ts`**:
   - `ACCESS_TTL_S = 900`, `REFRESH_TTL_S = 14 days`.
   - `signAccessToken({ userId, accountId, role }, secret)` / `verifyAccessToken` with `jose` (HS256, `iss: caseguard-api`, `aud: caseguard-web`, claims `sub`, `acct`, `role`).
   - `newRefreshToken()` → 32 random bytes base64url; `hashToken()` → SHA-256.
6. **`src/auth/store.ts`** (Drizzle on `Db` from `src/db/client.ts`):
   - `createUserWithAccount` — one transaction inserting the account then the user; a `23505` (unwrap Drizzle's `cause`) becomes `HttpProblem(409)`.
   - `findUserByEmail` (`lower(email) = lower($1)`), `findUserById`.
   - `issueRefresh(user, familyId?)`.
   - `rotateRefresh(hash)` — in a transaction: `UPDATE … SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING *` (atomic, so a token works once), then insert the successor in the same family. If nothing matched but the hash exists and is revoked → **reuse detected**: revoke the whole family. Returns null on any failure.
   - `revokeRefresh(hash)`.
7. **`src/auth/middleware.ts`**: `requireAuth` (Bearer → verify → `req.auth = { userId, accountId, role }`, else 401 problem with `WWW-Authenticate: Bearer`) and `requireRole(...roles)` (403 problem). Type `req.auth` via `declare module "express-serve-static-core"` (no namespace, keeps eslint happy).
8. **`src/routes/auth.ts`** — `authRouter({ db, jwtSecret })`, Zod bodies mirroring `RegisterRequest` / `LoginRequest` (unknown fields stripped, so `role` in a register body is ignored → always `user`):
   - `POST /auth/register` → 201 `Session` + cookie; 409 on duplicate email.
   - `POST /auth/login` → 200 `Session` + cookie; same 401 for unknown email and wrong password, **no refresh row written** on failure.
   - `POST /auth/refresh` → rotate; 200 `Session` + new cookie, or 401 and clear the cookie.
   - `POST /auth/logout` → revoke + clear cookie, 204; 401 when the cookie is missing/unknown.
   - `GET /auth/me` → `requireAuth`, reload the user (401 if gone), return `User`.
   - A `toUserDto(row)` maps rows to the contract `User` (never `passwordHash`); `sessionFor(user)` builds `{ accessToken, expiresIn, user }` and sets the cookie via `res.cookie("cg_refresh", …, { httpOnly, secure: true, sameSite: "strict", path: "/api/v1/auth", maxAge })` (browsers accept Secure on `localhost`).
9. **Rate limiting** (`src/middleware/rate-limit.ts`, SEC-15): `express-rate-limit`, in-memory store (single instance for now — note in README), handler throws/answers problem+json 429 with `Retry-After`.
   - login: 10 failed attempts / 15 min per `ip + lower(email)` (`skipSuccessfulRequests: true`);
   - register + refresh: 20 / 15 min per IP.
   - Limiters are created inside `authRouter`, so each `createApp` (and each test) has fresh state.
10. **Wiring**:
    - `src/app.ts`: `AppDeps.env` becomes `Pick<Env, "CORS_ORIGIN" | "JWT_SECRET">`; add `orm: Db`; `app.use(cookieParser())`; mount `authRouter` on `v1`.
    - `src/server.ts`: `orm = createDb(pool)`.
    - `test/app.test.ts`: helper passes `JWT_SECRET` and a stub `orm`.
11. **Tests**:
    - `vitest.config.ts`: `fileParallelism: false` — the migration tests drop the tables, so DB test files must not overlap.
    - `test/contract.ts`: loads `api.v1.yaml`, dereferences (incl. `./ai.v1.yaml` refs), compiles with Ajv 2020 + formats; `expectContract(res, method, path)` asserts the status is declared, the content type matches, and the body validates.
    - `test/auth-unit.test.ts` (always runs): argon2id hash prefix and verify; JWT round-trip, expiry and wrong-secret rejection; `requireAuth` 401 without/with bad token; `requireRole("admin")` on a throwaway router → **403 for a User token**, 200 for Admin.
    - `test/auth.test.ts` (`describe.skipIf(!APP_TEST_DATABASE_URL)`, `migrateUp` in `beforeAll`, truncate between tests): every endpoint's success and error responses go through `expectContract`; cookie attributes match `RefreshCookie`; duplicate email in another case → 409; bad password and unknown email → 401 **and `refresh_tokens` count unchanged**; refresh rotates (old cookie then 401); reusing a rotated token revokes the family (successor also 401); logout → 204 then refresh 401; `/me` 401 without token; the 11th failed login → 429 with `Retry-After`.
    - `test/migrations.test.ts`: update the exact table lists to include `refresh_tokens`, and the reversibility test to step down through `0001` then `0000`.
12. **Docs**: `apps/api/README.md` (endpoint table, `src/auth/` in layout, rate-limit store note); `CHANGELOG.md` `[Unreleased]` Added entry. `.env.example` already has `JWT_SECRET`.

## Reuse
- `HttpProblem` (`src/lib/problem.ts`) and `errorHandler` (`src/middleware/errors.ts`) for all 400/401/403/409/429 bodies — Zod errors already become `ValidationProblem`.
- `createDb` / `Db` (`src/db/client.ts`), `users`/`accounts` tables and types (`src/db/schema.ts`).
- `migrateUp` / `migrateDown` (`src/db/migrate.ts`) and the `skipIf(APP_TEST_DATABASE_URL)` pattern from `test/migrations.test.ts`; CI already sets that variable and bootstraps roles.
- `JWT_SECRET` is already validated (≥32 chars) in `src/config/env.ts`.

## Verification
1. `docker compose up -d db && pnpm db:bootstrap && pnpm db:migrate` — `\dt app.*` shows `refresh_tokens`; `pnpm --filter ./apps/api db:migrate:down` drops it and `pnpm db:migrate` restores it.
2. `pnpm --filter ./apps/api lint`, `typecheck`, and `APP_TEST_DATABASE_URL=postgresql://caseguard_app:<pw>@localhost:5432/caseguard pnpm --filter ./apps/api test` — all green, auth suite not skipped.
3. Manual: `pnpm dev:api`, then curl register → login (check `Set-Cookie`) → `/auth/me` with the bearer → refresh with the cookie → logout.
4. `docker compose up --build` gives a healthy api (argon2 native binary loads in the slim image).
5. PR CI: `api`, `stack`, `ci-ok` green.

## Follow-ups
- [#53](https://github.com/CaseGuard-AI/CaseGuard/issues/53): password reset (FR-AUTH-1)
- [#54](https://github.com/CaseGuard-AI/CaseGuard/issues/54): `db:create-admin` CLI (FR-AUTH-2)
- [#55](https://github.com/CaseGuard-AI/CaseGuard/issues/55): admin endpoints for per-user AI and providers (FR-AUTH-3)
