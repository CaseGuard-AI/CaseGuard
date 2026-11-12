> **Status:** In progress · **Issue:** [#92](https://github.com/CaseGuard-AI/CaseGuard/issues/92) (also #93, #94, #95)

# #92: user API keys and model choice (FR-SET-2)

## Context

FR-SET-2 lets a user bring their own key for a cloud model provider and pick a default model. The Admin allow-list (`/admin/providers`) and the services/ai provider abstraction (`gateway/providers.py`) exist, but keys come only from services/ai's env, and there is no per-user store, endpoint, default model or settings UI. The plan follows [handoff-res8-set2-res11 §2](../docs/engineering/handoff-res8-set2-res11.md#2-user-api-keys--model-choice-fr-set-2) and [stream-a-roadmap §5](../docs/engineering/stream-a-roadmap.md#5-decisions-needed), option (a). One PR per step, contract first.

## Decisions

- **Option (a), recorded in [ADR-0009](../docs/adr/0009-user-api-keys.md).** apps/api alone stores keys (SEC-4), encrypted with AES-256-GCM under `KEY_ENCRYPTION_KEY`, and sends the decrypted key per request in `AnswerRequest.credential`. services/ai never stores it, and the "never widen `allowedProviders`" rule still holds (SEC-11).
- **Only enabled cloud providers take a key.** Disabled or local (`ollama`) → 403 in the api, 400 in services/ai.
- **The API never returns a key**, only `last4`. `apiKey` is `writeOnly`.
- **A credential overrides the generation role only.** The judge role keeps the env configuration.
- **No new `Answer` fields.** apps/api already knows which provider and model it chose, and writes them to the audit row.
- **Key rotation is deferred** (ADR-0009 consequences).

## Steps

### 2a. ADR (#92)
- `docs/adr/0009-user-api-keys.md`; this plan.

### 2b. Contracts (#93), stacked on 2a
- `api.v1.yaml`:
  - `GET /me/keys` → `[UserKey {providerId, last4, createdAt, updatedAt}]`;
  - `PUT /me/keys/{providerId}` with `UserKeyInput {apiKey}` → `UserKey`, 403 if not enabled or local;
  - `DELETE /me/keys/{providerId}` → 204, 404 if no key;
  - `GET /models` → `[ProviderModels {providerId, name, kind, models, hasKey}]` for enabled providers;
  - `UserSettings.defaultModel: DefaultModel | null` (required), optional in `UserSettingsUpdate`; PATCH 400 if the model isn't offered, 403 if the provider isn't enabled.
- `ai.v1.yaml`: optional `AnswerRequest.credential: Credential {providerId, model, apiKey}`.
- `pnpm gen:contracts`, Redocly lint, `pnpm -r typecheck`.
- Making `defaultModel` required breaks the DB-backed `/me/settings` contract checks in `apps/api/test/settings.test.ts` until 2c returns it; 2c fixes them.

### 2c. API (#94)
- Migration `apps/api/drizzle/0010_user_api_keys.sql` + `.down.sql`: `app.user_api_keys` (`user_id` FK cascade, `provider_id`, `ciphertext`, `iv`, `auth_tag`, `last4`, `created_at`, `updated_at`, unique `(user_id, provider_id)`), and nullable `default_provider_id` / `default_model` columns on `app.users` (next to `theme`; both set or both null). The lead's roles migration takes 0008; 0009 is left for whichever lands next. Mirror in `src/db/schema.ts`.
- `KEY_ENCRYPTION_KEY` in `config/env.ts` (base64, exactly 32 bytes), `.env.example`, compose and CI.
- `src/keys/crypto.ts` (`encrypt`/`decrypt`, `aes-256-gcm`, random 12-byte IV per write), `keys/store.ts`, `routes/keys.ts` and `routes/models.ts` behind `requireAuth`, mounted in `app.ts`.
- `/me/settings`: `defaultModel` read and write, with the 400/403 checks.
- Ask route (`routes/conversations.ts`): with a `defaultModel`, a key for it and the provider allowed, decrypt and send `credential` (`clients/ai.ts`). The audit row stores provider and model, never the key.
- `lib/logger.ts`: redact `req.body.apiKey` and `*.credential.apiKey`.
- Tests: contract tests for every new route, ciphertext-at-rest, never-returned key, 403 for disabled/local, and a log capture with no test key.

### 2d. services/ai
- `api/v1.py`: `CredentialIn` (extra=forbid) on `AnswerRequest`; 400 unless `providerId` is in `allowedProviders` and is a known cloud preset.
- Build a `ProviderConfig` from the preset base URL and pass it through `Question` to the gateway as the generation-role override. No credential → unchanged.
- Test: logs captured during a credentialed request don't contain the key.

### 2e. Web (#95)
- "Models & keys" section in `components/settings/`, next to `account-preferences.tsx`: per enabled provider add/replace/delete a key, show `••••last4`, and a default-model select fed by `GET /models`. en/ur strings (Urdu marked for review, #105). Component tests.

## Done when

- The API never returns a key (only `last4`), and the stored row is ciphertext.
- Grepping both services' test-run logs for a test key finds nothing.
- A question asked with a user key goes to that provider, and its audit row shows the provider and model.
- A key for a provider that isn't allow-listed is refused (403 in the api, 400 in services/ai).
