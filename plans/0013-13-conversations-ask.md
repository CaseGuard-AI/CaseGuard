> **Status:** Done · **Issue:** [#13](https://github.com/CaseGuard-AI/CaseGuard/issues/13) · **PR:** [#69](https://github.com/CaseGuard-AI/CaseGuard/pull/69)

# #13: conversations and the ask route (API)

## Context
This issue implements `/conversations*` from api.v1. On ask, the API resolves the scope, calls ai.v1 `research/answer` with the service token, stores the messages and writes the audit record (PRD §13.3). It returns 403 when AI is disabled for the user (FR-AUTH-3, via `requireAiEnabled` from #55).

`services/ai` only serves `/info` so far, because `research/answer` is #20. So this is built and tested against the ai.v1 contract with a fake AI client. Until #20 lands, asking in the real stack returns 503, as the contract allows.

Requirements: FR-RES-6, FR-RES-8, FR-RES-9, FR-RES-11, FR-AUTH-3, FR-AUTH-4, FR-CASE-6, FR-TRUST-12, SEC-15.

**Decisions (owner):**
- **The audit record is split and joined by `requestId`.** `apps/api` writes its part to `app.ai_audit_records`. `services/ai` writes the model, provider, chunks, graph context, guardrails and translated query under the same `requestId` in its own schema (#20). No contract change is needed.
- **A failed AI call stores nothing except the audit entry.** The question and the answer are saved together, and only on success, so the history never holds an unanswered question. The failure is still audited with `outcome = 'error'`.

Branch `feature/api-conversations` off `staging`. PR title: `feat(api): conversations and the ask route with audit records`.

## Changes
1. **Migration `0004_conversations`** (plus a hand-written `.down.sql`):
   - `app.conversations`: `id`, `owner_user_id`, `account_id` (FR-AUTH-5), `title`, `case_id` (nullable, no FK until cases arrive in P1), `created_at`, `updated_at`. Indexed on `(owner_user_id, updated_at)`.
   - `app.messages`: `id`, a `seq` identity column (for stable order), `conversation_id` (cascade), `owner_user_id`, `account_id`, `role`, `text`, `language`, `answerable`, `citations jsonb` (with their verifications), `created_at`.
   - `app.ai_audit_records`: keyed by `request_id`.
     - Columns: `owner_user_id`, `account_id`, `conversation_id` (set null on delete), `case_id`, `question`, `language`, `law_as_of`, `outcome` (`answered`, `unanswerable` or `error`), `response_text`, `answer_language`, `citations jsonb`, `error`, `latency_ms`, `created_at`.
     - It's **append-only**: a `BEFORE UPDATE` trigger raises an error (§13.3).
2. **`src/clients/ai.ts`**: adds `answer(req)`, which POSTs `/ai/v1/research/answer` with the bearer token and a 120 s timeout. The `AnswerRequest` and `Answer` types come from ai.v1.
3. **`src/conversations/store.ts`**:
   - `listConversations`: newest first by `(updated_at, id)`, using the id cursor pattern from `src/admin/store.ts`.
   - `createConversation`.
   - `getConversation`: owner only, otherwise `undefined`, which becomes 404 (FR-AUTH-4).
   - `recentTurns`: up to 20 turns, oldest first.
   - `saveExchange`: in one transaction, inserts the user and assistant messages and the audit row, bumps `updated_at`, and sets a default title from the first question.
   - `auditFailure`.
4. **`src/routes/conversations.ts`**, behind `requireAuth`:
   - `GET /conversations`: `cursor` and `limit`.
   - `POST /conversations`: takes `title` (up to 200 characters). `caseId` gives 400 until cases exist (P1).
   - `GET /conversations/{id}`: the conversation and its messages, or 404.
   - `POST /conversations/{id}/messages`, which also requires `requireAiEnabled` and the `aiLimiter` (30 per user per 15 minutes, SEC-15):
     1. Validate the `AskRequest`.
     2. Load the conversation, or return 404.
     3. Build the scope `{ userId, accountId, allowedCaseIds: [] }`. It's the public corpus only, because cases are P1 (FR-CASE-6).
     4. Call `ai.answer` with a new `requestId` and the history.
     5. **FR-RES-6:** reject the answer, with 503 and an audited error, unless the `requestId` matches and every citation has a `verification.status`.
     6. Save the exchange and the audit record together, and return 201 with the assistant `Message`.
     7. If the AI call fails, write the audit error and return 503.
5. **`src/middleware/rate-limit.ts`**: `aiLimiter()`, keyed by user id.
6. **Wiring**: mount `conversationsRouter({ db, jwtSecret, ai })` in `src/app.ts`.
7. **Tests** in `test/conversations.test.ts`, which needs `APP_TEST_DATABASE_URL` and uses a fake AI client:
   - Every response goes through `expectContract`.
   - **Create and list:**
     - Create gives 201, and `caseId` gives 400.
     - The list is newest first and pages correctly. After an ask, that conversation moves to the top.
   - **Ask:**
     - It returns 201 with the assistant message and its citations, and GET then shows both messages in order.
     - The AI gets the right scope (`allowedCaseIds: []`), its `requestId`, and the history of earlier turns.
     - The audit row records the question, the response, the citations, and the latency.
   - **Unanswerable:** gives 201 with `answerable: false` and no citations, and the audit outcome is `unanswerable`.
   - **Failures:**
     - AI down, a citation without a verification, or a `requestId` mismatch each give 503.
     - Nothing is stored in the conversation, and an audit row records `error`.
   - **Access:**
     - AI disabled gives 403 and no AI call is made.
     - Another user's conversation gives 404 on GET and on ask (FR-AUTH-4), and no token gives 401.
     - The 31st ask gives 429.
   - **Append-only:** an UPDATE on `ai_audit_records` fails.
   - `test/migrations.test.ts` adds `0004`.
8. **Docs**: `apps/api/README.md`, `CHANGELOG.md`.

## Not in this PR
- `GET /citations/{id}` and `GET /sources/{id}`. They're in api.v1, but no API issue covers them yet.
- The `services/ai` half of the audit (#20).
- Saving a conversation to a case (P1).

## Verification
- Lint and typecheck pass.
- `vitest` with temp Postgres and Mailpit passes with nothing skipped.
- CI is green.
