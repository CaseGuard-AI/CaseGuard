> **Status:** Done · **Issue:** [#88](https://github.com/CaseGuard-AI/CaseGuard/issues/88) · **PR:** [#111](https://github.com/CaseGuard-AI/CaseGuard/pull/111)

# #88: user settings in the api.v1 contract

## Context

FR-SET-1 (P0) asks for user settings: language, default model and theme, where "a change persists across sessions". api.v1 has none of these.
- `users.locale` exists and is returned in `User`, but nothing can change it after registration.
- The web `LanguageSwitch` only changes the URL and the `NEXT_LOCALE` cookie, so the choice doesn't follow the user to another browser.
- There's no theme anywhere.

This is item A2 in [`docs/engineering/stream-a-roadmap.md`](../docs/engineering/stream-a-roadmap.md): #88 (this contract) → #89 (the API) → #90 (the Settings page). Under the contracts rules (`packages/contracts/README.md`), **a contract change goes in its own PR**, reviewed by the producer (`apps/api`) and the consumer (`apps/web`). As with #53 and #55, this PR changes only the contract and the generated types.

**Requirements:** FR-SET-1 (language and theme), FR-AUTH-4 (the user's own settings only).

**Decisions (owner):**
- **The theme is `light`, `dark` or `system`.** Dark mode itself can come after M2. The contract defines all three now, so #90 can ship them all or start with light only, without another contract change.

**Decisions (from the PRD and the existing contract):**
- **The path is `/me/settings`** (`getMySettings`, `updateMySettings`), under a new `settings` tag. It's a resource about the signed-in user, separate from `/auth/*`, which is about sessions.
- **`UserSettings { name, locale, theme }`, all required in responses.**
  - `name` has the same bounds as `RegisterRequest` (1–120).
  - `locale` is `en` or `ur`, the same enum as `User.locale`.
  - `theme` is `light`, `dark` or `system`, documented as defaulting to `system` for existing users.
- **`PATCH` is partial:** `UserSettingsUpdate`, with every field optional, `minProperties: 1` and `additionalProperties: false`.
  - It returns **200** with the full `UserSettings`, **400** with `errors[]` for an unknown field, a bad value or an empty body, and **401**.
  - There's no 404: it's always the caller's own settings (FR-AUTH-4).
- **`User` doesn't change.** It already carries `locale`, so the web reads `GET /me/settings` for the theme after sign-in (#90).
  - Making `theme` a required field of `User` would make the API's existing contract tests fail until #89, because `User` is in every session response.
  - The name and locale returned by `/auth/me` and the session will show a `PATCH` from the next refresh. The API documents that in #89.
- **No email or password change here.** Changing the email needs re-verification and changing the password needs the current password. Both are separate security flows with their own issues if wanted, and FR-SET-1 doesn't list them.
- **The default model is not in this PR.** It depends on the keys and model-list contract (#93, after the ADR #92), and will be added to `UserSettings` there as an optional field. That's an additive change.
- **Additive and non-breaking:** no `!` and no version bump.

Branch: `feature/contracts-user-settings` off `staging`. PR title: `feat(contracts): user settings in api.v1`.

## Changes

1. **`packages/contracts/openapi/api.v1.yaml`**
   - Tag `settings`: "The signed-in user's own preferences (FR-SET)".
   - `GET /me/settings` (`getMySettings`, bearer): 200 `UserSettings`, 401.
   - `PATCH /me/settings` (`updateMySettings`, bearer): body `UserSettingsUpdate`; 200 `UserSettings`, 400 (`BadRequest`, with `errors[]`), 401. The description says the change applies from the next request and shows in `User` after the next refresh.
   - Schemas:
     - `Theme`: enum `[light, dark, system]`.
     - `UserSettings`: required `name`, `locale`, `theme`.
     - `UserSettingsUpdate`: the same fields, all optional, with `minProperties: 1` and `additionalProperties: false`.
2. **`packages/contracts/generated/api.v1.ts`**, regenerated with `pnpm gen:contracts`. It's never edited by hand.
3. **`packages/contracts/README.md`**: the Status section mentions user settings.
4. **`CHANGELOG.md`**: an Added entry ("api.v1 contract: user settings …, #88").
5. **This plan's status line.**

## Left for the implementation PRs
- **#89 (API):**
  - a `theme` column on `app.users` (default `system`, with a check constraint, a migration and `.down.sql`);
  - the routes and validation, owner only;
  - contract tests through `expectContract`.
- **#90 (web):** the Settings page; applying the saved locale and theme after sign-in; and, if wanted now, the dark tokens.

## Verification
- `npx @redocly/cli lint packages/contracts/openapi/*.yaml` passes.
- `pnpm gen:contracts` leaves no diff after the commit, which is what the CI staleness check tests.
- `pnpm --filter ./apps/web run typecheck` and `pnpm --filter ./apps/api run typecheck` still pass on the new types.
- CI `ci-ok` is green, including the `contracts` job.
