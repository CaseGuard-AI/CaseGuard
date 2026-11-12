# ADR-0009: User API keys are stored by apps/api and sent per request to services/ai

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Stream A (apps/api, apps/web), Stream B (services/ai)
- **PRD refs:** FR-SET-2, SEC-4, SEC-11, ADR-0002, ADR-0005

## Context
FR-SET-2 lets a user bring their own API key for a cloud model provider and choose a default model. Today services/ai only uses keys from its own environment (`LLM_<ROLE>_*`, `gateway/providers.py`), and apps/api resolves the Admin's provider allow-list into `AnswerRequest.allowedProviders` on every call, which services/ai never widens (SEC-11).

A user's key is a secret that belongs to that user, so it needs one owner, encryption at rest and no path into logs or responses (SEC-4). Only apps/api knows who the user is (ADR-0002: services/ai has no user authentication), so only apps/api can decide which key a request may use. The question is how the key reaches the model gateway in services/ai ([stream-a-roadmap §5](../engineering/stream-a-roadmap.md#5-decisions-needed), option (a) or (b)).

## Decision
apps/api is the only store of user keys. It keeps them encrypted with AES-256-GCM, decrypts the one key a request needs, and sends it to services/ai inside that `AnswerRequest` over the internal network. services/ai uses it for that request only and never stores it.

- **Storage (apps/api).** Table `app.user_api_keys`, one row per `(user_id, provider_id)`: `ciphertext`, `iv`, `auth_tag`, `last4`, `created_at`, `updated_at`; the user FK cascades on delete.
  - Encryption: Node `crypto` `aes-256-gcm` under `KEY_ENCRYPTION_KEY`, a random 12-byte IV for every write, and the 16-byte auth tag stored and checked on decrypt.
  - `KEY_ENCRYPTION_KEY` is 32 bytes, base64-encoded, in `.env`. `apps/api/src/config/env.ts` validates it at start-up (it must decode to exactly 32 bytes), and the api refuses to start without a valid one.
  - The plaintext is never written anywhere. `last4` (the last four characters) is kept in clear for display.
- **API surface (api.v1).** `GET /me/keys`, `PUT /me/keys/{providerId}`, `DELETE /me/keys/{providerId}`, `GET /models`, and `defaultModel` in `/me/settings`. The API never returns a key, only `last4`; the input field `apiKey` is write-only.
- **Which providers.** A key can be saved or used only for a provider that is on the Admin allow-list (`app.providers.enabled`) and is a cloud provider. Local providers (`ollama`) are keyless, so a key for them is refused. apps/api answers 403 for both cases. If the Admin later disables a provider, the stored key stays but is not used until it is enabled again.
- **Per request (apps/api → services/ai).** On ask, if the user has a `defaultModel`, a key for its provider, and the provider is allowed, apps/api decrypts the key and adds `AnswerRequest.credential = {providerId, model, apiKey}` to the call. The call is authenticated with the service token (`AI_SERVICE_TOKEN`) and goes over the internal compose network only (SEC-14). Otherwise no `credential` is sent and behaviour is unchanged.
- **services/ai.** Accepts `credential` only if `providerId` is in `allowedProviders` and is a known cloud provider preset (`gateway/providers.py`); otherwise 400. It builds a `ProviderConfig` from that preset's base URL and overrides the **generation** role only, for this request only. Other roles keep the env configuration. The key is never logged, stored or put in the answer trace (`ProviderConfig.api_key` has `repr=False`).
- **Logs.** Both services redact the key: apps/api's pino logger redacts `req.body.apiKey` and `*.credential.apiKey`; services/ai never logs the request body or the provider config's key. Tests in both services capture logs and assert a test key is absent.
- **Audit.** The audit row records the provider and model used, never the key.

## Alternatives considered
| Option | Why not |
|---|---|
| (b) services/ai reads an encrypted key store itself | Two services hold key material and the decryption secret (against SEC-4's single owner). services/ai would need to know which user a request is for, which ADR-0002 keeps out of it, and it could pick a key for a provider the api did not allow, breaking "services/ai never widens" (SEC-11). |
| Store keys in plaintext, or hashed | Plaintext fails SEC-4 at rest. A hash can't be turned back into the key the provider needs. |
| Keep keys only in the browser and send them with each ask | The key would cross the public API on every question and live in browser storage, and it couldn't be used for later server-side jobs. More exposure, no gain. |
| An external secrets manager (Vault, cloud KMS) | Right for production, but adds an operated dependency and breaks the free-tier, desktop-ready constraints of ADR-0005 for an FYP prototype. The `KEY_ENCRYPTION_KEY` envelope can move into a KMS later without changing the contracts. |

## Consequences
- One owner for keys, and services/ai's rule "only `allowedProviders`, never wider" still holds: a credential is just one more input that must sit inside the allow-list.
- The plaintext key travels in internal request bodies, so redaction on both sides is mandatory and tested. Any new log line, error handler or trace that touches the request must keep it out.
- `KEY_ENCRYPTION_KEY` becomes a required secret: `.env.example`, compose and CI need a value, and losing it makes every stored key unreadable (users would re-enter them).
- **Key rotation is deferred.** Re-encrypting stored rows under a new `KEY_ENCRYPTION_KEY` (for example a key-version column and a one-off re-encrypt command) is a later concern; for now the encryption key is fixed per deployment.
- A user key overrides the generation role only. The judge and support-check roles keep the deployment's configuration until a later decision says otherwise.
- The desktop client (ADR-0005) is unaffected: a local model needs no key.
