> **Status:** In progress · **Issue:** [#103](https://github.com/CaseGuard-AI/CaseGuard/issues/103) · **PR:** contract [#204](https://github.com/CaseGuard-AI/CaseGuard/pull/204), implementation —

# #103: notifications for document processing

## Context

FR-NOT-1 (P1) asks for "notifications for document processing complete/failed and long jobs". This is roadmap item A9, "driven by A8's job events". ADR-0010 says notifications come from apps/api, because it is the one place that sees every document state change.

Neither contract has notifications. The header has no bell: `plans/0017` left it out because a permanent unread dot would mislead. Today document processing is the only long job; research answers are synchronous.

The work runs in parallel with #101 (documents API) and #102 (documents web). Under `packages/contracts/README.md` a contract change is its own PR, so there are two PRs:

1. **Contract** (`feature/103-notifications-contract`): the spec, the generated types and the docs only.
2. **Implementation** (`feature/103-notifications`, cut from the contract branch): the API store, routes and migration, plus the web bell and sheet. The hook from the document jobs comes last, after #101 merges: rebase onto it, regenerate the migration as `0013` and call `createNotification` from #101's `setDocumentStatus`.

**Requirements:** FR-NOT-1 (and FR-AUTH-4: the caller's own notifications only).

## Decisions

- **`GET /notifications?unread&cursor&limit`** returns `{items, nextCursor, unreadCount}`, newest first.
  - `unreadCount` is the caller's whole unread total on every page, so the bell needs only one small request (`limit=1`).
- **`POST /notifications/{notificationId}/read`** returns 204. It is idempotent and keeps the first `readAt`. Another user's notification is a 404.
- **`POST /notifications/read-all`** returns 204.
- **`Notification` is `{id, kind, documentId|null, caseId, filename, readAt|null, createdAt}`.**
  - `kind` is one of `document_done`, `document_flagged`, `document_failed`. New kinds are additive, and a client shows a generic text for an unknown kind.
  - There is no display text. The web words it in en or ur from `kind` and `filename`.
  - `documentId` becomes null when the document is deleted (`ON DELETE SET NULL`). `filename` is copied when the notification is made, so the notification still reads correctly afterwards.
- **One notification per attempt's final outcome.** None for `processing`, and none for an automatic retry in between.
- **Table `app.notifications`** (migration `0013_notifications`, with a hand-written down):
  - `owner_user_id` and `account_id`, with FKs that cascade
  - `kind`, `document_id` (FK `ON DELETE SET NULL`), `case_id` (FK cascade), `filename`, `read_at`, `created_at`
  - an index on `(owner_user_id, created_at desc, id desc)`, and a partial index on `owner_user_id` where `read_at is null`, for the count
- **Web bell:**
  - It sits in `app-header.tsx` and polls `listNotifications?limit=1` every 60 s. The dot shows only when `unreadCount > 0`.
  - It opens the existing `Sheet` with the list: a kind icon, localized text, relative time, a link to the case dashboard, and "load more".
  - "Mark all read" is there, and clicking an item marks it read.
  - New strings go in a `Notifications` namespace.

## Changes

### PR 1: contract
1. **`packages/contracts/openapi/api.v1.yaml`:**
   - the `notifications` tag and an info line
   - parameters `NotificationId` and `NotificationUnread`
   - paths `listNotifications`, `markNotificationRead` and `markAllNotificationsRead`
   - schemas `NotificationKind` and `Notification`
2. **`packages/contracts/generated/api.v1.ts`:** regenerated with `pnpm gen:contracts`.
3. **Docs:** the `packages/contracts/README.md` Status line, `CHANGELOG.md`, `docs/engineering/work-log.md`, and this plan.

### PR 2: implementation
1. **`apps/api/src/db/schema.ts`:** add `notifications`. Generate migration `0013_notifications` with drizzle-kit and hand-write `0013_notifications.down.sql`.
2. **`apps/api/src/notifications/store.ts`:** `createNotification`, `listNotifications` (cursor), `countUnread`, `markRead` and `markAllRead`, all owner-scoped.
3. **`apps/api/src/routes/notifications.ts`:** behind `requireAuth`, mounted in `app.ts`.
4. **`apps/api/test/notifications.test.ts`:**
   - `expectContract` on every route
   - alice and bob 404s
   - the unread filter and count
   - mark read is idempotent; read-all
   - a deleted document leaves `documentId` null
5. **`apps/web/src/components/notifications/`:** `queries.ts`, `notification-bell.tsx` and `notification-list.tsx`.
6. **`apps/web/src/components/shell/app-header.tsx`:** the bell, placed before `LanguageSwitch`.
7. **`apps/web/messages/en.json` and `ur.json`:** the `Notifications` namespace.
8. **`apps/web/test/notifications.test.tsx`:** no dot at zero; the dot appears; the sheet lists the items; mark read; mark all read.
9. **Docs:** `apps/api/README.md` (route table), `CHANGELOG.md`, `work-log.md`, and the roadmap A9 note.
10. **After #101 merges:** rebase, regenerate the migration as `0013`, call `createNotification` from `setDocumentStatus` in the same transaction for `done`, `flagged` and the final `failed`, and add tests for that.

## Verification

- **Contracts:** `npx @redocly/cli lint packages/contracts/openapi/*.yaml`, and `pnpm gen:contracts` leaves no diff.
- **API:** `pnpm --filter ./apps/api run lint`, `typecheck`, and `test` with `APP_TEST_DATABASE_URL` pointed at `caseguard_test_103` on `127.0.0.1:5433`.
- **Web:** `pnpm --filter @caseguard/web run lint`, `typecheck`, `test` and `build`.
- **CI:** `ci-ok` is green on both PRs. Merging needs the user's explicit go-ahead (`--squash`, never `--delete-branch`).

## Notes from implementation

- **Migration number:** the migration is `0012_notifications` on this branch for now. After rebasing onto #101 it is deleted and regenerated as `0013_notifications`, with the `document_id` FK to `app.documents` (`ON DELETE SET NULL`). Until then `document_id` is a plain uuid, marked `TODO(#101)` in `schema.ts`.
- **Bell position:** the bell sits after `LanguageSwitch`, not before it, so the switch keeps its `ms-auto` on small screens.
- **Bell visibility:** the bell is always visible. Only its dot depends on the unread count.
- **Shell test:** `shell.test.tsx`'s language-switch ordering test now leaves out the bell's own GET.
- **Deleted-document test:** the test that a deleted document leaves `documentId` null comes with the rebase, because `app.documents` doesn't exist yet.
