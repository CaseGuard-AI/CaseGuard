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

## Conventions

- **JSON field names are camelCase** in both specs. In Python, map them with a Pydantic `alias_generator`.
- **Errors** use RFC 9457 `application/problem+json`. Validation errors add an `errors[]` list of `{path, message}`.
- **Trust shapes are defined once.** `Citation`, `Verification`, `Source`, `Language` and `Problem` live in `ai.v1.yaml`, and `api.v1.yaml` references them with `$ref`, so a status can't mean different things on each side (FR-TRUST-10).
- **Citation markers** in answer text: `[[c:<citationId>]]` at the claim the citation supports.
- **Scope** (`userId`, `accountId`, `allowedCaseIds`) is resolved by `apps/api` and applied by `services/ai` inside SQL (FR-CASE-6).

## Lint

```bash
npx @redocly/cli lint packages/contracts/openapi/*.yaml     # config: /redocly.yaml, /.redocly.lint-ignore.yaml
```

## Status

`1.0.0-draft` covers the M1 vertical slice: auth (including password reset), conversations, asking a question, an answer with verified citations, and fetching a citation or source. Generated clients (`generated/`) come with the first consumer PR.
