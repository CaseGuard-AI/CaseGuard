> **Status:** In progress · **Issue:** [#89](https://github.com/CaseGuard-AI/CaseGuard/issues/89) · **PR:** [#112](https://github.com/CaseGuard-AI/CaseGuard/pull/112)

# #89: user settings API (`GET`/`PATCH /me/settings`)

## Context

**Why:** FR-SET-1 (P0) says a user's language and theme must persist across sessions. Today `users.locale` is written once at registration and never changes, and there's no theme anywhere.

**Where it fits:** step 2 of A2 in `docs/engineering/stream-a-roadmap.md`.
- #88, the contract, is merged (PR #111). It defines `GET`/`PATCH /me/settings`, `UserSettings { name, locale, theme }`, the strict partial `UserSettingsUpdate` (`minProperties: 1`, `additionalProperties: false`) and `Theme = light | dark | system`, with `system` as the default.
- This PR makes `apps/api` serve exactly that.
- #90 (the web Settings page) comes after.

**Owner decision (2026-10-22):** the theme is `light`, `dark` or `system`. Dark mode in the UI can come after M2. The API stores all three now.

**Requirements:** FR-SET-1, FR-AUTH-4 (own settings only).

## Decisions

- **The theme goes on `app.users`:** a new `theme` column, `text NOT NULL DEFAULT 'system'`, with `CHECK (theme IN ('light','dark','system'))`. This follows the existing `users_role_check` and `users_locale_check`.
  - Settings are one row per user, and FR-AUTH-5's ownership is already on `users`.
  - A separate table would add a join for no gain.
  - Existing users get `system` from the default.
- **No `:id` in the path.** Both routes use `req.auth.userId` from `requireAuth`, so there's no way to name another user (FR-AUTH-4), and so no 404. A token whose user no longer exists gets 401, the same as `GET /auth/me` does today.
- **Validation mirrors the contract** and reuses register's rules:
  - `z.strictObject({ name?, locale?, theme? })`, with `name: z.string().trim().min(1).max(120)` exactly as in `registerBody` (`src/routes/auth.ts`).
  - A `.refine` rejects an empty object (`minProperties: 1`).
  - Any `ZodError` becomes 400 `errors[]` through the existing `errorHandler` (`src/middleware/errors.ts`).
  - So `{ role: "admin" }`, `{ email }` and `{ aiEnabled }` are all 400, never silently ignored.
- **The session catches up on its own.** `User` and `toUserDto` are unchanged, as the contract decided. `/auth/me` and `/auth/refresh` already read the user from the database, so they show a changed `name` or `locale` straight away; the web picks it up on its next refresh.
  - The access token's claims (`userId`, `role`) don't include these fields, so no token is affected.
- **No rate limit.** Both routes need authentication and are a single-row read or write, and the contract declares no 429. If one is needed later, it's an addition to the contract.
- **Logging:** the default pino-http request log only. The body (the name) isn't logged, consistent with the existing routes.

## Changes

1. **Schema** (`apps/api/src/db/schema.ts`): on `users`, add `theme: text("theme", { enum: ["light","dark","system"] }).notNull().default("system")` and `check("users_theme_check", sql\`theme in ('light', 'dark', 'system')\`)`.
2. **Migration**, using the README's "To change the schema" steps:
   - Run `pnpm --filter ./apps/api db:generate`. That writes `drizzle/0007_<tag>.sql`, `meta/0007_snapshot.json` and the journal entry. Review the SQL and rename the tag to `0007_user_theme` if drizzle picks a random one.
   - The SQL should be `ALTER TABLE "app"."users" ADD COLUMN "theme" text DEFAULT 'system' NOT NULL;` plus the `ADD CONSTRAINT "users_theme_check"`.
   - Hand-write `drizzle/0007_user_theme.down.sql`: drop the constraint, then the column (`ALTER TABLE … DROP CONSTRAINT …; ALTER TABLE … DROP COLUMN "theme";`).
3. **Store** (`apps/api/src/settings/store.ts`, new, in the same style as `src/admin/store.ts`):
   - `updateSettings(db, userId, patch)` does `update(users).set({ ...patch, updatedAt: sql\`now()\` }).where(eq(users.id, userId)).returning()` and returns `User | undefined`.
   - Reads reuse `findUserById` from `src/auth/store.ts`.
4. **Route** (`apps/api/src/routes/settings.ts`, new): `settingsRouter({ db, jwtSecret })`.
   - `router.use("/me", requireAuth(jwtSecret))`, reusing `src/auth/middleware.ts`.
   - `toSettingsDto(user) = { name, locale, theme }`.
   - `GET /me/settings`: `findUserById`, then 200, or 401 via `HttpProblem` if there's no user, as `/auth/me` does.
   - `PATCH /me/settings`: parse with `settingsUpdate`, call `updateSettings`, then 200, or 401 if there's no user.
5. **Wiring** (`apps/api/src/app.ts`): `v1.use(settingsRouter({ db: deps.orm, jwtSecret: deps.env.JWT_SECRET }))`, after `authRouter`.
6. **Tests**
   - `apps/api/test/settings.test.ts` (new). It's DB-backed and skipped without `APP_TEST_DATABASE_URL`, with the same harness as `test/admin.test.ts`: `createApp` with fakes, `TRUNCATE app.accounts CASCADE` in `beforeEach`, and register through the API. **Every response goes through `expectContract`** (`test/contract.ts`).
     - **GET:** a new user gets `{ name, locale (from registration), theme: "system" }`. Without a token it's 401.
     - **PATCH:**
       - Each field alone works, and so do all three together. A following GET returns the new values.
       - The name is trimmed.
       - `/auth/me` then shows the new `name` and `locale`.
     - **PATCH 400 cases:** `{}`; unknown fields (`role`, `email`, `aiEnabled`); `theme: "blue"`; `locale: "fr"`; `name` of `""`, `"   "` or 121 characters; a non-object body. Each has `errors[]`, and **the row is unchanged**.
     - **FR-AUTH-4:** user A's PATCH leaves user B's settings unchanged.
   - `apps/api/test/migrations.test.ts`: the defaults test also expects `theme: 'system'`, and a new case rejects `theme = 'blue'` through the check constraint. The existing "every migration has a down file" and "is reversible" tests then cover 0007.
7. **Docs**
   - `apps/api/README.md`: add `GET`/`PATCH /api/v1/me/settings` to the endpoint table, and a short "Settings" section on owner-only access, the strict partial body, the `system` default, and the session catching up on the next refresh. Add `settings/` to the Layout block.
   - `CHANGELOG.md`: an Added entry (#89).
   - `plans/0024-89-settings-api.md`: this plan, with its status line.

## Deviations during implementation
- **`test/migrations.test.ts` needed one more change than planned.** Its "is reversible" test lists every migration by name, so it now expects `0007_user_theme` first in the down sequence and last in the up sequence. It also checks that the down step really drops the `theme` column.
- **Local test-database setup: a mistake, caught and fixed.**
  - What happened: the first time I bootstrapped `caseguard_test`, my helper read `.env` values together with their inline comments (`APP_DB_PASSWORD=… # role …`). `bootstrap.sql`'s `ALTER ROLE` therefore set the cluster-wide `caseguard_app` and `caseguard_ai` passwords to the wrong strings.
  - How it showed: `pnpm db:migrate` on the dev DB failed with "password authentication failed".
  - The fix: rerunning the bootstrap with comments stripped (as Docker Compose does) restored both roles. Both logged in successfully, the stack came up healthy, and `/ready` reported the database up.
  - **Lesson:** never run `bootstrap.sql` without the exact role passwords Compose uses.
- **Three API tests were skipped locally:** the Mailpit delivery tests, which need `MAILPIT_URL`. CI sets it. All 22 settings tests and the migration tests ran and passed.
- **The strictness mutation check showed one subtlety.** With a non-strict schema, `{ role }` alone still gets a 400: the field is stripped, then the empty-body rule fires. But `{ theme, role }` would silently save the theme. The "known field next to an unknown one" test is the one that catches it.

## Not in this PR
- The web Settings page, and applying the saved theme and locale after sign-in (#90).
- The default model (#93). Changing the email or password (not in FR-SET-1).

## Verification
1. **Static checks:** `pnpm --filter ./apps/api run lint` and `typecheck`.
2. **DB tests against a separate test database. Never the stack's dev DB, because the tests run `TRUNCATE app.accounts`.** With `pnpm db:up`:
   - `docker compose exec -T db psql -U <POSTGRES_USER> -c "CREATE DATABASE caseguard_test"` (if it doesn't exist).
   - `docker compose exec -T db psql -U <POSTGRES_USER> -d caseguard_test -v ON_ERROR_STOP=1 -v app_pw=caseguard_app -v ai_pw=caseguard_ai -f -  < infra/db/sql/bootstrap.sql`. This is the same bootstrap as CI.
   - `APP_TEST_DATABASE_URL=postgresql://caseguard_app:caseguard_app@localhost:5432/caseguard_test pnpm --filter ./apps/api run test`.
   - **All pass, none skipped.** Confirm that the settings and migrations suites actually ran.
3. **Migration round trip on the dev DB:** `pnpm db:migrate` (applies 0007), `pnpm --filter ./apps/api db:migrate:down` (drops `theme`), then `pnpm db:migrate` again.
4. **Live stack** (`pnpm stack:up`; the image applies 0007 on start). Sign in with `curl` as an existing test user:
   - `GET /me/settings` gives `theme: "system"`.
   - `PATCH { "theme": "dark", "locale": "ur" }` gives 200.
   - A following GET and `/auth/me` reflect the change.
   - `PATCH {}` and `PATCH { "role": "admin" }` give 400 with `errors[]`.
   - A request without a token gives 401.
5. **Web unaffected:** `pnpm --filter ./apps/web run test` still passes, since `User` didn't change.
6. CI `ci-ok` is green (the api job runs the DB tests against its Postgres service).
