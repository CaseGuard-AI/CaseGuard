> **Status:** Done · **Issue:** [#91](https://github.com/CaseGuard-AI/CaseGuard/issues/91) · **PR:** [#109](https://github.com/CaseGuard-AI/CaseGuard/pull/109)

# #91: Admin console for per-user AI access and the provider allow-list (web)

## Context

#91 is item A4 in [`docs/engineering/stream-a-roadmap.md`](../docs/engineering/stream-a-roadmap.md). The admin API has been merged since #55, but there's no screen for it. So turning AI off for a user, or changing the provider allow-list, takes `curl`. The #14 browser check needed exactly that.

How the API behaves (`apps/api/src/routes/admin.ts`, plan 0012):
- **All of it:** everything under `/admin` requires `requireAuth` and `requireRole("admin")`. A User gets **403**.
- **`GET /admin/users?cursor&limit`:** returns `{ items: AdminUser[], nextCursor }`, oldest first, with `limit` between 1 and 100 (default 20).
  - `AdminUser` is `User` (`id`, `email`, `name`, `role`, `locale`, `aiEnabled`) plus `createdAt`.
- **`PATCH /admin/users/{id}`:** takes the strict body `{ aiEnabled }` and returns 200 with the `AdminUser`. A bad body gives 400 and an unknown id gives 404. The change applies from the user's next request; with AI off, their questions get 403.
- **`GET /admin/providers`:** returns `{ items: Provider[] }`, where a `Provider` has `id`, `name`, `kind` (`cloud` or `local`) and `enabled`.
  - It's seeded with every cloud provider **disabled** and Ollama (local) enabled.
- **`PATCH /admin/providers/{id}`:** takes `{ enabled }` and returns 200 with the `Provider`, or 404.
- **When no provider is enabled,** every question gets 503 before services/ai is called (#75).
- **There's no API** for changing roles, searching users or deleting a user. That stays out of this PR.

What the web app already has:
- The session holds `user.role`.
- The sidebar renders `mainNav` + `settingsNav`, from `nav-items.ts`.
- `RequireSession` guards `(app)/`.
- TanStack Query is set up.
- The logical-side `Sheet`, `TrustBadge`, `PageIntro`.
- There are no `tabs`, `switch` or `alert-dialog` components yet.

**Requirements:** FR-AUTH-2, FR-AUTH-3, SEC-11.

**Decision (owner):** the console is a **`/admin` route for Admins only**, not tabs in Settings. Its sidebar link only shows for Admins. A User who opens `/admin` gets a "not allowed" page, and the API returns 403 regardless.

**Decisions (from the contract and the PRD):**
- **The browser hides the page, but the API is the real gate.**
  - A User gets the "not allowed" panel straight away and the page **makes no admin request**.
  - If the API returns 403 anyway (for example, the role was taken away in another session), the page shows the same panel.
  - The sidebar link depends on `session.user.role === "admin"`.
- **Tabs live in the URL.** `/admin?tab=users` is the default and `/admin?tab=providers` is the other, so a reload or a link keeps the tab. It's the shadcn `tabs` (Radix), which handles arrow keys and RTL through the existing `Direction` provider.
- **Users tab.**
  - `useInfiniteQuery` over `GET /admin/users` with `limit=50`, plus a "Load more" button while `nextCursor` is set. The API has no search, so there's none here.
  - Each row shows the name, the email (`dir="ltr"`), a role badge, the UI language, the date joined and an **AI access** switch (`aria-label` "AI access for <name>").
  - The admin's own row is marked "You". They can switch their own AI off, as the API allows.
- **Each toggle waits for the server.**
  - While its PATCH is in flight, that switch is disabled and shows the old value.
  - On 200 the returned record replaces the row in the cache. The page never assumes the change worked.
  - On failure the row shows an inline error with the localised reason (403 shows the "not allowed" panel; otherwise network or generic), and the switch stays where it was.
- **Providers tab (SEC-11).**
  - Each provider shows its name, its `id` (`dir="ltr"`), a kind badge and a switch. **Local** means "Data stays on this machine". **Cloud** means "Sends case data to a third party".
  - **Turning on a cloud provider asks for confirmation** in an `AlertDialog`: "Turn on <name>? Questions and case data may be sent to <name>." Cancel sends nothing.
  - Turning on a local provider, or turning anything off, needs no confirmation, because neither widens where data goes.
  - **If no provider is enabled,** a warning says "No provider is enabled. Every question will fail until one is turned on." That's the API's 503 from #75.
- **Phone width.** Rows are flex lists that wrap, not wide tables, so there's no horizontal scroll at 390 px in EN or UR.
- **New shadcn components** `tabs`, `switch` and `alert-dialog` are added the documented way: remove the `cn` package, import from `@/lib/utils`, restore the lockfile, and convert any physical classes (the RTL test enforces this).

Branch: `feature/web-admin-console` off `staging`. PR title: `feat(web): admin console for AI access and the provider allow-list`.

## Changes

1. **Route.** `src/app/[locale]/(app)/admin/page.tsx` renders `PageIntro` (`Pages.admin`) and `<AdminConsole />` inside `Suspense` (it reads `?tab=`). The metadata comes from `pageMetadata("admin")`.

2. **Navigation** (`src/components/shell/`)
   - `nav-items.ts`: add `"admin"` to `PageKey` and an `adminNav` item (`/admin`, the `ShieldCheck` icon). `activePage` recognises it.
   - `sidebar.tsx`: render `adminNav` above Settings, only when `session.user.role === "admin"`.

3. **Components** (`src/components/admin/`)
   - `admin-console.tsx`: the role check, the forbidden panel and the tabs.
   - `users-panel.tsx`: the infinite list, the rows, Load more, and the error and empty states.
   - `providers-panel.tsx`: the list, the kind badges, the confirmation for cloud providers and the "none enabled" warning.
   - `queries.ts`: `useAdminUsers()`, `useSetUserAi()`, `useProviders()`, `useSetProvider()`, built on the same `unwrap`/`ApiError` pattern as `components/research/queries.ts`.
     - Move `ApiError` and `unwrap` into `src/lib/api-query.ts`, so both features share them, and update the research imports.

4. **UI components.** `src/components/ui/{tabs,switch,alert-dialog}.tsx`, through shadcn and RTL-safe.

5. **Messages** (en and ur, the same keys)
   - `Nav.admin`, `Pages.admin.{title,subtitle}`.
   - `Admin.{tabs.users,tabs.providers,forbidden,forbiddenBody}`.
   - `Admin.users.{aiAccess,aiFor,you,joined,language,loadMore,empty}`.
   - `Admin.providers.{local,localBody,cloud,cloudBody,confirmTitle,confirmBody,confirm,cancel,noneEnabled}`.
   - `Admin.errors.{network,generic}`.

6. **Tests**
   - `test/admin-console.test.tsx` (ur labels, stubbed `fetch`):
     - A User sees the forbidden panel and **no request is made to `/admin/*`**. A 403 from the API shows the same panel.
     - Users load with `limit=50`. "Load more" sends `cursor=<nextCursor>` and appends the next page. The button disappears when `nextCursor` is null.
     - A switch sends `PATCH /admin/users/{id}` `{ aiEnabled: false }`, is disabled while waiting, and shows the returned value. A 500 shows the row error and leaves the switch where it was.
     - The admin's own row says "You".
     - Turning on a cloud provider opens the confirmation; Cancel sends nothing, and Confirm sends `{ enabled: true }`. Turning on a local provider, or turning a provider off, sends straight away.
     - With every provider off, the "none enabled" warning shows.
     - `?tab=providers` opens the Providers tab.
   - `test/shell.test.tsx`: the Admin link shows for an Admin and is absent for a User.
   - `rtl-classes.test.ts` and `i18n.test.ts` cover the new files and keys.

7. **Docs**
   - `apps/web/README.md`: an "Admin console" section on the role gate, the cloud confirmation, and the fact that toggles wait for the server.
   - Replace the `curl` steps in the browser-check notes with the console.
   - The `CHANGELOG.md` entry.
   - This plan's status line.

## Deviations during implementation
- **The Admin link sits in the sidebar footer, above Settings,** not in the main nav. The main nav stays the prototype's ten screens, and the existing nav-order tests don't change.
- **A shared `states.tsx`** holds the Forbidden, Loading and LoadError views, so the console and its panels don't import each other.
- **A failed change that gets 403** reloads the list instead of showing a row error, so the panel switches to "Admins only". Network and other failures show the row error.
- **Lookups retry only network failures,** never a 403 or 404.
- **`shadcn add alert-dialog` stopped at an overwrite prompt for `button.tsx`.** I reran it on its own, answered "no", and the RTL-adjusted button is unchanged.
  - shadcn's RTL mode already adds `rtl:` variants for the switch thumb and the dialog centring.
  - The `cn` package was removed again and the lockfile restored, as in #11.
- **New message keys** not in the plan's list: `Admin.loading`, `Admin.loadError`, `Admin.retry`, `Admin.users.intro`, `Admin.users.locales.*`, `Admin.providers.intro`, `Admin.providers.enabledFor` and `Admin.providers.empty`.
- **The browser check used two browser contexts,** because tabs in one context share the session, as designed. The Admin was in one and the User in the other.
- **The seeded state was restored afterwards:** Ollama on, every cloud provider off, and the test User's AI off.

## Not in this PR
- Role changes, user search, deleting or suspending users, and an audit-log viewer. None of them has an API yet.
- User API keys and a model list (#93–#95), and the user's own settings (#88–#90).

## Verification
- `pnpm --filter ./apps/web run lint`, `typecheck`, `test` (all pass, none skipped) and `build`.
- `pnpm stack:up`, then create an Admin with `docker compose exec -T api node dist/db/create-admin.js` and register a User. Everything below uses the live API, with no mocks:
  1. **As the User:** there's no Admin link in the sidebar, and `/ur/admin` shows the forbidden panel with no `/admin/*` request in the network log.
  2. **As the Admin, `/ur/admin`:** the Users tab lists both accounts, the Admin's row says "You", and the layout is RTL.
  3. **Turning the User's AI off:** in the User's session, asking in `/research` now shows "AI research is turned off" (the live 403). Turning it back on gives the live 503 again (no `research/answer` before #20).
  4. **Providers tab:** Ollama is on and the cloud providers are off.
     - Turning on Gemini asks for confirmation. Cancel leaves it off, and Confirm turns it on.
     - With every provider off, the warning shows, and a question returns 503 before services/ai is called.
     - Restore the seeded state afterwards.
  5. **Reloading on `?tab=providers`** keeps the tab.
  6. **At 390 px wide,** there's no horizontal scroll in EN or UR.
- CI `ci-ok` is green.
