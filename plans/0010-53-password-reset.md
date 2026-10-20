> **Status:** Done · **Issue:** [#53](https://github.com/CaseGuard-AI/CaseGuard/issues/53) · **PR:** [#64](https://github.com/CaseGuard-AI/CaseGuard/pull/64)

# #53: password reset (API)

## Context
FR-AUTH-1 includes password reset. Its contract is already merged (#57): `POST /auth/password-reset` (always 202) and `POST /auth/password-reset/confirm` (204, which revokes every session, or 400). Email delivery (#61, PR #63) is merged too. This PR implements both endpoints in `apps/api`. The web pages are #62.

Branch `feature/api-password-reset` off `staging`. PR title: `feat(api): password reset by email link`.

## Changes
1. **Schema and migration**: `app.password_reset_tokens`, generated as `0002_password_reset_tokens` plus a hand-written `.down.sql`. It has:
   - `id`, `owner_user_id` → users (cascade), `account_id` → accounts (cascade) (FR-AUTH-5);
   - `token_hash` (unique, SHA-256);
   - `expires_at`, `used_at`, `created_at`;
   - an index on `owner_user_id`.
2. **`src/auth/tokens.ts`**: `RESET_TTL_S = 30 * 60`. Reset tokens reuse `newRefreshToken()` (32 random bytes) and `hashToken()`.
3. **`src/auth/store.ts`**:
   - `createResetToken(db, user)`: marks the user's unused tokens as used, so only the newest link works, and inserts a new one. Returns the raw token.
   - `resetPassword(db, token, passwordHash)`: one transaction that spends the token atomically (`UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`), sets `password_hash` and `updated_at`, spends the user's other reset tokens, and revokes every refresh token the user has. Returns false if the token is invalid.
4. **`src/routes/auth.ts`**:
   - `POST /auth/password-reset`, rate-limited by `resetLimiter` (5 per IP and email per 15 minutes) and `authLimiter`:
     - It answers **202 before doing any work**, so response time doesn't reveal whether the account exists.
     - In the background it looks up the user, creates a token, and emails `${RESET_URL_BASE}?token=…`.
     - A failure is logged through `req.log` and never reaches the client.
   - `POST /auth/password-reset/confirm`, rate-limited by `authLimiter`:
     - It argon2id-hashes the new password, then calls `resetPassword`.
     - On success it clears `cg_refresh` and returns 204. Otherwise it returns 400, "This reset link is invalid or has expired."
   - `authRouter` deps gain `mailer` and `resetUrlBase`.
5. **`src/middleware/rate-limit.ts`**: `resetLimiter()`.
6. **Env**: `RESET_URL_BASE` (a URL, default `http://localhost:3000/reset-password`) in `src/config/env.ts` and `.env.example`. `AppDeps.env` picks it up.
7. **Tests** (`test/password-reset.test.ts`, which needs `APP_TEST_DATABASE_URL`; a fake mailer records what it sends):
   - Request: 202 plus a contract check, and one mail to the user whose link carries a token. An unknown email gets 202, no mail, and no row.
   - Confirm: 204; the old refresh cookie then gives 401; the new password logs in and the old one gives 401.
   - Rejections: a reused token, an expired token, and a token superseded by a newer request each give 400. So does a bad body.
   - The 6th request for the same email gets 429.
   - An end-to-end case through Mailpit (when `MAILPIT_URL` is set) uses the real mailer: request, read the link from Mailpit, confirm, sign in.
   - `test/migrations.test.ts`: the table lists and the round trip now include `0002`.
8. **Docs**: `apps/api/README.md` (endpoints and the reset flow), `CHANGELOG.md`.

## Verification
- Lint and typecheck pass.
- `vitest` against temporary pgvector and Mailpit containers, with `APP_TEST_DATABASE_URL` and `MAILPIT_URL` set, passes with nothing skipped.
- CI is green.
