# apps/web: CaseGuard frontend

**Stream A · Next.js (App Router), TypeScript, Tailwind, shadcn/ui, next-intl, TanStack Query** ([ADR-0006](../../docs/adr/0006-nextjs-frontend-rebuild.md))

## Scope

All screens in [PRD §4.2](../../docs/PRD.md#42-module-map), ported from the [`high_level_design`](https://github.com/CaseGuard-AI/high_level_design) prototype.

## Non-negotiables

- The browser talks **only** to `apps/api`, through the client generated from `packages/contracts`.
- No user-facing string literals. Everything goes through next-intl (`en`, `ur`).
- RTL-safe CSS only: logical properties (`ms-*`, `me-*`, `ps-*`, `start-*`) and no `left`/`right`.
- Trust badges render the status **as returned by the API**. The frontend never computes a status.

## Run locally

```bash
pnpm install          # from the repo root (or: pnpm setup)
pnpm dev:web          # http://localhost:3000 → redirects to /en or /ur
```

`NEXT_PUBLIC_API_URL` (default `http://localhost:4000/api/v1`) points at `apps/api`. Call it only through `api` from `@/lib/api`, which is typed from `packages/contracts`. After a contract change, run `pnpm gen:contracts`. The home page shows whether the API is reachable.

> **Next.js 16.** `middleware` is now `src/proxy.ts`, and `cacheComponents` and partial prefetching are on. APIs differ from older docs, so check `node_modules/next/dist/docs/` first (see `AGENTS.md`).

## i18n and RTL

- Locales: `en` (default) and `ur`, routed as `/en/...` and `/ur/...` (`src/i18n/routing.ts`). `proxy.ts` picks the locale from the cookie or `Accept-Language`.
- Strings live in `messages/en.json` and `messages/ur.json`. A test fails if their keys ever differ.
- `<html lang dir>` is set per locale. Urdu uses Noto Nastaliq Urdu with a taller line height.
- Use `Link`, `useRouter` and `usePathname` from `@/i18n/navigation`, not from `next/*`.
- `test/rtl-classes.test.ts` fails on any physical utility (`ml-*`, `pl-*`, `left-*`, `border-r`, `text-left`…) under `src/`. Mirror directional icons with `rtl:rotate-180` or `rtl:-scale-x-100`.

## Auth and the session

- `/login` and `/register` (`src/app/[locale]/(auth)/`) sit outside the shell. Every page in `(app)/` goes through `RequireSession`, which sends signed-out visitors to `/login?next=<path>`.
- The session (`src/lib/session.ts`) lives **in memory only**. The HttpOnly `cg_refresh` cookie is what survives a reload, and `/auth/refresh` turns it back into a session. The store adds `Authorization: Bearer …` to every non-auth call on `api`, and refreshes first when the token has less than 30 s left.
- **Never call `/auth/refresh` directly.** The API revokes the whole session family if a rotated refresh token is sent again. `refresh()` is single-flight in the tab and holds a Web Lock across tabs. Tabs share the session over a `BroadcastChannel`, so a new tab usually doesn't refresh at all, and signing out in one tab signs out all of them.
- A 429 or network error on refresh shows "can't reach the server" with Retry. It doesn't sign the user out. (`/auth/refresh` shares a rate limit with register: #83.)
- **Password reset.** `/forgot-password` shows "check your inbox" for any API answer (202, 400 or 429), so the page never reveals whether an account exists. Only a request that got no answer shows an error. The emailed link, `/reset-password?token=…`, has no locale, and the proxy keeps the query when it adds one. The page reads the token once, removes it from the address bar and history (`history.replaceState`), and sends `Referrer-Policy: no-referrer` (a `<meta name="referrer">`). A 400 with `errors[]` is a field error. A 400 without it is an unknown, used or expired token, which shows "invalid link" with a way to request a new one. After a reset the API revokes every session, so the page calls `signOut()` (all tabs) and goes to `/login?reset=1`.
- Only `/login` and `/register` send a signed-in user on (`RedirectIfSignedIn` in each page). The reset pages work while signed in.
- Local dev: the cookie is `Secure`, which Chrome and Firefox accept on `http://localhost`.

## Research Hub

- `/research` (`src/components/research/`) shows the conversation in `?c=<id>`. The first question creates the conversation, then asks. Only the URL decides which conversation is shown, so the sidebar link starts a fresh one. A `?c=` that gets 404 clears itself.
- **One trust store (FR-TRUST-10).** Every view of a citation (its chip, its row in the sources list, the source panel) reads the same TanStack Query entry, `["citation", id]` in `queries.ts`. It starts from the copy saved with the answer, and `GET /citations/{id}` replaces it with the current stored verification. If that lookup fails, the saved copy stays. Never compute or derive a status in the UI.
- **Answers are plain text.** `markers.ts` turns `[[c:<id>]]` into numbered chips and drops a marker with no matching citation. There's no Markdown and no `dangerouslySetInnerHTML`.
- **Content keeps its own language (FR-RES-10).** The answer, each quote and each excerpt get `lang`/`dir` from their own `Language` (`src/lib/language.ts`), not the UI locale, and are never translated.
- The official link renders only for `http(s)` URLs (`safeUrl`), with `target="_blank" rel="noopener noreferrer"`.
- Until services/ai has `research/answer` (#20), the live stack answers every question with 503. Browser checks mock the ask, citation and source calls with Playwright `page.route`. To check the AI-off (403) state, turn AI off for the user in `/admin`.

## Admin console

- `/admin` (`src/components/admin/`) has two tabs: **Users**, for per-user AI access, and **Model providers**, for the allow-list. The tab is kept in `?tab=`. It's built on the admin API (`/admin/*`).
- **The browser only hides it; the API decides.** The sidebar link and the page show only when `session.user.role === "admin"`. A User gets "Admins only" and the page sends no `/admin` request. A 403 from the API (for example, the role was removed elsewhere) shows the same panel.
- **Switches wait for the server.** Each row owns its mutation, and the cache changes only when the PATCH succeeds. While it's in flight the switch is disabled; if it fails, the switch stays where it was and the row shows an error.
- **Turning on a cloud provider asks first (SEC-11)**, because questions and case data may then go to a third party. Turning a local provider on, or anything off, doesn't ask. If every provider is off, a warning says every question will fail (the API's 503).
- To make the first Admin locally: `printf '<password>\n' | docker compose exec -T api node dist/db/create-admin.js --email <email> --name "<name>"`. Sign in as that account and open `/admin`.

## Settings, language and theme

- `/settings` (`src/components/settings/`) edits the user's own name, language and theme through `GET`/`PATCH /me/settings` (FR-SET-1). Each section saves on its own, and the page shows only saved values: a failed save leaves the old one selected. A new name also updates the session's `user` (`updateUser` in `src/lib/session.ts`), so the header changes without waiting for a refresh.
- **The account's language and theme apply wherever the user signs in.** `AccountPreferences`, mounted in `(app)/layout.tsx`, loads the settings and applies them.
- **The saved locale takes over once per session start:** after sign-in, or when a new tab restores the session. After that, a reload or a typed or shared `/en` or `/ur` URL in the same tab is left alone. The flag is in `sessionStorage` (`cg-locale-applied`) and is cleared on sign-out.
- **The header's language switch also saves to the account** when signed in. It waits for the `PATCH` before it moves the page, so the next settings load can't bring back the old locale. If the save fails, the page still switches.
- **Theme (`src/lib/theme.ts`).** The resolved theme goes on `<html>` as `data-theme="light|dark"`. It's an attribute, not a class, because React owns `className` there. `dark:` variants and the dark tokens in `globals.css` key off it. `system` follows `prefers-color-scheme` live.
- **No flash on reload.** The session and settings arrive only after `/auth/refresh`, so the last choice is cached in `localStorage` (`cg-theme`). An inline script in the root layout's `<head>` applies it before the first paint (`<html suppressHydrationWarning>`). The auth pages use the cached theme too.
- **Dark tokens** have the same names as the light ones. `primary-foreground` stays light because it's also the text on navy. Use `text-link`, not `text-primary`, for text links: in dark mode `primary` is a button fill and too dark to read as text.

## Scripts

`dev`, `build`, `start`, `lint`, `typecheck` (`next typegen` + `tsc`), `test` (vitest + Testing Library, jsdom) and `format`.

## Layout

```
messages/{en,ur}.json      UI strings
src/app/globals.css        design tokens ported from the prototype (oklch), plus the dark set
src/app/[locale]/          root layout (lang/dir, fonts, providers), not-found; (app)/ guarded screens, (auth)/ login, register, forgot and reset password
src/components/shell/      AppShell: sidebar, header, nav items, PageIntro, ComingSoon placeholder
src/components/ui/         shadcn/ui components (RTL-safe)
src/components/auth/       session provider and guard, login, register and password-reset forms
src/components/admin/      Admin console: users' AI access, provider allow-list
src/components/settings/   Settings page, settings queries, AccountPreferences (saved theme and locale)
src/components/research/   Research Hub: thread, ask box, citation chips, sources list, source panel, queries
src/components/            TrustBadge, Providers (TanStack Query, Radix direction, tooltips, session)
src/i18n/                  routing, request config, locale-aware navigation
src/lib/api.ts             typed api.v1 client (openapi-fetch + @caseguard/contracts), problemOf()
src/lib/api-query.ts       ApiError and unwrap() for TanStack Query over the api client
src/lib/language.ts        content language → lang/dir (answers, quotes, sources)
src/lib/theme.ts           applyTheme(), the pre-paint head script, the cg-theme cache
src/lib/utils.ts           cn() for class names
src/proxy.ts               locale redirect
test/                      vitest
Dockerfile                 standalone production image (build from the repo root)
```

## Shell and components

- Every screen from the prototype has a route. Screens that are not built yet render `ComingSoon`. Replace it when the screen's issue lands. Nav order and icons live in `src/components/shell/nav-items.ts`.
- Add shadcn/ui components when a screen needs them: `pnpm dlx shadcn@latest add <name>` (`components.json` has `rtl: true`). Then run `pnpm test`, because the RTL check catches any physical class the generator leaves behind. Import `cn` from `@/lib/utils`.
- Radix side props (`side="left"`) are physical. Pick the side from `directionOf(locale)`, or use the sheet's logical `start`/`end`.
