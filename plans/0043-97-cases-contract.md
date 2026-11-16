> **Status:** Done · **Issue:** [#97](https://github.com/CaseGuard-AI/CaseGuard/issues/97) · **PR:** [#194](https://github.com/CaseGuard-AI/CaseGuard/pull/194)

# #97: cases in the api.v1 contract

## Context

FR-CASE-1 (P1) asks for create, edit, list and archive of cases with the fields of Deliverable II Table 4.29; FR-CASE-4 for a dashboard that links a case's research, documents, drafts and precedents; FR-CASE-5 for saving research (and later drafts and lint reports) to a case. api.v1 has no `cases` today. `caseId` already exists on `ConversationSummary` and in the `createConversation` body, and the API rejects it with 400 (`apps/api/src/routes/conversations.ts`) "until cases exist". `app.conversations.case_id` is a nullable uuid without a FK (`apps/api/src/db/schema.ts`).

This is item A7 of [`docs/engineering/stream-a-roadmap.md`](../docs/engineering/stream-a-roadmap.md): #97 (this contract) → #98 (API + `caseId` scope on ask) → #99 (web list and dashboard). Under `packages/contracts/README.md`, a contract change is its own PR, reviewed by the producer and consumer. As with #88 and #93, this PR changes only the contract, the generated types and the docs.

Table 4.29 is only in `docs/deliverables/CaseGuard_AI_Deliverable_II_Report.docx` (§4.9.1). Its fields: case ID, title, court, case number, case type, filing date, current status, next hearing date, parties (plaintiff or petitioner; defendant or respondent), judge or bench, assigned lawyer, relevant laws and sections, description, case documents, related precedents, case strategy, opponent claims, and the timestamps. "No additional mandatory fields are assumed."

**Requirements:** FR-CASE-1, FR-CASE-4, FR-CASE-5 (and FR-AUTH-4: the caller's own cases only).

## Decisions

**Owner (2026-11-17):**
- **`caseType` is free text now.** The taxonomy (#164: proceeding type + area of law) is still a proposal. `proceedingType` and `area` enums are added additively once `case-taxonomy.v1.yaml` lands.
- **All editable Table 4.29 fields go in now.** Documents, precedents, strategy and opponent claims are linked resources from later issues (#100–#103, #106–#108, P2 modules), not case fields. They link to a case by `caseId` in their own contracts.

**From the PRD and the existing contract:**
- **One owner per case** (PRD §3 "individual accounts only"; FR-AUTH-4). No owner or account fields in the contract; `apps/api` stores `owner_user_id` and `account_id` (FR-AUTH-5). Another user's case is a 404, like conversations.
- **Archive, not delete.** `archivedAt: date-time | null` on the case; `POST /cases/{caseId}/archive` and `POST /cases/{caseId}/unarchive` are idempotent and return the updated `Case`. There is no `DELETE /cases/{caseId}` (`data-storage.md` §6: archiving keeps files). The list hides archived cases unless asked (`state=archived|all`). An archived case can still be edited, but no new conversation can be saved to it.
- **`status` is the court status of the matter** (Table 4.29 "Current status", e.g. "Reserved for judgment"), free text like `caseType`. It is separate from archiving, which is the user's housekeeping.
- **Parties are a list**, not two strings: `Party { side: claimant | respondent, name, label? }`. `label` is what the court calls the party ("Petitioner", "Accused"); `side` keeps the two-column view of the dashboard and later templates. Multi-party suits and appeals are common.
- **Dates are `format: date`** (filing, next hearing), as `AskRequest.lawAsOf` already is. Timestamps stay `date-time`.
- **PATCH is partial**, `minProperties: 1`, `additionalProperties: false`, `null` clears a nullable field and `[]` clears a list, matching `UserSettingsUpdate` and `defaultModel`. The field bounds are the validation rules (Deliverable II TBD-24), so #98 and #99 validate the same way.
- **One `Case` shape for the list and the detail.** A `CaseSummary` was considered and dropped: it would duplicate six field definitions and a page of 20 cases is small.
- **The field list is written once, as a YAML anchor** (`&caseFields` inside `Case`, reused by `CaseInput` and `CaseUpdate`). The first attempt, a shared `CaseFields` schema under `allOf`, lost `required` in the generated types (every `Case` field came out optional) and `additionalProperties: false` cannot see through `allOf`; `unevaluatedProperties: false` is valid OpenAPI 3.1 but openapi-typescript renders it as `Record<string, never>`, which makes the input types unusable. Anchors are resolved by Redocly, openapi-typescript and the api's `json-schema-ref-parser`, so every consumer sees three plain object schemas.
- **FR-CASE-5 (save research to a case)** is `PATCH /conversations/{conversationId}` with `{ caseId: uuid | null }` (`updateConversation`, new). Attaching sets the case; `null` detaches. A `caseId` that is not the caller's active case is a 400 with `errors[{path: "caseId"}]`, the same shape the API gives today, not a 404 (the path resource exists; the reference is invalid). The same rule is written on `createConversation.caseId`, replacing "P1. …".
- **FR-CASE-4 (dashboard links)** in this PR is `listConversations?caseId=` (research for one case; a case that is not the caller's gives an empty page). Documents, drafts and precedents arrive with their own contracts and add `caseId` filters the same way. `Case` carries no counts or embedded lists; those would be additive later if #99 needs them.
- **`ConversationSummary` doesn't change** (its `caseId` stays nullable and required-as-present). A required change there would break `apps/api/test/conversations.test.ts` before #98.
- **Additive, no `!`, no version bump.**

Branch: `feature/contracts-cases` off `staging`. PR title: `feat(contracts): cases in api.v1 (FR-CASE-1, FR-CASE-4, FR-CASE-5)`.

## Changes

1. **`packages/contracts/openapi/api.v1.yaml`**
   - Tag `cases`; an M3 line in the info description.
   - Parameters `CaseId` (path), `CaseState` (`state`: `active` default, `archived`, `all`), `ConversationCaseId` (`caseId` query filter).
   - Paths: `GET /cases` (`listCases`, cursor page of `Case`, `updatedAt` desc), `POST /cases` (`createCase`, 201), `GET /cases/{caseId}` (`getCase`), `PATCH /cases/{caseId}` (`updateCase`), `POST /cases/{caseId}/archive` (`archiveCase`), `POST /cases/{caseId}/unarchive` (`unarchiveCase`); `listConversations` takes `caseId`; `createConversation.caseId` is documented for real; `PATCH /conversations/{conversationId}` (`updateConversation`).
   - Schemas: `Party`, `Case`, `CaseInput`, `CaseUpdate`, `ConversationUpdate`. Field bounds: `title` 1–200, `court` ≤ 120, `caseNumber` ≤ 80, `caseType` ≤ 80, `status` ≤ 80, `judge` ≤ 200, `assignedLawyer` ≤ 120, `summary` ≤ 4000, `parties` ≤ 50 of `Party` (`name` 1–200, `label` ≤ 40), `relevantLaws` ≤ 50 strings of 1–120.
2. **`packages/contracts/generated/api.v1.ts`**: regenerated with `pnpm gen:contracts`. Never edited by hand.
3. **`packages/contracts/README.md`**: the Status line mentions cases and saving a conversation to a case.
4. **`CHANGELOG.md`**: an Added entry under Unreleased.
5. **`docs/engineering/stream-a-roadmap.md`**: no change. Its "Done" table tracks whole items, so A7 moves there with #98 and #99. The A7 note "The API rejects `caseId` with 400 until cases exist" stays true until #98.
6. This plan.

## Left for the implementation PRs

- **#98 (API):** `app.cases` table (`owner_user_id`, `account_id`, the fields, `archived_at`, index `(owner_user_id, updated_at)`), migration with `.down.sql`, FK `conversations.case_id → cases.id` (and `ai_audit_records.case_id`), zod schemas mirroring `CaseInput` and `CaseUpdate` (`z.strictObject`, as `settings.ts` does), routes, `expectContract` tests, `updateConversation`, the `caseId` filter, replacing the 400 in `conversations.ts` with the ownership and archived checks, `allowedCaseIds: [caseId]` in the scope, the marker-document isolation test (SEC-8), and the `sources.ts` case-scope limit.
- **#99 (web):** list, create/edit/archive forms, dashboard; `useCases` queries like `components/research/queries.ts`; i18n strings; the ask box's case picker.
- **#164 taxonomy:** `proceedingType` and `area` on the case fields once `case-taxonomy.v1.yaml` exists.

## Verification

- `npx @redocly/cli lint packages/contracts/openapi/*.yaml` passes (config `/redocly.yaml`).
- `pnpm gen:contracts` leaves no diff after the commit (the CI `contracts` job's staleness check).
- `pnpm --filter ./apps/web run typecheck` and `pnpm --filter ./apps/api run typecheck` still pass (additive types).
- In the generated `api.v1.ts`: `paths["/cases"]`, `operations["updateConversation"]` and `components["schemas"]["Case"]` exist; `Case` has all 12 editable fields required plus `id`, `createdAt`, `updatedAt`, `archivedAt`; `CaseInput` has only `title` required.
- CI `ci-ok` is green, including the `contracts` job.
