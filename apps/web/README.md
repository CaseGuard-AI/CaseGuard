# apps/web: CaseGuard frontend

**Stream A · Next.js (App Router), TypeScript, Tailwind, shadcn/ui, next-intl, TanStack Query** ([ADR-0006](../../docs/adr/0006-nextjs-frontend-rebuild.md))

> Not scaffolded yet. CI skips this app until `package.json` exists.

## Scope

All screens in [PRD §4.2](../../docs/PRD.md#42-module-map), ported from the [`high_level_design`](https://github.com/CaseGuard-AI/high_level_design) prototype.

## Non-negotiables

- The browser talks **only** to `apps/api`, through the client generated from `packages/contracts`.
- No user-facing string literals. Everything goes through next-intl (`en`, `ur`).
- RTL-safe CSS only: logical properties (`ms-*`, `me-*`, `ps-*`, `start-*`) and no `left`/`right`.
- Trust badges render the status **as returned by the API**. The frontend never computes a status.

## Scaffold (first PR: `feature/web-scaffold`)

```bash
pnpm create next-app@latest apps/web --ts --tailwind --eslint --app --src-dir --import-alias "@/*"
```

Then add the `lint`, `typecheck`, `test` and `build` scripts that CI expects.
