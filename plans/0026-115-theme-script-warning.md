> **Status:** In progress · **Issue:** [#115](https://github.com/CaseGuard-AI/CaseGuard/issues/115) · **PR:** TBD

# #115: Theme script logs "Encountered a script tag"

## Context

**Why:** in dev, switching language (English ⇄ اردو) logs this console error from `apps/web/src/app/[locale]/layout.tsx`:

> Encountered a script tag while rendering React component. Scripts inside React components are never executed when rendering on the client.

The `<head>` script from #90 (`themeScript` in `src/lib/theme.ts`) applies the cached theme before the first paint. On a full page load it comes from the server HTML and runs as intended. A locale switch, though, re-renders the `[locale]` root layout in the browser, and React creates a new `<script>` element there. React 19's dev build warns about any executable script it creates on the client, unless it is a data block with a non-JS `type` (`isScriptDataBlock` in `react-dom-client.development.js`). That copy would never run anyway.

## Approach

- New client component `src/components/theme-script.tsx`. It renders the same inline script, with `type` unset on the server (executable) and `"text/plain"` in the browser (a data block, so no warning).
- `suppressHydrationWarning` on the script covers the `type` difference while hydrating. React keeps the server DOM, so the server copy has already run.
- `layout.tsx` renders `<ThemeScript />` instead of the raw `<script>`.

No behaviour change. The theme still comes from the server script on load, and from `applyTheme` (`AccountPreferences`) once the account's settings arrive.

## Verification

- `pnpm --filter ./apps/web lint typecheck test` pass.
- Playwright, dark theme cached: a full load of `/en/login` gives `data-theme="dark"` from the executable server script. Clicking اردو (client navigation) adds a `text/plain` copy, and there's no "script tag" error in the console.
- Signed in with dark saved: switching `/en` → `/ur` keeps `data-theme="dark"`, and there's no "script tag" error.

## Follow-up noticed (not in scope)

Signed out, `data-theme` is dropped from `<html>` after a client-side locale switch on the auth pages, because nothing calls `applyTheme` there. This is the same before and after this change, since the browser-created script never ran.
