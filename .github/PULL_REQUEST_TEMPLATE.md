<!--
PR title must be a Conventional Commit: <type>(<area>): <summary>
  e.g.  feat(ai): add reciprocal rank fusion to hybrid retriever
Base branch: staging (only release/* and hotfix/* PRs target main)
-->

## What & why

<!-- One or two sentences. Link the issue: Closes #123 -->

## PRD requirements

<!-- IDs implemented or affected, e.g. FR-TRUST-4, NFR-16. Write "none" for pure chores. -->

-

## How it was tested

<!-- Commands run, tests added, screenshots for UI (EN and UR/RTL if user-facing). -->

## Checklist

- [ ] Branch is up to date with `staging` (rebased)
- [ ] Acceptance criteria of the listed requirements pass, with tests added or updated
- [ ] No change to access scope, **or** leakage/marker tests added (FR-CASE-6, SEC-8)
- [ ] Trust status is read from the trust store only (FR-TRUST-10)
- [ ] User-facing strings externalised and layout RTL-safe (FR-I18N-1)
- [ ] Contract changes made in `packages/contracts` first, and both sides reviewed
- [ ] No secrets, keys or case content in code, logs or fixtures
- [ ] Docs/PRD/ADR updated if behaviour or architecture changed
- [ ] `.env.example` updated for any new variable
