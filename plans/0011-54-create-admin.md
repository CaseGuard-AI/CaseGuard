> **Status:** In progress · **Issue:** [#54](https://github.com/CaseGuard-AI/CaseGuard/issues/54) · **PR:** [#65](https://github.com/CaseGuard-AI/CaseGuard/pull/65)

# #54: `db:create-admin` CLI

## Context
After #10 (auth), the only way to get an Admin was a manual `UPDATE app.users SET role = 'admin'`. FR-AUTH-2 needs a proper way to create or promote one, and #55 (the admin endpoints) needs an admin to exist before it can be used.

Branch `feature/api-create-admin` off `staging`. PR title: `feat(api): db:create-admin CLI to create or promote an Admin`.

## Changes
1. **`apps/api/src/db/create-admin.ts`**, shaped like `migrate.ts`: an exported core, plus a CLI entry that reads `parseDbEnv()` and logs through pino.
   - `parseCliArgs(argv)` uses `node:util` `parseArgs` in strict mode, with `--email` (required) and `--name`. It rejects `--password` with a clear message, and rejects unknown options.
   - `createOrPromoteAdmin(db, args, getPassword)`:
     - An existing user, matched by `lower(email)`, is promoted, or left unchanged if they're already an admin.
     - Otherwise, with `--name`, it creates the account and user as admin in one `createUserWithAccount` transaction. Without `--name`, it fails.
     - `getPassword` runs only when creating.
   - The password comes from a hidden raw-mode prompt typed twice on a TTY, or from the first line of stdin otherwise. It's validated with the `RegisterRequest` rules (10–128 characters).
2. **`src/auth/store.ts`**: `NewUserInput.role` is optional and defaults to `user`. Register never sets it.
3. **Scripts**: `db:create-admin` in `apps/api/package.json`, forwarded from the root `package.json`. In Docker it runs as `node dist/db/create-admin.js`.
4. **Tests** (`test/create-admin.test.ts`):
   - Argument parsing: `--password` is refused, unknown options are rejected, and `--email` is required and validated.
   - With the database:
     - Promoting matches the email case-insensitively and never asks for a password. The user goes from 403 to 200 on a `requireRole("admin")` route after signing in again.
     - A created admin can sign in.
     - Running it again on an admin leaves them unchanged.
     - A missing `--name` or a short password fails, and no row is written.
5. **Docs**: `apps/api/README.md` (replaces the SQL tip) and `CHANGELOG.md`.

## Verification
- Lint and typecheck pass. `vitest` with temp Postgres and Mailpit: 7 files, 61 tests passed.
- The real CLI, run through the root `pnpm` script against the temp DB:
  - creating an admin with the password on stdin works;
  - running it again reports "already an admin";
  - `--password` is refused;
  - an unknown email without `--name` explains what to pass.
- The build emits `dist/db/create-admin.js`.
