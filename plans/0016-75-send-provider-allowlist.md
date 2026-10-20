> **Status:** In progress · **Issue:** [#75](https://github.com/CaseGuard-AI/CaseGuard/issues/75) · **PR:** [#76](https://github.com/CaseGuard-AI/CaseGuard/pull/76)

# #75: send the provider allow-list to services/ai on ask

## Context
ai.v1 now has `AnswerRequest.allowedProviders` (#74). Leaving it out means "local providers only". The Admin's allow-list lives in `app.providers` (#55), but the ask route (#69) doesn't send it yet, so every request falls back to local only. This PR sends the list explicitly and records it in the audit row. The AI service will enforce it in #21.

Branch `feature/api-send-provider-allowlist` off `staging`. PR title: `feat(api): send the provider allow-list with every question`.

## Changes
1. **`src/admin/store.ts`**: `enabledProviderIds(db)`, the ids of enabled providers, sorted.
2. **`src/clients/ai.ts`**: `AnswerRequest.allowedProviders?: string[]`.
3. **`src/routes/conversations.ts`**: on ask, read `enabledProviderIds`.
   - **If none are enabled**, return 503 ("No model provider is enabled. Ask an administrator.") without calling services/ai, and audit the error.
   - **Otherwise**, send `allowedProviders` explicitly, never by leaving it out.
4. **Migration `0006_audit_allowed_providers`**: `app.ai_audit_records.allowed_providers text[]`, nullable so older rows stay valid. It has a `.down.sql`. The append-only trigger is unchanged.
5. **`src/conversations/store.ts`**: `AskContext.allowedProviders`, written by both `saveExchange` and `auditFailure`.
6. **Tests** (`test/conversations.test.ts`):
   - By default the AI receives `["ollama"]`.
   - After enabling `gemini` it receives `["gemini", "ollama"]`, and after disabling `ollama` it receives `["gemini"]`.
   - With every provider disabled the route returns 503, the AI is never called, and the audit row records `error`.
   - The audit row records the list in effect.
   - Provider state is reset in `beforeEach`.
   - `test/migrations.test.ts` includes `0006`.
7. **Docs**: `apps/api/README.md` and `CHANGELOG.md`.

## Verification
- Lint and typecheck pass.
- `vitest` against temp Postgres and Mailpit passes with nothing skipped.
- CI is green.
