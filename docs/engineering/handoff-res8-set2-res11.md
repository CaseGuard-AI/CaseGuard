# Handoff: research history, user API keys, "law as of" date

> **Status:** Ready to pick up, written 2026-11-12. **Owner:** partner (Stream A plus one services/ai change). Three partially done FRs. The other half of the same plan (roles FR-AUTH-2, stale flag FR-TRUST-6, support check FR-TRUST-3/9) is being done in parallel by the repo lead.

All three items are **already half-built**. The API or contract side exists, and what's missing is listed below. None of them needs the corpus to be fully embedded, and none waits on Cases or uploads.

| Order | Item | FR | Issues | Size | Touches |
|---|---|---|---|---|---|
| 1 | Research history sidebar | FR-RES-8 | #86 | ~0.5 day | `apps/web` only |
| 2 | User API keys + model choice | FR-SET-2, SEC-4, SEC-11 | #92 → #93 → #94 → #95 | ~2 days | ADR, both contracts, `apps/api`, `services/ai`, `apps/web` |
| 3 | "Law as of" date | FR-RES-11 | #96 | ~0.5 day | `services/ai`, contracts, `apps/web` |

Usual workflow ([handoff.md §4](handoff.md#4-how-to-pick-up-an-issue)): assign yourself, branch `feature/<issue>-<slug>` off `staging`, write `plans/NNNN-<issue>-<slug>.md` (take the next free number), make one PR per item to `staging`, put the FR ID in the PR, and add a heading to [`work-log.md`](work-log.md). **Contract first:** edit `packages/contracts/openapi/*.yaml`, regenerate `packages/contracts/generated/api.v1.ts`, then code against it.

> **Disk:** on the lead's laptop, all caches and models live on `D:\dev-cache` and `D:\temp` (C is nearly full). If yours is similar, check `HF_HOME`, `UV_CACHE_DIR` and the pnpm `store-dir` before installing anything.

---

## 1. Research history sidebar (FR-RES-8, #86)

**Exists:** `GET /conversations` (newest first, cursor-paged, returns `ConversationSummary {id, title, caseId, createdAt, updatedAt}`; contract `api.v1.yaml` around line 216, route `apps/api/src/routes/conversations.ts`). The Research Hub already picks the conversation from `?c=<id>` (`apps/web/src/components/research/research-hub.tsx:21`), and a 404 resets to a fresh page.

**Missing:** any UI that lists past conversations.

**Do:**
1. In `components/research/queries.ts`, add `useConversations()`, a `useInfiniteQuery` over `api.GET("/conversations", { params: { query: { cursor, limit } } })` that follows `nextCursor`. After a successful ask, invalidate it in the existing `useAsk` so a new conversation appears at once.
2. Create `components/research/history-list.tsx`: titles newest first with a relative date, the current `?c=` highlighted, a "New question" button that does `router.replace("/research")`, "Load more" when `nextCursor` is set, and empty/loading/error states.
3. Mount it in `research-hub.tsx` as a side column on desktop and a drawer on mobile. Use logical properties (`ms-`, `me-`, `start-`) so RTL works.
4. Add strings under `Research` in `apps/web/messages/en.json` and `ur.json`. Urdu needs native review later (#105), so mark the new keys in the PR.

**Done when:** a user with several conversations sees them, clicks one and gets its thread back, and a new question shows up at the top without a reload. Add a component test in the same style as the existing ones.

**Not in scope:** "save to case" (the other half of FR-RES-8), which waits for Cases (#97–#99).

---

## 2. User API keys + model choice (FR-SET-2)

**Exists:**
- An Admin provider allow-list (`GET`/`PATCH /admin/providers`, `apps/api/src/admin/store.ts`). apps/api resolves it into `allowedProviders` on every `AnswerRequest`, and services/ai never widens it (`ai.v1.yaml`, `AnswerRequest.allowedProviders`).
- services/ai has a provider abstraction: `ProviderConfig(id, base_url, model, api_key)` in `services/ai/src/caseguard_ai/gateway/providers.py`, chosen by `select(settings, role, allowed_providers)` from **env** keys only.
- `/me/settings` stores name, locale and theme (`apps/api/src/routes/settings.ts`, `settings/store.ts`, web `components/settings/`).

**Missing:** a per-user key store, the endpoints, a default model, a way to send a user's key to services/ai, and the settings UI.

**Do, in this order (one PR each):**

**2a. ADR (#92)**: `docs/adr/0009-user-api-keys.md` from `0000-template.md`. Recommended: **option (a)** from [stream-a-roadmap §5](stream-a-roadmap.md#5-decisions-needed).
- apps/api alone stores keys, encrypted with AES-256-GCM under `KEY_ENCRYPTION_KEY` (32 bytes, base64, in `.env`, validated in `apps/api/src/config/env.ts`).
- For each request it decrypts the key and sends it in the `AnswerRequest` over the internal network.
- Both services redact it from logs.
- A key can only be used for a provider that is on the Admin allow-list.

**2b. Contracts (#93)**:
- `api.v1.yaml`:
  - `GET /me/keys` returns `[{providerId, last4, createdAt}]` and never the key.
  - `PUT /me/keys/{providerId}` takes `{apiKey}`.
  - `DELETE /me/keys/{providerId}`.
  - `GET /models` lists the enabled providers and their models.
  - Add `defaultModel: {providerId, model} | null` to the settings schema.
- `ai.v1.yaml` `AnswerRequest`: optional `credential: {providerId, model, apiKey}`. Document that it's rejected unless `providerId` is in `allowedProviders`.

**2c. API (#94)**:
- Migration `apps/api/drizzle/00NN_user_api_keys.sql` + `.down.sql` (next free number; the lead's roles migration takes 0008). Table `app.user_api_keys`: `user_id` FK with cascade, `provider_id`, `ciphertext`, `iv`, `auth_tag`, `last4`, `created_at`, `updated_at`, unique `(user_id, provider_id)`. Mirror it in `apps/api/src/db/schema.ts`.
- `apps/api/src/keys/crypto.ts`: `encrypt` and `decrypt` with Node `crypto` `aes-256-gcm` and a random 12-byte IV per write. `keys/store.ts`, `routes/keys.ts` (behind `requireAuth`), mounted in `app.ts`.
- `routes/conversations.ts`, ask route around line 107: if the user has a `defaultModel` and a key for it, and the provider is allowed, decrypt it and add `credential` to the AI call (`apps/api/src/clients/ai.ts`). The audit record stores the provider and model, **never the key**.
- `lib/logger.ts`: add redact paths for `req.body.apiKey` and `*.credential.apiKey`.

**2d. services/ai**:
- `api/v1.py`: add `CredentialIn` (extra=forbid) to `AnswerRequest`. Reject it with 400 if `providerId` is not in `allowedProviders`. Build a `ProviderConfig` from the provider's preset base URL (`gateway/providers.py`) and pass it through `Question` to the gateway as an override for the generation role. With no `credential`, nothing changes.
- Make sure the key is never logged (`ProviderConfig.api_key` already has `repr=False`). Add a test that captures logs and asserts the key string is absent.

**2e. Web (#95)**: a "Models & keys" section in `components/settings/` (next to `account-preferences.tsx`). For each enabled provider: add/replace/delete a key, show `••••last4`, and a default-model select fed by `GET /models`. Add en/ur strings.

**Done when:**
- The API never returns a key (only `last4`), and the stored row is ciphertext.
- Grepping the test-run logs of both services for a test key finds nothing.
- A question asked with a user key goes to that provider, and its audit row shows the provider and model.
- A key for a provider that isn't allow-listed is refused (403 in the API, 400 in services/ai).

---

## 3. "Law as of" date (FR-RES-11, #96)

**Exists:** `lawAsOf` is accepted on ask (`routes/conversations.ts:37`), stored in the audit record (`schema.ts`, `law_as_of`), sent to services/ai (`clients/ai.ts:22`) and accepted by `AnswerRequest` (`services/ai/.../api/v1.py:52`). **But `research_answer` never passes it into `Question`, so it's ignored.**

**Missing:** using it, and a UI control. There are **no curated statute versions yet** (FR-TEMP-* is a later module), so the honest scope is:

**Do:**
1. **services/ai**: pass `lawAsOf` into `Question` (`research/answer.py`) and on to `retrieve()` (`retrieval/hybrid.py`).
   - Filter **inside** the `_DENSE` and `_SPARSE` SQL (join `corpus.documents d` and add `AND (d.kind <> 'judgment' OR d.decided_on IS NULL OR d.decided_on <= :as_of)` when a date is given). Filtering after `LIMIT :k` would silently return fewer passages.
   - Judgments with an unknown `decided_on` stay in. Statutes stay in, unversioned.
2. **Contracts**: add an optional `asOfNote: string` to ai.v1 `Answer` and to the api.v1 assistant `Message`. When `lawAsOf` is set, the note says that judgments after D were excluded and that statute text is the current version, because historical versions aren't curated yet. Store it with the message in apps/api.
3. **Web**: an optional date input in `components/research/ask-box.tsx` (default empty, max today), sent as `lawAsOf` by `useAsk`. Show the date and `asOfNote` in `answer-card.tsx`. Add en/ur strings.

**Done when:** a retrieval test with a judgment decided after D shows it excluded and one decided before D kept. With no date, results are identical to today. The UI shows the note whenever a date was used.

**Coordinate:** the lead's stale-flag PR (FR-TRUST-6) also edits `retrieval/hybrid.py` (`Passage` and `_CORPUS_PASSAGES`, adding `retrieved_at`). Rebase on whichever merges first. The two changes don't overlap logically.

---

## Testing (every PR)

- JS: `pnpm -r lint test`, plus the contract lint (`redocly`).
- services/ai: `uv run pytest` in `services/ai` with `AI_TEST_DATABASE_URL` pointing at a bootstrapped **scratch** database on `127.0.0.1` (not `localhost`; on Windows Python stalls on IPv6). See `services/ai/README.md`.
- By hand: `pnpm stack:up`, enable a provider in the admin console, and check the item in the Research Hub or Settings.

Gotchas are in [handoff.md §5](handoff.md#5-gotchas) and [session-handoff.md](session-handoff.md#how-to-work-here-gotchas), especially: write code with editor tools rather than shell heredocs on Windows, and never delete merged branches.
