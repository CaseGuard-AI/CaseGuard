> **Status:** In progress · **Issue:** [#55](https://github.com/CaseGuard-AI/CaseGuard/issues/55) · **PR:** #N

# #55 (part 1): admin AI-access endpoints in the api.v1 contract

## Context
FR-AUTH-3 says an Admin enables or disables AI features for each user and selects the enabled model providers. TBD-20 settled this as "per user, plus a provider allow-list". `api.v1.yaml` has no admin routes yet. The contracts rules say a contract change goes in its own PR, reviewed by the producer (`apps/api`) and the consumer (`apps/web`). This PR changes only the contract; the `apps/api` implementation comes later under #55.

Branch `feature/contracts-admin-ai-access` off `staging`. PR title: `feat(contracts): admin AI-access and provider allow-list endpoints in api.v1`. The change only adds things and breaks nothing, so there's no `!` and no version bump. The new paths sit at the end of `paths`, so the change doesn't conflict with #57 (password reset).

## Changes
1. `packages/contracts/openapi/api.v1.yaml`. A new `admin` tag. Every operation uses `bearerAuth` and declares 401 and 403; a User gets 403 (FR-AUTH-2).
   - `GET /admin/users` (`adminListUsers`): paged with the existing `Cursor` and `Limit` parameters. Returns `{ items: AdminUser[], nextCursor }`. `AdminUser` is `User` plus `createdAt`.
   - `PATCH /admin/users/{userId}` (`adminUpdateUser`): body `AdminUserUpdate { aiEnabled }`, returns 200 `AdminUser`, plus 400 and 404.
   - `GET /admin/providers` (`adminListProviders`): `{ items: Provider[] }`.
   - `PATCH /admin/providers/{providerId}` (`adminUpdateProvider`): body `ProviderUpdate { enabled }`, returns 200 `Provider`, plus 400 and 404.
   - The schemas:
     - `ProviderId` is a lowercase slug, such as `gemini` or `ollama`.
     - `Provider` has `{ id, name, kind: cloud|local, enabled }`. `local` marks providers that keep data on the machine (SEC-11).
     - Both update bodies set `additionalProperties: false`.
2. `packages/contracts/README.md`: a note on the `admin` tag.
3. `CHANGELOG.md`: an "Added" entry.

## Decisions
- **Where the provider list comes from.** The deployment's model configuration (ADR-0005) defines which providers exist. The API only switches them on or off, so it never creates or deletes providers or stores their keys.
- **Changing roles is out of scope.** `AdminUserUpdate` only has `aiEnabled`. Promoting a user to admin is #54.

## Left for the implementation PR (#55)
- Storing the allow-list in the `app` schema.
- Enforcing `aiEnabled` on AI routes; that part is shared with #13.
- Passing the enabled providers to `services/ai`. That needs an ai.v1 contract change (allowed providers in the research request), which belongs with #21, the model gateway.

## Verification
`npx @redocly/cli lint packages/contracts/openapi/*.yaml` passes, and so does the CI `contracts` job.
