> **Status:** In progress (A done in #241; B done in #242; C in progress for #239) · **Issues:** [#238](https://github.com/CaseGuard-AI/CaseGuard/issues/238) (UI audit), [#239](https://github.com/CaseGuard-AI/CaseGuard/issues/239) (screenshots), [#240](https://github.com/CaseGuard-AI/CaseGuard/issues/240) (HF corpus dump) · **PRs:** [#241](https://github.com/CaseGuard-AI/CaseGuard/pull/241) (A), [#242](https://github.com/CaseGuard-AI/CaseGuard/pull/242) (B)

# UI audit fixes, HF corpus dump, screenshot proof folder

## Context
The user pulled `staging` and found three problems: some UI says built features aren't available, some boxes can't be clicked, and there are general UI problems. A teammate has also published a **corpus dump** to Hugging Face (`caseguard/corpus`). The user wants a committed screenshots folder that shows each feature working. Three read-only explorers audited the web app, the corpus/HF code and the run/E2E setup. Choices the user made: the P2 pages get a "Soon" badge, Evaluation moves under admin, and screenshots come from a repeatable Playwright script with the images committed.

Process: open one issue per workstream, branch off `staging`, open a PR to `staging`, require `ci-ok`, never delete branches, copy this plan to `plans/NNNN-<issue>-<slug>.md`. Merges need the user's approval. Docs PR #234 is still open and waits on the user.

## Workstream A: UI audit fixes (`fix/<issue>-ui-audit`), apps/web
Run as a parallel agent in its own worktree.

**Stale status**
- `src/components/cases/case-dashboard.tsx:51,302-305` and `messages/{en,ur}.json:472-475`: the Precedents placeholder says "once precedent search is available", but precedent search is built. Replace it with a clickable card: "Search precedents for this case" linking to `/precedents`. Saving a precedent to a case is not built and stays out of scope.
- Delete the dead key `Cases.dashboard.drafts.body` (`en/ur.json:468-471`). Fix the stale comments at `case-dashboard.tsx:27-28` and `dashboard/dashboard.tsx:11-12`.
- Move `pageMetadata` out of `shell/coming-soon.tsx` into `shell/page-metadata.ts`, then update its 15 importers.
- Delete the dead component `src/components/api-status.tsx`.

**Non-clickable or misleading items**
- `shell/sidebar.tsx:87-107`: make the user block a link to `/settings`.
- `shell/app-header.tsx:54`: make the "CaseGuard AI" crumb a link to `/`.
- `app-header.tsx:104-119`: remove the duplicate Profile item (keep Settings). Drop the disabled "Help centre" item.
- Keep the header search disabled, but give it a tooltip/title of "Coming soon".
- `drafting/drafts-list.tsx:69-85`: make the whole row a link, matching `cases-list.tsx:76`.
- `precedents/precedent-search.tsx:232-278`: make the whole card open the relationships panel (button semantics, keyboard focus).
- `documents/page.tsx:20`: add a "Go to cases" link to the upload hint.

**Missing feature and nav**
- `dashboard/dashboard.tsx`: add a "Recent drafts" section (FR-DASH-1). Reuse `useDrafts` from `drafting/queries.ts:49` and the existing recent-list markup and row-link pattern. Add en/ur strings.
- `shell/nav-items.ts`: add a `soon: true` flag to Strategy and Stress-Test, and render a "Soon" badge in `sidebar.tsx`. Move Evaluation from `mainNav` to `adminNav` (FR-EVAL-3), also badged. Remove the dead `/case` special case at lines 53-55.
- Change the `en.json:42` subtitle to something accurate, for example "Pick up where you left off."

**Accessibility and consistency**
- Add `role="alert"` to the dashboard error at `dashboard.tsx:165-172`.
- Add `aria-busy` and a spinner to `notification-list.tsx:27-29`.
- Add route-level `src/app/[locale]/(app)/error.tsx` (client, with a retry button) and `loading.tsx`.

**Tests:** add or extend Vitest tests in `apps/web/test/` covering the Recent drafts section, the clickable Precedents card, the nav badge, and Evaluation appearing only for admins. Run `pnpm --filter web lint typecheck test` and `next build` (cacheComponents: dynamic routes need Suspense).

## Workstream B: Pull the HF corpus dump (dev DB, plus a docs PR)
This needs the user to add `HF_TOKEN=` to `.env` themselves, or run `! hf auth login`. The token currently gets a 401.
1. `pnpm db:up`
2. `pnpm db:migrate`, which applies api migrations 0014–0016
3. `pnpm db:migrate:ai`
4. `pnpm data:pull -- --dump latest`. `ingest/pull.py` and `dump.py` check the SHA-256, the alembic revision and the column layout. A mismatch is reported to the user, never forced.
5. `pnpm ai:graph-build`. The graph is not part of the dump.
6. Check the result: `pnpm research:ask "What is the punishment under s. 302 PPC?"`, then precedent search (it needs judgments in the dump) and drafting assist. Also confirm that `corpus_meta` matches `EMBEDDING_MODEL` and `EMBEDDING_REVISION` (`retrieval/guard.py`).
7. Docs PR: update `docs/engineering/session-handoff.md` and `local-setup.md` with the pull steps. Fix the stale status lines in plans 0017–0038, 0041 and 0044, and in `docs/engineering/stream-a-roadmap.md` (A3, A5, A6 and #102 shipped). Note #154 and #192 as unblocked.

## Workstream C: Screenshot proof (`feature/<issue>-screenshots`)
Run as a parallel agent once A's branch exists. Captures happen after A merges and B finishes.
- Add `@playwright/test` as a root devDependency. Chromium is already in `%LOCALAPPDATA%\ms-playwright`.
- Add `scripts/screenshots/capture.ts` and a `screenshots.config.ts`, plus `pnpm screenshots`. The flow assumes `pnpm dev` is running:
  1. Register a throwaway lawyer through `POST /api/v1/auth/register`, then log in through the UI.
  2. Seed the data through the API: a case, a research question saved to the case, a draft from a template, and a lint report saved to the case.
  3. Visit each page and write numbered, descriptive PNGs to `docs/screenshots/`: `01-login`, `02-register`, `03-dashboard-recent-research-cases-drafts`, `04-cases-list`, `05-case-new`, `06-case-dashboard`, `07-research-answer-with-citations`, `08-research-history`, `09-precedent-search-results`, `10-precedent-relationships`, `11-drafting-templates`, `12-draft-editor-ai-assist`, `13-linter-findings`, `14-lint-report-saved-to-case`, `15-documents-list`, `16-settings-models-keys`, `17-admin-console` (admin via `db:create-admin`), `18-urdu-rtl-dark`, `19-sidebar-soon-badges`.
  4. Pages that depend on AI (07, 09, 10, 12) are skipped with a logged reason when the corpus or LLM returns 503, so no image ever shows a failure.
- Add `docs/screenshots/README.md`: a table of image, feature, FR-ID and what it proves, plus how to regenerate.
- Gitignore the old `.playwright-mcp/` folder. This workstream does not add a CI job.

## Verification
- A: lint, typecheck, Vitest and `next build` are green. Then do a manual click-through in `pnpm dev`: every card, row and nav item clicks, the Soon badges show, Evaluation appears only for admins, and Recent drafts is populated.
- B: `research:ask` returns a cited answer, and the precedents and drafting assist return results in the UI.
- C: `pnpm screenshots` runs cleanly on a fresh dev DB and produces all PNGs. Open and check each image before committing.
- CI `ci-ok` passes on each PR, and the user approves the merges.
