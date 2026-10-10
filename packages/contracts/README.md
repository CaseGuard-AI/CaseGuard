# packages/contracts: service contracts

The **source of truth** for every interface between services ([ADR-0002](../../docs/adr/0002-two-backends-with-strict-boundary.md)). Write the contract first, then the code.

| File | Interface | Producer → consumer |
|---|---|---|
| `openapi/api.v1.yaml` | Public REST `/api/v1` | `apps/api` → `apps/web` |
| `openapi/ai.v1.yaml` | Internal REST `/ai/v1` | `services/ai` → `apps/api` |

## Rules

- A change to a contract goes in its **own PR**, reviewed by the producer *and* the consumer streams.
- A breaking change needs a `!` in the PR title (`feat(contracts)!: …`) and a version bump in the path.
- Clients and types are **generated** into `generated/` (TypeScript via `openapi-typescript`, Python via `datamodel-code-generator`). Never edit them by hand.
- CI lints every spec with Redocly once `openapi/*.yaml` exists.

## Week-1 deliverable (M0)

Both specs drafted covering the M1 vertical slice: auth, ask question, get answer with citations + statuses, and get the citation source.
