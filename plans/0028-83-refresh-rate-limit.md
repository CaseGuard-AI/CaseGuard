> **Status:** In progress · **Issue:** [#83](https://github.com/CaseGuard-AI/CaseGuard/issues/83) · **PR:** [#158](https://github.com/CaseGuard-AI/CaseGuard/pull/158)

# #83: give `/auth/refresh` its own rate limit

## Context

**Why:** `POST /auth/refresh` used `authLimiter()`, the 20 requests per IP per 15 minutes that `register` and `password-reset/confirm` share (`apps/api/src/middleware/rate-limit.ts`). The web (#12) refreshes once per full page load. So several people behind one office NAT, or one person who reloads a lot, can hit 429 and see "can't reach the server". Those refreshes also use up the budget for sign-ups and password resets.

**Where it fits:** item A1 in `docs/engineering/stream-a-roadmap.md`. It's small and independent.

**Requirements:** FR-AUTH-1, SEC-15 (rate limiting).

## Decisions

- **A separate `refreshLimiter()`: 120 per IP per 15 minutes**, the ceiling the issue suggests. That's 8 a minute per IP. It has its own in-memory store, so refreshes and register/reset no longer use each other's budget.
- **Keyed by IP only, not by token family or user** (the issue suggested either one). The limiter runs before the token is looked up, so the family and user aren't known yet. A key built from the cookie wouldn't work either:
  - the token rotates on every successful call, so each refresh would start with a new budget;
  - an attacker could send a random cookie on every request and never be limited.

  Refresh tokens are 256-bit random values, so guessing one isn't a real threat. What the limit protects is the DB, from bursts of rotations. A per-IP ceiling handles that.
- **Successful refreshes still count.** With `skipSuccessfulRequests`, someone holding a valid cookie could force unlimited DB rotations.
- **Contract first:** api.v1 declared no 429 for `refreshSession`, even though the old limiter could already return one. A separate contracts PR (`feature/contracts-refresh-429`) adds it, and this PR is based on that one.
- `register` and `password-reset` keep their existing limits.

## Changes

1. `src/middleware/rate-limit.ts`: add `refreshLimiter()`, and say in `authLimiter`'s doc comment that it no longer covers refresh.
2. `src/routes/auth.ts`: `/auth/refresh` uses `refreshLimiter()` in place of `limitAuth`.
3. `test/auth.test.ts`, in `refresh`:
   - **Own budget:** register, then 25 chained refreshes are all 200, then a second register on the same IP is 201. The old shared limiter gave 429 at refresh 20.
   - **Abuse:** 120 refreshes without a cookie are 401, the 121st is 429 with `Retry-After`, checked with `expectContract`.
   - No password-reset call, because its background work can race the next `TRUNCATE` (#113).
4. Docs: the rate-limit line in `apps/api/README.md`, `CHANGELOG.md`, and A1 marked done in the Stream A roadmap.

## Verification

- Against a bootstrapped `caseguard_test` (as in plan 0024): `APP_TEST_DATABASE_URL=… pnpm --filter ./apps/api test` gave 129 passed, 3 skipped (the Mailpit tests, which need `MAILPIT_URL`; CI sets it).
- **Mutation check:** with `/auth/refresh` put back on `limitAuth`, both new tests fail ("refresh 20: expected 429 to be 200", and the burst hits 429 too early). Restored, they pass.
- `eslint`, `tsc --noEmit` and `prettier --check` are clean.

## Not in this PR

- A shared limiter store (Postgres or Redis) for more than one API instance. That's already noted in `rate-limit.ts`.
- A better web message for 429 on refresh. Today it shows "unavailable", the same as any other failure that isn't a 401.
