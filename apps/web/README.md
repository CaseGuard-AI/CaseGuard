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
- Local dev: the cookie is `Secure`, which Chrome and Firefox accept on `http://localhost`.

## Scripts

`dev`, `build`, `start`, `lint`, `typecheck` (`next typegen` + `tsc`), `test` (vitest + Testing Library, jsdom) and `format`.

## Layout

```
messages/{en,ur}.json      UI strings
src/app/globals.css        design tokens ported from the prototype (oklch, light theme only)
src/app/[locale]/          root layout (lang/dir, fonts, providers), not-found; (app)/ guarded screens, (auth)/ login and register
src/components/shell/      AppShell: sidebar, header, nav items, PageIntro, ComingSoon placeholder
src/components/ui/         shadcn/ui components (RTL-safe)
src/components/auth/       session provider and guard, login and register forms
src/components/            TrustBadge, ApiStatus, Providers (TanStack Query, Radix direction, tooltips, session)
src/i18n/                  routing, request config, locale-aware navigation
src/lib/api.ts             typed api.v1 client (openapi-fetch + @caseguard/contracts), problemOf()
src/lib/utils.ts           cn() for class names
src/proxy.ts               locale redirect
test/                      vitest
Dockerfile                 standalone production image (build from the repo root)
```

## Shell and components

- Every screen from the prototype has a route. Screens that are not built yet render `ComingSoon`. Replace it when the screen's issue lands. Nav order and icons live in `src/components/shell/nav-items.ts`.
- Add shadcn/ui components when a screen needs them: `pnpm dlx shadcn@latest add <name>` (`components.json` has `rtl: true`). Then run `pnpm test`, because the RTL check catches any physical class the generator leaves behind. Import `cn` from `@/lib/utils`.
- Radix side props (`side="left"`) are physical. Pick the side from `directionOf(locale)`, or use the sheet's logical `start`/`end`.
