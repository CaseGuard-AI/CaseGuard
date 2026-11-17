# packages/contracts: service contracts

The **source of truth** for every interface between services ([ADR-0002](../../docs/adr/0002-two-backends-with-strict-boundary.md)). Write the contract first, then the code.

| File | Interface | Producer → consumer |
|---|---|---|
| `openapi/api.v1.yaml` | Public REST `/api/v1` | `apps/api` → `apps/web` |
| `openapi/ai.v1.yaml` | Internal REST `/ai/v1` | `services/ai` → `apps/api` |
| `taxonomy/case-taxonomy.v1.yaml` | Case taxonomy vocabulary: areas of law, proceeding types, statute→area rules ([doc](../../docs/engineering/case-taxonomy.md), #164) | everyone → collector, `services/ai`, `apps/api`, `apps/web` |

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
- **Admin-only operations** carry the `admin` tag and declare 403, which Users get (FR-AUTH-2). They cover AI access for each user and the model-provider allow-list (FR-AUTH-3, SEC-11).
- **Scope** (`userId`, `accountId`, `allowedCaseIds`) is resolved by `apps/api` and applied by `services/ai` inside SQL (FR-CASE-6).

## Generate

```bash
pnpm gen:contracts     # openapi/api.v1.yaml → generated/api.v1.ts (openapi-typescript)
```

- Run it after every change to `api.v1.yaml` and commit the result. CI regenerates and fails if `generated/` is stale.
- Consumers import types only: `import type { paths, components } from "@caseguard/contracts/api.v1"`. `apps/web` wraps them in an `openapi-fetch` client (`src/lib/api.ts`).

## Lint

```bash
npx @redocly/cli lint packages/contracts/openapi/*.yaml     # config: /redocly.yaml, /.redocly.lint-ignore.yaml
```

## Status

`1.0.0-draft` covers the M1 vertical slice: auth (including password reset), the user's own settings (`/me/settings`: name, language, theme), conversations, asking a question, an answer with verified citations, and fetching a citation or source. M3 adds cases (`/cases`: the fields of Deliverable II Table 4.29, archive and unarchive) and saving a conversation to a case (`PATCH /conversations/{conversationId}`, a `caseId` filter on the list), and documents (`POST /cases/{caseId}/documents`, `/documents`: upload, status, flags, download, delete, retry) with the ingestion handoff in ai.v1 (`/ai/v1/documents/{documentId}/ingestion`: apps/api submits and polls, [ADR-0010](../../docs/adr/0010-document-ingestion-handoff.md)). TypeScript types for `api.v1` are generated and used by `apps/web` (#79). Types for `ai.v1` and the Python models come with their first consumers.
