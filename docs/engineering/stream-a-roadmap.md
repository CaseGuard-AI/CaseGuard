# Stream A roadmap: what's done and what's left

> **Status:** Living document, updated 2026-11-09 · **Owner:** Stream A (`apps/web`, `apps/api`) · Source of scope: [PRD §16.1](../PRD.md#161-workstreams)

The GitHub issues labelled `stream:A` are almost all closed. Only #83 and #86 are still open. **But the PRD gives Stream A more than those issues cover:** "`apps/web` (… all screens), `apps/api` (auth, roles, cases, documents, uploads, settings, keys, notifications, audit writes, jobs)". This page compares that scope with what is merged and puts the rest in order. Each item has one or more issues (§4), and each issue gets one plan (`plans/NNNN-<issue#>-<slug>.md`), and a dependency gets its own issue first, as usual.

## 1. Done (merged to `staging`)

| Area | Issues | Requirements |
|---|---|---|
| Auth API: register, login, refresh with reuse detection, logout, me, `requireRole` | #10 | FR-AUTH-1, FR-AUTH-2, SEC-1, SEC-2, SEC-15 (auth) |
| The PRD's three roles: Lawyer, Researcher and Administrator. Migration `0008` renames `user` to `lawyer`; register offers Lawyer or Researcher, and `admin` is a 400 (only the CLI makes admins); the admin console shows each user's role | — (branch `feature/fr-auth-2-roles`, PR pending) | FR-AUTH-2 |
| Password reset (API and email) | #53, #61 | FR-AUTH-1 |
| Admin bootstrap CLI, per-user AI toggle and provider allow-list (API) | #54, #55, #75, plus the allow-list contract under #21 (plan 0015) | FR-AUTH-3, SEC-11 (allow-list) |
| `app` schema, ownership columns | #9 | FR-AUTH-4, FR-AUTH-5 |
| Conversations, the ask route and the audit record (API) | #13 | FR-RES-6, FR-RES-8 (API), FR-RES-11 (API), FR-TRUST-12, SEC-15 (AI) |
| Citation and source routes (API) | #70 | FR-RES-7, FR-TRUST-5, FR-TRUST-10 |
| Web shell, tokens, i18n/RTL, every route stubbed | #11 | FR-I18N-1, FR-LANG-2 |
| Typed client from api.v1 | #79 | — |
| Login, register, session, guard (web) | #12 | FR-AUTH-1 |
| Forgot and reset password (web) | #62 | FR-AUTH-1 |
| Research Hub answer view (web) | #14 | FR-RES-5, FR-RES-7, FR-RES-10, FR-TRUST-5, FR-TRUST-10 |
| Admin console: per-user AI access and the provider allow-list (web), item A4 | #91 | FR-AUTH-2, FR-AUTH-3, SEC-11 |
| User settings: name, language and theme (contract, API, web, dark tokens), item A2 | #88, #89, #90 | FR-SET-1, FR-I18N-1 |
| Refresh has its own rate limit (120 per IP per 15 minutes), item A1 | #83 | SEC-15 |

**Not blocked on Stream A, but it limits what's verifiable:** before #20 (services/ai `research/answer`, Stream C), every question gets 503. M1's definition of done ("Research Hub answers in English with citations") is met on Stream A's side, and the end-to-end demo waits for #20, #18, #19 and #16.

## 2. What's left

### P0: needed for M1/M2 and missing

| # | Item | Requirements | Exists today | Missing |
|---|---|---|---|---|
| A3 | **Default model, user API keys and model choice** | FR-SET-1 (model), FR-SET-2, SEC-4, SEC-11 | Admin provider allow-list | No key storage (AES-256-GCM), no key endpoints, no model list, and **ai.v1 has no field for the model or a user's credential.** This needs Stream C (#21). |
| A5 | **"Law as of date" in the ask box** | FR-RES-11 | The API passes `lawAsOf` through (#13) | No date control in the Research Hub. It only means something once temporal curation (Streams B and C, M2) exists. |

### P1: M3, "Thin P1"

| # | Item | Requirements | Notes |
|---|---|---|---|
| A6 | **Research history** | FR-RES-8 (UI) | Issue #86 |
| A7 | **Cases** (contract, API, web list and case dashboard), plus asking within a case | FR-CASE-1, FR-CASE-4, FR-CASE-5, FR-CASE-6 (case scope), FR-AUTH-4 | The API rejects `caseId` with 400 until cases exist. `/cases` is `ComingSoon`. |
| A8 | **Documents and uploads** (contract, storage, job queue, status, web) | FR-DOC-1, FR-DOC-2, FR-DOC-3, FR-DOC-4, FR-DOC-6, SEC-6, NFR-13 | Stream A owns uploads and jobs. OCR, chunking and embedding run in services/ai ingestion workers (Stream C), so the handoff needs a contract. Cut order: last of the P1s to be cut. |
| A9 | **Notifications** | FR-NOT-1 | Driven by A8's job events. |
| A10 | **Dashboard** | FR-DASH-1 | `/` is still a placeholder with a disabled ask box. It needs A6 and A7, and drafts once they exist. |
| A11 | **Urdu UI review** | FR-I18N-2 | Every string is translated, but none reviewed by a native speaker (flagged on #11, #12, #62 and #14, and the role names and register strings from FR-AUTH-2). This is a review task, not code. |
| A12 | **Screens over Stream C features**: precedent search (M3), drafting (M3), linter (M3) | FR-PREC-*, FR-DRAFT-*, FR-LINT-* | Each waits for its ai.v1 operations, which aren't in the contract yet. Cut order: drafting, then linter, then precedent UI. |

### P2 (M4)

| # | Item | Notes |
|---|---|---|
| A13 | Strategy, Stress-Test and Opponent Claims screens | They wait for Stream C's P2 modules. |
| A14 | Evaluation dashboard UI | It waits for the evaluation harness (#22, Stream C). |

### Unowned M3 items to assign

- **A deployed demo environment** (M3, NFR-2 TLS, NFR-10 "same images"). The PRD gives it no stream. Stream A owns the images, so this is a likely owner.
- **NFR-9: 10 concurrent users** (P1). A load test across web, api and ai.

## 3. Order of work

```text
P0 ─ now
  A3  ADR + contract (with Stream C, #21) → api keys → web settings "Models & keys"
  A5  "law as of" control (web)                            after temporal curation (M2)
P1 ─ M3
  A6  #86 research history
  A7  cases: contract → api → web, then FR-CASE-6 scope in ask
  A8  documents: contract (api ↔ ai ingestion) → api uploads/jobs → web
  A9  notifications (after A8)
  A10 dashboard (after A6, A7)
  A11 Urdu review (whenever a reviewer is available; release-blocking for M3 "Urdu UI")
  A12 precedent / drafting / linter screens, as their ai.v1 operations land
P2 ─ M4
  A13, A14
```

A4 (the admin console, #91), A2 (settings, #88 → #89 → #90) and A1 (the refresh rate limit, #83) are done. A3 (keys and models) waits on the ADR (#92) and Stream C (#21).

## 4. Issues (filed 2026-10-21)

Labels: `stream:A`, plus `area:*` and priority. "→" means "blocked by".

| Issue | Title | Labels | Blocked by |
|---|---|---|---|
| #88 | api.v1 contract: user settings (`GET`/`PATCH /me/settings`: name, locale, theme) | area:contracts, P0 | — |
| #89 | User settings API | area:api, P0 | settings contract |
| #90 | Settings page: profile, language, theme (dark tokens) (**done**) | area:web, P0 | settings API |
| #91 | Admin console: users (AI on/off) and provider allow-list (**done**) | area:web, P0 | — |
| #92 | ADR: how a user's key and model choice reach services/ai | area:docs, P0 | — (with Stream C) |
| #93 | api.v1 + ai.v1 contract: user API keys, model list, default model, `AnswerRequest` model and credential | area:contracts, P0 | ADR, #21 design |
| #94 | User API keys API: AES-256-GCM at rest, last-4 only, never logged | area:api, P0 | keys contract |
| #95 | Settings "Models & keys" tab | area:web, P0 | keys API |
| #96 | Research Hub: "law as of date" control | area:web, P0 | temporal curation (B/C) |
| #97 | api.v1 contract: cases | area:contracts, P1 | — |
| #98 | Cases API (+ `caseId` scope on ask) | area:api, P1 | cases contract |
| #99 | Cases list and case dashboard | area:web, P1 | cases API |
| #100 | Contracts: document upload and the ingestion handoff (api.v1 + ai.v1) | area:contracts, P1 | — (with Stream C) |
| #101 | Document uploads, storage and job queue (API) | area:api, P1 | documents contract |
| #102 | Documents page with processing status | area:web, P1 | documents API |
| #103 | Notifications for jobs | area:api + area:web, P1 | document jobs |
| #104 | Dashboard: recent research and cases | area:web, P1 | #86, cases |
| #105 | Urdu UI review by a native speaker | area:web, P1 | — |
| #106, #107, #108 | Precedent search, drafting and linter screens (one each) | area:web, P1 | their ai.v1 operations |

## 5. Decisions needed

1. **How do a user's key and model choice reach services/ai?** This is cross-stream and needs an ADR (CONTRIBUTING §7).
   - **(a)** apps/api decrypts the key and sends it per request in `AnswerRequest` over the internal network.
   - **(b)** services/ai reads an encrypted key store.

   (a) keeps one owner for keys (SEC-4) and fits "services/ai never widens" the provider list. Its risk is keys in internal request bodies, which have to be kept out of logs on both sides.
2. **Theme scope.** Is light/dark/system enough for FR-SET-1, and is dark mode part of M1/M2 or can it come later?
3. **Who owns the deployed demo environment and the NFR-9 load test.**
4. **A native Urdu reviewer.** A name and a date, since the M3 "Urdu UI" depends on it.
