# ADR-0004: Monorepo with a main / staging / feature branching model

- **Status:** Accepted
- **Date:** 2026-10-10
- **PRD refs:** §16.3

## Context
There are four deployables (web, api, ai, collector) and shared contracts, built by three parallel streams with AI coding agents. Separate repos fragment the PRD, the issues and the cross-service changes.

## Decision
- A single repository, `CaseGuard-AI/CaseGuard`: `apps/web`, `apps/api`, `services/ai`, `services/collector`, `packages/contracts` and `docs/`.
- JS workspaces use **pnpm**, and Python services use **uv** (each service has its own lockfile).
- `data_collector` is imported into `services/collector` **with its history** (`git subtree add`). `high_level_design` is archived as a visual reference.
- Branching: `main` (tagged releases) ← `staging` (default branch, integration) ← short-lived `feature/*` / `fix/*` / `chore/*` / `docs/*` branches. Squash merges into `staging`, merge commits into `main`. Protected branches, path-filtered CI. See [`docs/engineering/branching-and-release.md`](../engineering/branching-and-release.md).

## Alternatives considered
| Option | Why not |
|---|---|
| Repo per service | Fragmented docs and issues; cross-service changes need multiple coordinated PRs |
| Trunk-based (main only) | The team wants a stable, demo-ready `main` separate from integration |

## Consequences
- Atomic cross-service changes are possible, and there is one source of truth for the docs.
- CI must be path-filtered so that, for example, a web change doesn't run Python tests.
