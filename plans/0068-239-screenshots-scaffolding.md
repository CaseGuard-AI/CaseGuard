> **Status:** In review (18 of 19 captured against the Colab tunnel; 15 cannot run with a remote AI service) · **PR:** [#247](https://github.com/CaseGuard-AI/CaseGuard/pull/247) · **Issue:** [#239](https://github.com/CaseGuard-AI/CaseGuard/issues/239) · **Parent plan:** [0066](0066-238-ui-audit-screenshots-hf-dump.md), Workstream C

# #239: Screenshot proof folder, scaffolding and captures

## Context
Plan 0066 Workstream C asks for a committed `docs/screenshots/` folder with one PNG per built feature, produced by a repeatable Playwright script. The scaffolding was written in an agent worktree during the 2026-11-27 session and left uncommitted. This plan finishes it and then runs the captures. The AI screens (07, 09, 10, 12) need a model and the corpus, so they run against the Colab AI service through its tunnel. The local machine can't run the reranker.

## Steps
1. Rename the branch to `feature/239-screenshots`, because branch policy rejects `feat/`. Rebase it on `staging`.
2. Root dev dependencies, pinned exactly: `@playwright/test@1.65.0` (it matches the installed chromium build 1254), `typescript@6.0.3` and `@types/node@24.19.2`.
3. Add two root scripts:
   - `screenshots`: `playwright test -c scripts/screenshots/screenshots.config.ts`
   - `screenshots:typecheck`: `tsc -p scripts/screenshots/tsconfig.json`
4. Fix typecheck:
   - Set the tsconfig to `module: preserve` and `moduleResolution: bundler`. The repo root has no `"type": "module"`, so `NodeNext` treated the files as CommonJS and rejected their ESM syntax. Playwright transpiles the files itself.
   - Pass `includeGraphDerived: true` on the precedent search body. The field has a default, so openapi-typescript makes it required.
5. Fix plan 0066's status line: A is done (#241) and B is done (#242).
6. Open a draft PR to `staging`.
7. Captures:
   - The user starts the Colab runtime and shares the tunnel URL.
   - Run `pnpm dev` with `AI_SERVICE_URL` set to the tunnel, then `pnpm screenshots`.
   - Check each PNG, commit them, and mark the PR ready.

## Verification
- `pnpm screenshots:typecheck` is clean.
- `playwright test --list` lists all 19 captures.
- CI `ci-ok` is green.
- After the captures, each PNG shows real content, and none shows an error or an empty state.

## Outcome (2026-11-28)
- Captured against the Colab tunnel after merging #245 (the notebook allow-list) and #246 (token budgets). The dev DB had to enable NVIDIA NIM (`app.providers`), because the api sends only enabled providers.
- Script fixes from the real run:
  - 14: the `has:` locator started from `main`, so it never matched inside a section.
  - Viewport captures instead of full page. Full page repeated the fixed sidebar mid-image on 12.
  - The `next dev` overlay is hidden.
  - 17 masks real users, because the repo is public.
- 15 is skipped: the Colab AI service has its own database and never sees local uploads (ingestion 404).
- Seen in 17: the avatar initials for "Admin (screenshots)" render as "A(". It's an app bug and is out of scope here.

