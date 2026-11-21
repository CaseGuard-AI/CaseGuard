> **Status:** Done · **Issue:** [#229](https://github.com/CaseGuard-AI/CaseGuard/issues/229) · **PR:** [#233](https://github.com/CaseGuard-AI/CaseGuard/pull/233)

# #229: "Lint this draft" in the drafting studio

This is the last PR of Phase 2 of plan `0052`. It also marks A12 done.

## Change

- `apps/web/src/components/drafting/lint-text.ts`:
  - `lintTypeOf(templateId)` maps `bail_application` and `plaint` to their linter document types. A legal notice has no rule set, so it maps to `null`.
  - `draftLintText(template, draft)` builds the text to lint:
    - The title comes first.
    - Then the particulars, one "Label: value" line each. The FIR number, police station and similar details live here, not in the sections, so leaving them out would wrongly flag them as missing.
    - Then each section under its heading, in template order.
    - Citation markers are dropped. Empty fields and sections are left out, so the linter reports them.
- `draft-editor.tsx`:
  - A "Lint this draft" button, shown only when the template has a linter. Like export, it lints the saved version, so it is disabled while there are unsaved edits.
  - It calls `POST /lint-reports` with `{documentType, text, title, draftId, caseId?}`, then opens `/linter?report=<id>`. If the lint fails, it shows an alert.
- en/ur strings `lint`, `lintSavedOnly` and `lintError`.
- Housekeeping:
  - Mark A12 done in `docs/engineering/stream-a-roadmap.md`.
  - Set plans 0052–0061 to Done.

## Verification

- `test/drafting.test.tsx`:
  - The exact body is sent, with markers stripped, and the report opens.
  - The button is disabled while the draft is dirty.
  - A failed lint shows an alert.
  - A legal notice gets no button.
- `pnpm --filter ./apps/web run lint|typecheck|test|build`.
