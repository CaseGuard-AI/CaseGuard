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

`NEXT_PUBLIC_API_URL` (default `http://localhost:4000/api/v1`) points at `apps/api`. The home page shows whether the API is reachable.

> **Next.js 16.** `middleware` is now `src/proxy.ts`, and `cacheComponents` and partial prefetching are on. APIs differ from older docs, so check `node_modules/next/dist/docs/` first (see `AGENTS.md`).

## i18n and RTL

- Locales: `en` (default) and `ur`, routed as `/en/...` and `/ur/...` (`src/i18n/routing.ts`). `proxy.ts` picks the locale from the cookie or `Accept-Language`.
- Strings live in `messages/en.json` and `messages/ur.json`. A test fails if their keys ever differ.
- `<html lang dir>` is set per locale. Urdu uses Noto Nastaliq Urdu with a taller line height.
- Use `Link`, `useRouter` and `usePathname` from `@/i18n/navigation`, not from `next/*`.

## Scripts

`dev`, `build`, `start`, `lint`, `typecheck` (`next typegen` + `tsc`), `test` (vitest + Testing Library, jsdom) and `format`.

## Layout

```
messages/{en,ur}.json      UI strings
src/app/[locale]/          root layout (lang/dir, fonts, providers) and pages
src/components/            SiteHeader (language switch), TrustBadge, ApiStatus, Providers (TanStack Query)
src/i18n/                  routing, request config, locale-aware navigation
src/lib/api.ts             API base URL + fetch helper (replaced by the generated client later)
src/proxy.ts               locale redirect
test/                      vitest
Dockerfile                 standalone production image (build from the repo root)
```

shadcn/ui is added (`pnpm dlx shadcn@latest init`) in the first PR that ports prototype screens.
