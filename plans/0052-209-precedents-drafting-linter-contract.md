> **Status:** Done · **Issue:** [#209](https://github.com/CaseGuard-AI/CaseGuard/issues/209) · **PR:** [#216](https://github.com/CaseGuard-AI/CaseGuard/pull/216); Phase 2: #230, #231, #232, #233

# #209 (and A12 overall): #106 precedent search, #107 drafting studio, #108 linter, built as full verticals in parallel

## Context

Three web screens still show `ComingSoon`: `/precedents` (#106), `/drafting` (#107) and `/linter` (#108). Together they are A12 in `docs/engineering/stream-a-roadmap.md` and part of the M3 "Thin P1" milestone, due December 2026. Each screen is blocked because nothing underneath it exists yet:

- `ai.v1.yaml` and `api.v1.yaml` have no precedent, drafting or lint operations.
- `services/ai` has no graph, drafting or linter modules.
- There are no graph tables. Citations between judgments exist only as raw strings in `corpus.documents.raw` (`cited_cases`, `cited_laws`, `connected_cases`).

You chose a **full vertical per issue**: contracts → services/ai → apps/api → web, following the documents pattern (#100 → #101 → #102). These three tracks get built at the same time.

**Requirements:** FR-PREC-1..4, FR-GRAPH-1 (prerequisite), FR-DRAFT-1..4, FR-LINT-1..3, FR-TRUST-10, FR-TRUST-12, FR-CASE-4, FR-CASE-5.

## Shape of the work

```
Phase 0 (me, serial)      contracts PR: all three features in api.v1 + ai.v1
                                │
Phase 1 (3 agents, parallel, one git worktree each)
  Track P precedent:  ai (graph tables + builder + search) → api → web (#106)
  Track D drafting:   ai (templates + section assist via trust) → api (drafts, export) → web (#107)
  Track L linter:     ai (rule engine + rule sets) → api (lint reports) → web (#108)
                                │
Phase 2 (me)              integration: rebase order, cross-links, roadmap/CHANGELOG, plan statuses
```

**Why the contracts come first, in one PR.** `api.v1.yaml`, `ai.v1.yaml` and `generated/api.v1.ts` are where parallel branches would conflict most, and every layer is built against the contract (PRD §14.2, `packages/contracts/README.md`: a contract change is its own PR). Once the contract merges, the three tracks share no files except a few append-only ones (listed under Parallel-safety rules).

**Issues.** Before starting, I'll create 7 issues, all on milestone M3 with the matching area labels:

- 1 contracts issue
- Track P: graph + precedent search (ai, also FR-GRAPH-1) and precedent API
- Track D: drafting (ai) and drafts (api)
- Track L: linter (ai) and lint reports (api)

The existing #106, #107 and #108 become the web PRs. Each PR gets its own plan file at `plans/NNNN-<issue>-<slug>.md` (numbers 0052–0061, reserved up front so tracks don't collide). Branches are `feature/<issue>-<slug>` off `staging`, with Conventional Commit titles that include the requirement IDs.

## Phase 0: contracts (`feat(contracts): precedents, drafting and linter`)

Files:

- `packages/contracts/openapi/ai.v1.yaml` and `api.v1.yaml`
- `generated/api.v1.ts`, regenerated with `pnpm gen:contracts`
- `packages/contracts/README.md`, `CHANGELOG.md`
- ADR-0011 (graph-derived precedent search) and ADR-0012 (linter is deterministic and read-only)

The template is plan `plans/0046-100-documents-contract.md`. Shared fields go through YAML anchors, with no `allOf`/`unevaluatedProperties` (memory: contracts-schema-sharing). Every change is additive, with no version bump.

**Precedents**

- **ai.v1**
  - `POST /ai/v1/precedents/search` takes `{query, filters{court, area, decidedFrom, decidedTo, sectionRef}, limit, scope}`.
    - It returns `PrecedentHit[]`, each with:
      - the judgment fields: `sourceId, title, citation, court, decidedOn`
      - `origin: retrieved | graph_derived` (FR-PREC-3)
      - `via`: the edge that brought it in, for graph-derived hits
      - `flags`: the `TrustFlag` enum already in ai.v1, e.g. `overruled`
      - the best passage `locator` and `snippet`
    - It is deterministic and needs no model provider.
  - `GET /ai/v1/precedents/{sourceId}/relationships` returns `Relationship[]`, each with:
    - `type`: the P0 edge enum from PRD §9.2, i.e. `CITES_SECTION, CITES_JUDGMENT, AMENDS, SUBSTITUTES, INSERTS, OMITS, REPEALS, OVERRULES, CONNECTED_CASE`
    - `direction: outgoing | incoming`
    - `other {entityType, sourceId?, label}`
    - `provenance {documentId, extractionMethod, confidence, humanConfirmed}`
    - `verificationStatus`, `validFrom`, `validTo`, `recordedAt`

    This covers FR-PREC-2 and FR-PREC-4.
- **api.v1**
  - `POST /precedents/search` and `GET /precedents/{sourceId}/relationships`. They mirror the ai.v1 operations, are authenticated, and write an audit record.

**Drafting**

- **ai.v1**
  - `GET /ai/v1/drafting/templates` returns `DraftTemplate[]`:
    - `id`: `bail_application | plaint | legal_notice`
    - `version`, `title`
    - `sections[]`, each `{key, heading, required, assistable}`
    - `fields[]`, each `{key, label, caseField?}`. The `caseField` mapping lets apps/api fill fields from the case (FR-DRAFT-2).
  - `POST /ai/v1/drafting/sections` takes `{templateId, sectionKey, instruction, fields, otherSections, scope, allowedProviders, credential?}`. It returns `{text, citations[]}`:
    - The text uses `[[c:<uuid>]]` markers.
    - The citations use the **same `Citation` schema as research** and are read back from the trust store (FR-DRAFT-3, FR-TRUST-10).
- **api.v1** (drafts live in the `app` schema, per ADR-0002)
  - `GET /drafting/templates`
  - `POST /drafts` `{templateId, caseId?, title}`. The server fills the fields from the case.
  - `GET /drafts?caseId=`, cursor-paged
  - `GET`, `PUT` and `DELETE /drafts/{draftId}`. `PUT` carries `version`; a stale version gets a 409.
  - `POST /drafts/{draftId}/sections/{sectionKey}/assist`
  - `GET /drafts/{draftId}/export?format=docx|pdf` (FR-DRAFT-4)
  - The `Draft` schema: `{id, templateId, templateVersion, caseId, title, fields, sections[{key, body}], citationIds[], version, createdAt, updatedAt}`. An archived case gets the same 400 rule used elsewhere.

**Linter**

- **ai.v1**
  - `GET /ai/v1/lint/rulesets`
  - `POST /ai/v1/lint` takes `{documentType: bail_application | plaint, text}` and returns `{rulesetId, rulesetVersion, inputSha256, findings[]}`.
  - Each finding: `{ruleId, kind: missing_section | missing_particular | structure, severity, message, span?{start, end}, source{provision, reference} | null}`. A `null` source is shown as "no rule source identified" (FR-LINT-2).
  - Returning `inputSha256` lets callers prove the input was left unchanged (FR-LINT-3).
- **api.v1**
  - `POST /lint-reports` `{documentType, text, caseId?, draftId?}` runs the linter and stores the report (FR-CASE-5).
  - `GET /lint-reports?caseId=` and `GET /lint-reports/{reportId}`.
  - `draftId` is recorded only as a link back to the draft. The text is always sent inline, so this track never depends on Track D's tables.

Verification for this phase:

- `npx @redocly/cli lint packages/contracts/openapi/*.yaml` passes.
- `pnpm gen:contracts` leaves no diff.
- The api and web typechecks pass.
- CI `ci-ok` is green.

## Phase 1: the three tracks

Each track is one subagent working in an isolated worktree (`isolation: "worktree"`). It follows TDD (red→green) and opens its three PRs in order: ai → api → web. Each PR goes up only once that layer's own checks pass. I review each PR before asking you to approve the merge (memory: merges need approval).

### Track P: precedent search (ai: graph + search · api · web #106)

- **ai**
  - Alembic `0002_graph` adds `corpus.graph_entities` and `corpus.graph_edges` exactly as PRD §9.1 specifies. Both also go in `db/tables.py`; `tests/test_migrations.py` keeps them in step.
  - New `caseguard_ai/graph/`:
    - `build.py` builds edges from `raw.cited_cases`, `raw.cited_laws` and `raw.connected_cases`. Citations are resolved against `corpus.documents.citation` using the collector's `CITATION` regex (`services/collector/extractors/metadata_extractor.py`), ported rather than imported, because collector is a separate package.
    - Every edge carries provenance: `extraction_method` is `metadata` or `regex`, plus a confidence.
    - `OVERRULES` edges come only from explicit metadata (PRD §9.2).
    - The build is idempotent and runs through the `pnpm ai:graph-build` CLI.
    - `traverse.py` uses recursive CTEs with depth ≤ 2.
  - New `caseguard_ai/precedents/search.py` builds on `retrieval/hybrid.py::retrieve()` (no new retriever):
    - Keep judgment chunks only, then group them by document. These hits are `retrieved`.
    - Expand one hop through `CITES_JUDGMENT`, `CONNECTED_CASE` and shared `CITES_SECTION` edges. These hits are `graph_derived`, with `via` set.
    - Flag any judgment with an incoming `OVERRULES` edge.
    - The router goes in a new `api/precedents.py`, mounted with a single line in `api/v1.py` or `main.py`.
  - Tests use synthetic judgments: the graph build test covers FR-GRAPH-1, and a "graph-derived hit is labelled" test covers FR-PREC-3.
- **api** (`src/precedents/`):
  - Typed calls in `clients/ai.ts` with zod schemas in `clients/ai-schemas.ts`, the same way research does it.
  - Routes, an audit write, and `expectContract` tests.
- **web** (#106):
  - `src/components/precedents/`: search box with filters, a results list with an `origin` badge (retrieved / graph-derived), flag chips, and a relationships panel showing provenance and status.
  - Reuse `components/research/trust-details.tsx` and `citation-chip.tsx` so flags and statuses look the same everywhere (FR-TRUST-10).
  - Replace `src/app/[locale]/(app)/precedents/page.tsx`. Strings go in `messages/en.json` and `ur.json`.

### Track D: drafting studio (ai · api · web #107)

- **ai**
  - New `caseguard_ai/drafting/`:
    - Template definitions in `templates/*.yaml`. The bail application covers s.497 and s.498 CrPC, the plaint follows Order VII CPC, and there is a legal notice.
    - `assist.py`: retrieve → `gateway.chat("generation")` with a new `prompts/draft_section_v1.py` → `parse_reply` → trust checks → store.
  - **Refactor first:** move the per-marker verify-and-store loop out of `research/answer.py` into a shared `trust/verify.py`, so research and drafting run the same checks. The research tests must stay green, and FR-TRUST-10 holds because there is still one store.
  - Drafting requests write an `ai.answer_traces` row with the drafting prompt version, so `ai.citations.request_id` still has its foreign key, and FR-TRUST-12 is met.
  - If a `kind` column is needed, it comes as Alembic migration `0003_trace_kind`, numbered against whatever has merged by then.
- **api**:
  - Drizzle migration `0014_drafts` (with `.down.sql`) adds `app.drafts`.
  - `src/drafts/store.ts` uses a version column for optimistic concurrency.
  - Fields are filled from the case in `cases/store.ts` data, using each template's `caseField` mapping.
  - Assist goes through the ai client with the user's allowed providers and key (ADR-0009).
  - Export uses `docx` (new dependency) and `pdfkit` (new dependency). Each citation is exported with its stored status.
- **web** (#107):
  - `/drafting` first shows a template picker and an optional case picker (reuse `research/case-picker.tsx`).
  - The editor is sectioned plain `<textarea>`s, with no rich-text library.
  - Each assistable section gets an "Assist" button. Citation chips are rendered from the markers (reuse `research/markers.ts`).
  - Save (handles 409), export, and a drafts list.
  - The case dashboard gets a drafts link (FR-CASE-4). If needed, the dashboard's Drafts tile is wired up too (#104 note).

### Track L: linter (ai · api · web #108)

- **ai**
  - New `caseguard_ai/linter/`:
    - Rule sets `rules/bail_application.yaml` and `rules/plaint.yaml`. Each rule has an id, a kind, the heading or particular patterns to detect, a severity, and its source provision (e.g. "s.497 CrPC", "Order VII r.1 CPC"), or null.
    - `engine.py` is pure and deterministic, with no DB and no LLM. It takes `text: str` and returns findings, and never mutates the input.
  - Tests:
    - A seeded-defect fixture per rule produces exactly that rule's finding (FR-LINT-1).
    - The input's sha256 is unchanged after linting (FR-LINT-3).
    - Every rule either has a source or explicitly has none (FR-LINT-2).
  - Bail application rules come first, then plaint (PRD M3).
- **api**:
  - Drizzle migration `0015_lint_reports` adds `app.lint_reports` (owner, case, draft link, type, text, sha256, findings jsonb, ruleset version).
  - Routes and `expectContract` tests.
- **web** (#108):
  - `/linter` has a document type picker, a paste box or `.txt` upload, and a findings list grouped by kind.
  - Each finding shows its rule-source chip or "none identified". Clicking a finding highlights its span in a read-only view.
  - "Save to case" stores the report, and the case dashboard links lint reports.

## Parallel-safety rules (given to every agent)

- **Shared files: append only.**
  - These are: `apps/api/src/app.ts` (one router line), `services/ai/.../api/v1.py` or `main.py` (one `include_router`), `messages/en.json` and `ur.json` (each track uses its own top-level key: `Precedents`, `Drafting`, `Linter`), the nav, `CHANGELOG.md`, and `docs/engineering/work-log.md`.
  - Whoever merges second rebases and resolves the conflict.
- **Migration numbers are reserved:**
  - app: `0014` drafts (D), `0015` lint_reports (L)
  - alembic: `0002` graph (P), `0003` only if Track D needs one
  - If merges happen out of order, the later branch renumbers and regenerates the Drizzle `meta/_journal.json`.
- **Planned merge order:** contracts → L (smallest) → D → P (largest, and it adds the graph). An earlier merge is fine as long as the later branches rebase.
- **No track edits another track's modules.** The `trust/verify.py` refactor belongs to Track D. Track P only reads the trust flag enum.

## Phase 2: integration (me)

- Lint a draft: the drafting screen gets a "Lint this draft" button that sends the draft's text and `draftId`. This is a small web PR made after both D and L have merged.
- Mark A12 done in `stream-a-roadmap.md`, update the 10 plan status lines, and close #106, #107 and #108. Merged branches are kept (memory).

## Verification

- **Per layer:**
  - ai: `uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest`, with `AI_TEST_DATABASE_URL` pointed at the Docker DB on port 5433 (memory: local env).
  - api: `pnpm --filter ./apps/api run typecheck lint test`.
  - web: `pnpm --filter ./apps/web run typecheck lint test`, plus `next build` (memory: `cacheComponents` dynamic routes need Suspense).
- **End to end:**
  - Bring up the stack with `docker compose up`, load the sample corpus, and run `pnpm ai:graph-build`.
  - Search for a precedent and see both retrieved and graph-derived badges and the relationships panel.
  - Create a bail draft from a case, assist a section, and check that its citation statuses match what `getCitation` returns (FR-TRUST-10).
  - Export the draft as DOCX and PDF.
  - Lint a seeded-defect bail application, see the expected findings with their sources, and save the report to the case.
- CI `ci-ok` is green on all 10 PRs.

## Issues created

#209 contracts · #210 graph + precedent search (ai) · #211 precedent API · #106 precedent web · #212 drafting (ai) · #213 drafts (api) · #107 drafting web · #214 linter (ai) · #215 lint reports (api) · #108 linter web. Track plans: 0053-0061.
