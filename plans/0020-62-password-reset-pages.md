> **Status:** In progress · **Issue:** [#62](https://github.com/CaseGuard-AI/CaseGuard/issues/62) · **PR:** [#85](https://github.com/CaseGuard-AI/CaseGuard/pull/85)

# #62: Forgot-password and reset-password pages (web)

## Context

#62 builds the web side of password reset against `api.v1`:
- `/forgot-password` posts `requestPasswordReset` and always shows "check your email".
- `/reset-password?token=…` posts `confirmPasswordReset`, then sends the user to login. A 400 shows "this link is invalid or expired" with a way to request a new one.
- Both pages are in EN and UR (RTL), and the login page links to `/forgot-password`.

Its dependencies are all merged: the shell (#11), login (#12), the API (#53) and email (#61).

How the API behaves (`apps/api/src/routes/auth.ts`, `middleware/rate-limit.ts`):
- **Request:** `POST /auth/password-reset` always answers **202** before any lookup. It's limited to 5 per 15 minutes per IP and email (`resetLimiter`) and also counts towards `authLimiter`, so 429 is possible. A malformed email gives 400.
- **Confirm:** `POST /auth/password-reset/confirm` gives **204** on success, then **revokes every session** and clears the `cg_refresh` cookie.
  - The same **400** status covers a validation failure (`errors[]`, for example `path: "password"`) and an unknown, used or expired token (no `errors[]`, detail "This reset link is invalid or has expired."). The page tells them apart by whether `errors[]` is present.
- **The email link** is `RESET_URL_BASE?token=…`, which defaults to `http://localhost:3000/reset-password?token=…`. It has **no locale**, so the next-intl proxy redirects it to `/{locale}/reset-password`. The query string has to survive that redirect, which I'll check end to end.
- The token is valid for 30 minutes and works once.

**Requirements:** FR-AUTH-1, FR-I18N-1.

**Decisions:**
- **`/forgot-password` shows "check your email" for any HTTP answer** (202, 400, 429), as the issue asks, so the page never reveals anything. Only when `fetch` itself fails (no response at all) does it show the network error, because then nothing was sent and saying "check your email" would be false.
- **The token leaves the address bar right away.** `/reset-password` reads `?token` once, keeps it in component state and calls `history.replaceState` to drop it from the URL and history. The page also sets `referrer: "no-referrer"` in its metadata, so the token can't leak through a `Referer` header. A page with no token shows the invalid-link state straight away.
- **400 handling on confirm:** if `errors[]` is present, the matching field (`password`) shows its error and the form stays. If it isn't, the form is replaced by the invalid-link state ("This link is invalid or has expired") with a button to `/forgot-password`.
- **After 204:** every session is revoked by the API, so this browser signs out locally too (`signOut()`, which also tells other tabs). The user then goes to `/login?reset=1`, where a success notice says the password changed.
- **Only login and register redirect a signed-in user away.** `RedirectIfSignedIn` moves from the `(auth)` layout into those two pages. Otherwise a signed-in user following a reset email would be bounced to the app.
- **A "Forgot password?" link** sits beside the password label on the login form, as in the prototype.

Branch: `feature/web-password-reset` off `staging`. PR title: `feat(web): forgot-password and reset-password pages`.

## Changes

1. **Routes** (`src/app/[locale]/(auth)/`)
   - `forgot-password/page.tsx` and `reset-password/page.tsx` are new, each with `generateMetadata`. The reset page also sets `referrer: "no-referrer"`.
   - `layout.tsx` keeps the `Suspense` but drops `RedirectIfSignedIn`. `login/page.tsx` and `register/page.tsx` wrap their forms in it instead.

2. **Forms** (`src/components/auth/`)
   - `forgot-password-form.tsx`:
     - An email field. On submit, it calls `api.POST("/auth/password-reset")`.
     - Any response switches to the sent state: a success panel ("Check your inbox", with the 30-minute expiry) and a link back to login.
     - A thrown fetch shows `Auth.errors.network`.
   - `reset-password-form.tsx`:
     - On mount it takes the token from `useSearchParams` and removes it from the URL.
     - It has a new-password field (`minLength=10`, `autoComplete="new-password"`, `dir="ltr"`, with a hint).
     - 204 calls `await signOut()`, then `router.replace("/login?reset=1")`.
     - 400 with `errors[]` sets field errors through `authErrors()`. 400 without it, or a missing token, shows the invalid-link panel with a "Request a new link" button.
     - 429 and network errors reuse the existing messages.
   - `login-form.tsx` gets a "Forgot password?" link (`/forgot-password`) beside the password field, and a success notice when `?reset=1`.
   - `form-field.tsx` gets an optional `labelAction` slot, so the link can sit inline with the label using logical alignment.

3. **Messages** (en and ur, same keys)
   - `Auth.forgot.{title,subtitle,submit,sentTitle,sentBody,backToLogin}`.
   - `Auth.reset.{title,subtitle,submit,invalidTitle,invalidBody,requestNew}`.
   - `Auth.login.{forgot,resetDone}`.

4. **Tests** (`apps/web/test/password-reset.test.tsx`, using the stubbed `fetch` and navigation mocks from `auth-forms.test.tsx`)
   - Forgot (ur labels): 202, 429 and 400 each show the sent state, a thrown fetch shows the network message, and the request body is `{ email }`.
   - Reset:
     - No token shows the invalid state and makes no request.
     - The token is sent in the body and removed from the URL (`history.replaceState` called with no `token`).
     - 400 without `errors` shows the invalid state, linked to `/forgot-password`.
     - 400 with `errors:[{path:"password"}]` marks the field `aria-invalid` and keeps the form.
     - 204 posts `/auth/logout`, leaves the session anonymous and calls `replace("/login?reset=1")`.
   - Login: shows the forgot link, and `?reset=1` shows the success notice.
   - `rtl-classes.test.ts` and `i18n.test.ts` already cover the new files and keys.

5. **Docs**
   - `apps/web/README.md`: in the Auth section, describe the reset flow (token removed from the URL, no-referrer, signs out after reset).
   - `CHANGELOG.md` entry.
   - This plan's status line.

## Deviations during implementation
- **`vitest.config.ts` sets `testTimeout: 15_000`.** With a tenth jsdom file, the first test in `auth-forms`, `require-session` and `password-reset` sometimes passed the 5 s default on this 8-core machine. Each of those tests pays for a cold `await import(...)` of the forms after `vi.resetModules()`. On `staging` all 44 tests passed; with the new file 3–5 failed in most runs, every one a timeout and never an assertion. With 15 s, five runs in a row passed.
- **The reset form doesn't use `useAuthSubmit`.** That hook calls `signIn()` on success, and confirm returns 204 with no session. The form calls `authErrors()` directly instead.
- **The token is held in `useState(() => …)`** and not re-read from `useSearchParams`. Next syncs its router with `history.replaceState`, so after the token is stripped the search params no longer have it.
- **Forgot doesn't show field errors for a 400.** Following the decision above, every HTTP answer shows the sent state. The browser's own `type="email"` check catches most typos first.

## Not in this PR
- Any API change. Reset emails are English-only, and `RESET_URL_BASE` has no locale. Both are fine because the proxy picks the locale, and could be follow-ups if wanted.
- A confirm-password field or a show-password toggle (not asked for).
- The refresh rate limit (#83).

## Verification
- `pnpm --filter ./apps/web run lint`, `typecheck`, `test` (all pass, none skipped) and `build`.
- `pnpm stack:up`, register a user, then:
  1. `/ur/login` shows "Forgot password?", which leads to `/ur/forgot-password`. Submitting shows "check your email".
  2. Mailpit (http://localhost:8025) has the email. Opening its locale-less link reaches `/{locale}/reset-password` with the token kept, and then the token is gone from the address bar.
  3. Setting a new password lands on `/login?reset=1` with the success notice. The old password now fails, and the new one signs in.
  4. Opening the same link again shows the invalid-link state.
  5. A short password shows the field error.
  6. While signed in, a reset in this browser signs out the other open tab.
- CI `ci-ok` is green.
