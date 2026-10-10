# ADR-0006: Rebuild the frontend in Next.js, porting the prototype's components

- **Status:** Accepted
- **Date:** 2026-10-10
- **PRD refs:** §14.3, FR-I18N-1

## Context
`high_level_design` is a Lovable-generated TanStack Start + Vite prototype with mock data (17 routes, shadcn/ui). The agreed stack is Next.js, and the product needs Urdu/RTL from day one.

## Decision
- Build `apps/web` with **Next.js (App Router) + TypeScript + Tailwind + shadcn/ui + next-intl + TanStack Query**.
- **Port, don't redesign:** shadcn components, the app shell, the trust and freshness badges and the screen layouts are moved over from the prototype, then adapted.
- RTL-safe styling (logical properties) and externalised strings are mandatory from the first commit.
- The browser talks only to `apps/api`, using a client generated from `packages/contracts`.

## Alternatives considered
| Option | Why not |
|---|---|
| Keep evolving the TanStack/Vite prototype | Team chose Next.js; the prototype was generated scaffolding, not an agreed architecture |

## Consequences
- Some weeks of porting effort, but one framework that matches the report and supports SSR where it helps.
- `high_level_design` becomes read-only and is archived after the port.
