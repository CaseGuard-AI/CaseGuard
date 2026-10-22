> **Status:** In progress · **Issue:** [#12](https://github.com/CaseGuard-AI/CaseGuard/issues/12) · **PR:** [#84](https://github.com/CaseGuard-AI/CaseGuard/pull/84)

# #12: Login and register pages (web)

## Context

#12 needs login and register forms against `/auth/*`. The session is kept in memory and refreshed through the cookie, and validation errors come from problem+json `errors[]`. Its dependencies are merged: the auth API (#10), the app shell (#11, PR #78) and the typed api.v1 client (#79, PR #80).

How the API behaves, which shapes this plan (`apps/api/src/routes/auth.ts`, `auth/store.ts`, `middleware/rate-limit.ts`):
- **Session:** `login` and `register` return `Session { accessToken, expiresIn: 900, user }` and set `cg_refresh`, which is HttpOnly, Secure, `SameSite=Strict`, path `/api/v1/auth` and lasts 14 days. `POST /auth/refresh` rotates the cookie and returns a new `Session`.
- **Reuse detection has no grace window.** Presenting a refresh token that has already been rotated revokes the whole family. Two refreshes racing (two tabs, React running an effect twice, a timer firing while a request is in flight) would sign the user out everywhere. The client must never send the same cookie twice.
- **Refresh is rate-limited** by `authLimiter`: 20 per 15 minutes per IP, shared with register and password reset. A refresh on every full page load in every tab would run into it.
- **Errors:** login returns 401 "Incorrect email or password." for both unknown email and wrong password, and 429 from the login limiter (10 failures per 15 minutes per IP and email). Register returns 409 for a taken email. 400 is a `ValidationProblem` whose `errors[].message` is English text from Zod.

**Requirements:** FR-AUTH-1, FR-I18N-1.

**Decisions (owner):**
- **Signing in is required for the app.** Every page in the shell goes through a session guard, and signed-out visitors go to `/login?next=<path>` (owner's choice).
- **The session lives only in memory.** It is a small store outside React (`src/lib/session.ts`), read through `useSyncExternalStore`. There is no localStorage or sessionStorage, so only the HttpOnly cookie survives a reload.
- **Refreshes are serialised.**
  - Within a tab: one in-flight promise.
  - Across tabs: `navigator.locks.request("caseguard-auth", …)`, so tabs take turns. Each tab then reads the newest cookie, and a rotated token is never presented twice.
  - In environments without Web Locks (jsdom), it falls back to the in-tab promise only.
- **Tabs share the session to save refreshes.**
  - A `BroadcastChannel("caseguard-session")` carries `session` and `signed-out` messages.
  - A tab that starts up asks first (`hello`, waiting up to 150 ms). If another tab answers, it takes that session without calling `/auth/refresh`.
  - Login, refresh and logout are broadcast, so signing out in one tab signs out all of them.
- **No timers.** Before each API call, the client middleware refreshes the session if the access token expires within 30 seconds. This also covers laptops waking from sleep. A 401 from a non-auth route sets the user signed out, and the guard then redirects.
- **A 429 or network failure on refresh doesn't sign the user out.** The guard shows a "can't reach the server" state with a Retry button instead of redirecting, because the cookie may still be valid.
- **Error messages are localised by us, not shown from the server.** 401 maps to `Auth.errors.invalidCredentials`, 409 to `Auth.errors.emailTaken` and 429 to `Auth.errors.tooMany`. 400 `errors[]` entries are mapped by `path` (`email`, `password`, `name`) to localised field messages, with the server text as a fallback for unknown paths. The browser checks the same rules first (`type=email`, `required`, `minLength=10`).
- **`next` is checked.** Only same-site paths are accepted, meaning they start with `/` but not `//` or `/\`. Anything else goes to `/`.
- **Auth pages sit outside the shell.** They use the prototype's split layout: a navy hero on large screens and the form, with a language switch. The "Forgot password?" link and the `/forgot-password` page belong to #62.
- **The register form sends the current UI locale** as `locale`.

Branch: `feature/web-auth-pages` off `staging`. PR title: `feat(web): login and register pages with an in-memory session`.

## Changes

1. **Route groups** (`src/app/[locale]/`)
   - `layout.tsx` keeps `<html>`, fonts and `Providers`, and drops `AppShell`.
   - `(app)/layout.tsx` (new) renders `<RequireSession><AppShell>{children}</AppShell></RequireSession>`.
   - Move `page.tsx`, the 10 screen folders and `[...rest]` into `(app)/`. URLs don't change.
   - `(auth)/layout.tsx` (new) holds the prototype's split hero. `(auth)/login/page.tsx` and `(auth)/register/page.tsx` are new, with `generateMetadata` titles.
   - `not-found.tsx` stays at the `[locale]` level as a centred standalone card, because it no longer renders inside the shell.

2. **Session store** (`src/lib/session.ts`, no React)
   - State is `{ status: "loading" | "authenticated" | "anonymous" | "unavailable", user?, accessToken?, expiresAt? }`, plus `subscribe` and `getSnapshot`.
   - `restore()` asks other tabs first, then calls `refresh()`.
   - `refresh()` is single-flight: Web Lock, then `POST /auth/refresh`. 200 sets the session and broadcasts it, 401 sets anonymous, and 429 or a network error sets unavailable.
   - `signIn(session)`, `signOut()` (Web Lock, then `POST /auth/logout`, then clear and broadcast; it clears locally even if the API fails), and `tokenFor()` (refreshes first if the token expires within 30 seconds).
   - The `BroadcastChannel` handlers are wired in here.

3. **API client** (`src/lib/api.ts`)
   - Add an `openapi-fetch` middleware.
   - `onRequest`: for every path except `/auth/login|register|refresh|logout|password-reset*`, set `Authorization: Bearer ${await tokenFor()}` when there is a session.
   - `onResponse`: a 401 on those same paths calls `session.expire()`.

4. **React wiring**
   - `src/components/auth/session-provider.tsx` calls `restore()` once on mount. It exports `useSession()` (via `useSyncExternalStore`), and `Providers` wraps it.
   - `src/components/auth/require-session.tsx` handles each status:
     - `loading`: a centred spinner with `aria-busy`.
     - `anonymous`: `router.replace("/login?next=" + pathname)`.
     - `unavailable`: a message and a Retry button that calls `refresh()`.
     - `authenticated`: renders the children.
   - `src/components/auth/redirect-if-signed-in.tsx`: on the auth pages, an authenticated user is sent to `next` (or `/`).

5. **Forms** (`src/components/auth/`)
   - `login-form.tsx` has email and password fields.
   - `register-form.tsx` has name, email and password (with a hint for the 10-character minimum) and sends `locale`.
   - They share `use-auth-form.ts`:
     - It holds pending state and calls `api.POST(...)`.
     - It maps errors with `problemOf()` into `{ form?: string; fields: Partial<Record<"email"|"password"|"name", string>> }`, then calls `signIn()` and `router.replace(safeNext)`.
   - Fields use shadcn `Input` with a new `Label`, plus `aria-invalid` and `aria-describedby` pointing at the error text. The form-level error has `role="alert"`, and the submit button is disabled while pending.
   - Each form links to the other one, keeping `next`.
   - `src/lib/safe-next.ts` does the `next` check.

6. **Shell wired to the user** (`src/components/shell/`)
   - `app-header.tsx`: the account trigger shows initials and the name (from `sm` up). The dropdown label shows the name and email, and there is a new **Sign out** item that calls `signOut()` and then goes to `/login`.
   - `sidebar.tsx`: the footer shows the user's name and role (`Nav.roles.user` / `Nav.roles.admin`) in place of "My account".

7. **shadcn:** `pnpm dlx shadcn@latest add label`, then convert any physical classes (the RTL test enforces this).

8. **Messages** (en and ur, same keys)
   - `Auth.hero.{eyebrow,title,body,sourceVerified,procedurallyChecked,footer}`, `Auth.login.{title,subtitle,submit,noAccount,register}` and `Auth.register.{title,subtitle,submit,haveAccount,login,passwordHint}`.
   - `Auth.fields.{name,email,password}`.
   - `Auth.errors.{invalidCredentials,emailTaken,tooMany,network,email,password,name,generic}`.
   - `Auth.session.{checking,unavailable,retry}`.
   - `Nav.{signOut,roles.user,roles.admin}`.

9. **Tests** (`apps/web/test/`, using the stubbed `fetch` pattern from `api.test.ts`)
   - `session.test.ts`:
     - Two concurrent `refresh()` calls make exactly one request.
     - `tokenFor()` refreshes when the token is about to expire and doesn't when it's fresh.
     - A refresh 401 means anonymous, and 429 means unavailable, not anonymous.
     - `signOut()` clears the session even when logout fails.
     - A broadcast `signed-out` clears the session, and a `hello` is answered with the session (using a fake `BroadcastChannel`).
     - The bearer header goes on `/conversations` but not on `/auth/refresh`.
   - `login-form.test.tsx`, rendered in ur:
     - Labels come from `ur.json`.
     - A 401 shows the localised invalid-credentials message in `role=alert`.
     - A 400 with `errors:[{path:"email"}]` marks the email field `aria-invalid` and shows the field message.
     - Success calls `router.replace` with `next`, and `next=//evil.com` goes to `/`.
   - `register-form.test.tsx`: a 409 becomes an email field error, `locale` is sent, and the password has `minLength=10`.
   - `require-session.test.tsx`:
     - Anonymous redirects to `/login?next=/research`.
     - Unavailable shows Retry.
     - Authenticated renders the children.
   - Update `shell.test.tsx`: the header shows the user's name, and Sign out calls `/auth/logout` and then redirects.
   - `safe-next.test.ts`.

10. **Docs**
    - `apps/web/README.md`: an Auth section covering the session model, why refreshes are serialised (reuse detection), and the dev note that the `Secure` cookie works on `http://localhost` in Chrome and Firefox.
    - `CHANGELOG.md` entry.
    - This plan's status line.

## Not in this PR
- `/forgot-password` and `/reset-password` pages and the login page's "Forgot password?" link: #62.
- **A higher, separate rate limit for `/auth/refresh`** in apps/api: #83.
- Profile, settings and the "Remember me" option from the prototype. The refresh cookie already lasts 14 days.
- Server-side route protection (the proxy has no session). The guard is client-side, and the API enforces access on every call.

## Verification
- `pnpm --filter ./apps/web run lint`, `typecheck`, `test` (all pass, none skipped) and `build`.
- `pnpm stack:up` (db, api and web), then in a browser:
  1. `/en/research` signed out redirects to `/en/login?next=/research`.
  2. Register shows the field errors from the API, for example a duplicate email showing the localised "already registered" message.
  3. Registering lands on `/research`, and the header shows the name.
  4. Reloading keeps the session (one `/auth/refresh` in the network panel).
  5. With two tabs open, reloading both still makes only one refresh at a time, and neither tab is signed out.
  6. Signing out in one tab signs out the other.
  7. A wrong password shows the localised 401 message.
  8. Repeat the flow in `/ur` (RTL, Nastaliq).
- CI `ci-ok` is green.

## Deviations during implementation
- **No `use-auth-form.ts`.** Submitting is `use-auth-submit.ts`, and error mapping is a pure `auth-errors.ts` that is easy to test. The form only calls `signIn()`, and `RedirectIfSignedIn` does the navigation, so one place decides where to go after signing in.
- **A generation counter in the store** means a refresh that started before a sign-in or sign-out can't overwrite it. This covers the login page, where `restore()` may still be in flight when the user submits.
- **Sign out doesn't navigate.** Clearing the session makes the guard send this tab (and the others, through the broadcast) to `/login?next=<current page>`.
- **`[...rest]` stays at the `[locale]` level**, outside `(app)`, so unknown URLs render the standalone not-found page with no guard. Under `(app)`, its dynamic params made `usePathname` in the guard fail static prerendering.
- **`LanguageSwitch` was pulled out of the header**, so the auth pages can reuse it.
- **The email and password inputs are `dir="ltr"`**, so addresses read correctly in Urdu.
- **The `cn` package was removed again** after `shadcn add label` added it; the import uses `@/lib/utils`, as in #11.
