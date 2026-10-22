> **Status:** In progress · **Issue:** [#90](https://github.com/CaseGuard-AI/CaseGuard/issues/90) · **PR:** [#114](https://github.com/CaseGuard-AI/CaseGuard/pull/114)

# #90: Settings page (profile, language, theme)

## Context

**Why:** FR-SET-1 and FR-I18N-1 say a user's name, language and theme belong to the account and follow them to any device. Today:
- `/settings` is `ComingSoon`.
- The header's `LanguageSwitch` only changes the URL and the `NEXT_LOCALE` cookie.
- There is no theme. #11 removed the dark tokens "until the theme setting".

**Where it fits:** step 3 of A2 in `docs/engineering/stream-a-roadmap.md`. #88 (contract, PR #111) and #89 (API, PR #112) are merged. `GET`/`PATCH /me/settings` serve `{ name, locale, theme }`, where `theme` is `light | dark | system` and defaults to `system`.

## Decisions

Owner decisions (2026-10-22):
- **The full dark theme ships now.** That means dark tokens, a `.dark` class, and light, dark and system all working. This replaces the earlier "dark can come after M2".
- **The header's language switch also saves to the account** when someone is signed in. Otherwise the saved locale would undo it on the next sign-in or new tab.
- **The saved locale applies once per session start**: after login, or when a fresh tab restores the session. After that, a typed or shared `/en` or `/ur` URL is left alone.

My own calls:
- **The dark tokens are new.** The prototype has no dark set, and #11's scaffold block was only Next's default background and foreground. I'll derive them from the navy palette, keeping the same token names, so components don't change.
  - Text and soft surfaces should meet WCAG AA contrast. I'll check this with a quick script in the scratchpad.
  - Tokens are colours only, so RTL is unaffected. I'll grep for hard-coded colours (`bg-white`, `text-white`, `#…`) and switch any that would break in dark mode to tokens.
- **No flash on reload.** The session lives in memory, so settings arrive only after `/auth/refresh` and then `GET /me/settings`. To avoid that wait:
  - The last applied theme is cached in `localStorage` (`cg-theme`).
  - A tiny inline script in `<head>` sets `.dark` before paint. `<html>` gets `suppressHydrationWarning`.
  - The account value still wins once it loads. The auth pages use the cached theme too.
  - I'll check `node_modules/next/dist/docs` for the Next 16 way to add an inline head script before writing it.
- **`system` follows `prefers-color-scheme` live**, through a `matchMedia` change listener.
- **Each control saves on its own:**
  - Language and theme save and apply as soon as one is picked. They're radio groups built from native `<input type="radio">`, so there's no new shadcn component and no `cn` package trap.
  - The name has its own Save button, with the same rule as the API (trimmed, 1 to 120 characters). A 400 from the API shows on the field.
- **The header shows a new name straight away.** A new `updateUser(patch)` in `src/lib/session.ts` updates the in-memory `user` and broadcasts it to other tabs. Without this, the header would keep the old name until the next refresh.
- **The session-start rule survives remounts.** A locale change re-renders the `[locale]` layout, which can remount the app shell. So the "already applied this session" flag is module-level state in the preferences module, reset when the session becomes anonymous, rather than a `useRef`.
  - The header switch **awaits** its `PATCH` before it navigates. Otherwise a fresh `GET` could race it and return the old locale.
  - If the `PATCH` fails, the URL still switches. It's best effort, and there's no error toast.

## Changes

1. **Theme** (`apps/web/src/lib/theme.ts`, new):
   - `Theme` type from `Schemas`.
   - `applyTheme(theme)`: toggles `.dark` on `<html>`, writes `cg-theme`, and attaches or detaches the `matchMedia` listener for `system`.
   - `themeScript`: the inline pre-paint script, as a string.
2. **Tokens** (`apps/web/src/app/globals.css`):
   - Add a `.dark { … }` block that redefines every `:root` colour token.
   - Update the `@custom-variant dark` comment.
   - Fix any hard-coded colours the grep finds.
3. **Layout** (`apps/web/src/app/[locale]/layout.tsx`): add the head script and `suppressHydrationWarning`.
4. **Settings data** (`apps/web/src/components/settings/queries.ts`, new), in the style of `components/admin/queries.ts`, using `unwrap`/`statusOf` from `lib/api-query.ts`:
   - `useSettings()`, with key `["me","settings"]`. It's enabled only when signed in.
   - `useUpdateSettings()`. It updates the cache with `setQueryData` and calls `updateUser` for `name` and `locale`.
5. **Account preferences** (`apps/web/src/components/settings/account-preferences.tsx`, new), mounted in `(app)/layout.tsx` inside `RequireSession`. When settings load or change:
   - it calls `applyTheme`;
   - once per session start, it calls `router.replace(pathname, { locale })` if the saved locale differs from the current one.
6. **Settings page:**
   - `apps/web/src/app/[locale]/(app)/settings/page.tsx` follows the admin page's pattern: `PageIntro`, then `<SettingsForm />`.
   - `apps/web/src/components/settings/settings-form.tsx` (new) has three sections:
     - **Profile:** name, with the email read-only.
     - **Language:** English or اردو, each label in its own language.
     - **Theme:** light, dark or system, with Sun, Moon and Monitor icons.
   - It also has loading, error and retry states, and logical classes only.
7. **Header** (`apps/web/src/components/shell/language-switch.tsx`): when signed in, the click saves `locale` first, then navigates with `router.replace`. When signed out, it stays a plain `Link`.
8. **Session** (`apps/web/src/lib/session.ts`): `updateUser(patch)`, as described in Decisions.
9. **Messages** (`apps/web/messages/en.json`, `ur.json`):
   - A `Settings` namespace.
   - Update `Pages.settings.subtitle` to match what the page actually has.
   - The Urdu needs a native speaker's review. I'll flag it in the PR, as before.
10. **Tests** (Vitest, jsdom, with the fetch-stub pattern from `test/admin-console.test.tsx`):
    - `test/settings-page.test.tsx`:
      - Loads and shows the saved values.
      - Saves a trimmed name, and the header session updates.
      - An empty or too-long name is blocked on the client.
      - An API 400 shows on the field.
      - A theme change sends a `PATCH` and sets `.dark` and `cg-theme`.
      - A language change sends a `PATCH` and calls `router.replace` with the new locale.
      - A network error offers a retry.
    - `test/theme.test.ts`: `system` follows a mocked `matchMedia` and its change event, and the head script applies the cached theme.
    - `test/account-preferences.test.tsx`:
      - A saved `ur` redirects once.
      - It doesn't redirect again after a header switch or a remount.
      - The flag resets after sign-out.
    - The existing `shell.test.tsx`: when signed in, the header switch sends a `PATCH` before it navigates.
    - `rtl-classes` and i18n parity keep passing.
11. **Docs:**
    - `apps/web/README.md` gets a "Settings, language and theme" section covering the session-start locale rule, the `cg-theme` cache, the head script, and `system`.
    - `CHANGELOG.md`: an Added entry (#90).
    - The roadmap: mark A2 done.
    - This plan.

## Not in this PR
- "Models and keys" (#95) and the default model (#93).
- Changing the email or password (not in FR-SET-1).
- A native speaker's review of the Urdu (A11, #105).

## Verification
1. `pnpm --filter ./apps/web run lint`, `typecheck`, `test` and `build` all pass.
2. `pnpm stack:up`, then Playwright MCP as `research14@example.com`:
   - Change the name, and the header updates.
   - Pick dark, then reload: no light flash, and dark stays.
   - Pick system, then `browser_emulate_media` dark or light: the page follows.
   - Pick اردو: the page moves to `/ur/settings` with RTL.
   - Screenshots of dark mode in English and Urdu (the shell, Research Hub, Admin, and the login page).
3. **Another device:** in a **separate browser context** (empty storage), sign in as the same user. It should land on `/ur/…` in dark mode. Then type an `/en/…` URL: it stays on English, because the locale applies only once per session.
4. The header switch while signed in: `GET /me/settings` shows the new locale.
5. `pnpm stack:down`. CI `ci-ok` is green.

## Deviations during implementation
- **`data-theme` on `<html>` instead of a `.dark` class.** React owns `className` on `<html>` and rewrites it when the `[locale]` layout re-renders (for example after a locale switch), which would drop a class the head script added. The `dark:` variant is now `&:where([data-theme="dark"], [data-theme="dark"] *)`.
- **A new `link` colour token.** In dark mode, a `primary` dark enough to carry white button text is only 3.2:1 as link text on a card, which fails WCAG AA. Text links (four in the auth forms and the answer card, plus the button's `link` variant) now use `text-link`. It equals `primary` in light mode, so light mode looks the same, and it's 8.3:1 in dark mode. Every other dark text pair passes AA. I checked them with an OKLCH contrast script. Light mode's `warning` on `warning-soft` is 3.86:1, which predates this PR and is unchanged.
- **The "once per session start" flag moved to `sessionStorage` (`cg-locale-applied`).** A module-level flag resets on every full page load, so the browser check showed a typed `/ur/research` URL being pulled back to the saved `/en`. That contradicts the owner decision. The flag is now per tab: it survives a reload or a typed URL, a new tab still counts as a session start, and sign-out clears it. A new test covers the same-tab reload. Removing the persistence makes it fail.
- **A test fix found by a mutation check.** The first version of the "doesn't redirect again after a remount" test still passed with the flag removed. `data-theme` was already `dark` from the first mount, so `waitFor` returned before the second fetch. The test now clears `data-theme` before each mount.
- **The browser check needed visible-only selectors.** After a locale move, Next 16 keeps the previous route mounted but hidden (a known gotcha).
- **I reset the test account.** After the browser check, `research14@example.com` was set back to `Research Tester`, `ur`, `system`.
