> **Status:** Done · **Issue:** [#21](https://github.com/CaseGuard-AI/CaseGuard/issues/21) · **PR:** [#74](https://github.com/CaseGuard-AI/CaseGuard/pull/74)

# #21 (part 1): the provider allow-list in the ai.v1 contract

## Context
#55 (PR #66) gave Admins a model-provider allow-list in `app.providers`, with only Ollama enabled by default. Nothing enforces it yet. SEC-11 says case data goes only to providers an Admin enabled, or to a key the user supplied, but `services/ai` can't know which providers are enabled, because ai.v1's `AnswerRequest` doesn't carry them. #21 (the model gateway) is where the AI service will enforce it, so the contract comes first, in its own PR (`packages/contracts/README.md`).

Branch `feature/contracts-ai-provider-allowlist` off `staging`. PR title: `feat(contracts): pass the provider allow-list to services/ai`.

## Changes
1. **`ai.v1.yaml`**:
   - A new `ProviderId` schema, the same slug pattern as before. It moves from api.v1, because shared shapes are defined once in ai.v1.
   - `AnswerRequest.allowedProviders`: an optional `ProviderId[]` (`uniqueItems`, at most 32).
     - It's the Admin's allow-list as resolved by apps/api, and services/ai never widens it.
     - **If it's omitted, only local providers may be used**, so a caller that forgets it fails closed.
   - The `answerQuestion` description now says every model call goes only to allowed providers. If no allowed provider is configured for a role the pipeline needs, the answer is 503, never a fallback to another provider.
2. **`api.v1.yaml`**: `ProviderId` becomes a `$ref` to ai.v1. The name stays, so existing references keep working.
3. **`CHANGELOG.md`**: an "Added" entry.

## Decision: optional and fail-closed, not required
A required field would break the existing caller (`apps/api` since #69), and the contracts rules would then need a `!` and a path bump to `/ai/v2`. An optional field whose absence means "local only" is additive, and just as safe: leaving it out can never send data to a cloud provider.

## Left for the implementation PRs
- **apps/api:** the ask route sends the enabled ids from `app.providers`. That's a small follow-up, tracked separately.
- **services/ai** (#21): the gateway picks a provider per role, but only from `allowedProviders`, and returns 503 when none fits.
- **User-supplied keys** (FR-SET-2): they'll widen the list for that user only, which is a later contract change.

## Verification
- `npx @redocly/cli lint packages/contracts/openapi/*.yaml` passes.
- The api contract tests resolve the moved `ProviderId`. A spot check shows a bad slug is still rejected through the `$ref`.
- CI `contracts` and `api` jobs are green.
