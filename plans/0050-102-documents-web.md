> **Status:** In progress · **Issue:** [#102](https://github.com/CaseGuard-AI/CaseGuard/issues/102) · **PR:** —

# #102: Documents page with processing status (web)

## Context

The documents contract (#100, PR #197) is merged. `api.v1.yaml` has `uploadDocument` (`POST /cases/{caseId}/documents`), `listDocuments` (`GET /documents?caseId=`), `getDocument`, `deleteDocument` (202), `downloadDocument` (`GET /documents/{documentId}/file`) and `retryDocument` (202, 409 unless `failed` or `flagged`). The types are already generated in `packages/contracts/generated/api.v1.ts`.

The API side (#101) is being built at the same time, on its own branch. This PR builds against the contract only, and its tests stub `fetch` the way `test/cases.test.tsx` does. A check against the real API comes once #101 merges.

This is the third step of roadmap item A8 (contract → API → **web**). The issue asks to replace `ComingSoon` at `/documents`, with:

- upload with client-side type and size checks
- a status per document
- flagged OCR or extraction never shown as clean (FR-DOC-4)

The PR stays inside `apps/web`. In `messages/en.json` and `ur.json` it adds only a top-level `Documents` namespace and drops the `Cases.dashboard.documents` placeholder. #103 (notifications) is also running in parallel and edits the header and a `Notifications` namespace.

**Requirements:** FR-DOC-1, FR-DOC-3, FR-DOC-4 (and FR-CASE-4: the case dashboard lists its documents).

## Decisions

- **`components/documents/queries.ts`:**
  - Keys: `documentsKey = ["documents"]`, `documentsListKey(caseId?)`.
  - `useDocuments(caseId?)` is a `useInfiniteQuery` over `listDocuments` (PAGE 20).
  - The list polls every 3 s (`refetchInterval`) while any loaded document is `queued` or `processing`, and stops once all are terminal.
  - Upload, delete and retry invalidate `documentsKey`.
- **Upload:**
  - `api.POST("/cases/{caseId}/documents")` with a `FormData` from `bodySerializer`; openapi-fetch leaves the multipart boundary to the browser.
  - A drop zone plus a file picker (a hidden `<input type=file>` with an accept list).
  - The client-side check (`validate.ts`) mirrors the contract: PDF, DOCX, PNG, JPEG or TIFF by MIME type, falling back to the extension when the browser gives no type, and at most 26 214 400 bytes.
  - The check is advisory, because the server sniffs the content. The server's 413, 415 and 400 (archived case) answers are shown inline too.
- **`DocumentStatusBadge`** (modelled on `trust-badge.tsx`):
  - `done` uses the success tokens.
  - `flagged` uses warning and always shows the flag count.
  - `failed` uses danger.
  - `queued` and `processing` are neutral with a spinner.
  - A flagged document also lists its flags (stage, page, message), and a failed one shows its `error`. Flagged never shares the done style (FR-DOC-4). A document that is being retried after a flag still shows its flags.
- **Download:** the API authenticates with a bearer token, so a plain `<a href>` can't be used. The file is fetched through `api` with `parseAs: "blob"`, then saved from an object URL with the stored filename.
- **Delete:** asks first, in an `AlertDialog` (as archiving a case does). **Retry:** shown only for `failed` and `flagged`.
- **`/documents`:** `PageIntro` and `<DocumentsList/>` showing all of the user's documents, each with its case as a link. Uploading happens on the case dashboard, because a document always belongs to a case.
- **Case dashboard:** the documents placeholder becomes `<CaseDocuments caseId archived>`, with the uploader and the case's list. The uploader is hidden when the case is archived (the API rejects uploads there).
- **Strings:** en/ur in `Documents`. Logical CSS classes only.

## Changes

1. **`apps/web/src/components/documents/`**:
   - `queries.ts`
   - `validate.ts`
   - `status-badge.tsx`
   - `documents-list.tsx`
   - `uploader.tsx`
   - `case-documents.tsx`
2. **`apps/web/src/app/[locale]/(app)/documents/page.tsx`**: the real page.
3. **`apps/web/src/components/cases/case-dashboard.tsx`**: `CaseDocuments` replaces the documents placeholder.
4. **`apps/web/messages/en.json`, `ur.json`**: the `Documents` namespace; `Cases.dashboard.documents` removed.
5. **Tests:** `apps/web/test/documents.test.tsx`; `cases.test.tsx` updated for the dashboard card.
6. **Docs:** `CHANGELOG.md`, `docs/engineering/work-log.md`, the roadmap A8 note; this plan.

## Verification

- Lint, typecheck, test and build all pass:
  - `pnpm --filter @caseguard/web run lint`
  - `pnpm --filter @caseguard/web run typecheck`
  - `pnpm --filter @caseguard/web run test`
  - `pnpm --filter @caseguard/web run build`
- The tests cover:
  - the client check rejecting a bad type and an oversize file
  - multipart upload to the right path
  - each status, with flagged showing its flags and never the done style
  - polling stopping once the status is terminal
  - delete after confirmation, retry, download
  - the uploader hidden for an archived case
  - the 413 and 415 messages
  - the i18n and RTL tests
- Push, open the PR against `staging`, wait for `ci-ok`. Merging needs the user's explicit go-ahead (`--squash`, never `--delete-branch`).
