> **Status:** In progress · **Issue:** [#164](https://github.com/CaseGuard-AI/CaseGuard/issues/164) · **PR:** [#201](https://github.com/CaseGuard-AI/CaseGuard/pull/201)

# #164: case taxonomy v1 (approved)

## Context

The supervisor approved [`docs/engineering/case-taxonomy.md`](../docs/engineering/case-taxonomy.md) on 2026-11-18 and accepted §9 questions 1–6 as recommended. Question 7 (the four `(confirm)` SHC codes: I. A, S.M.A, M.A, J.M) is still open. `services/collector/selections/matter_type_map.csv` was already committed with #153. What was missing is the shared vocabulary file the doc promises in §8, so it can't drift from the doc or the CSV.

The third checkbox of #164 (statute→area classifier + 200-judgment review) is real work of its own and moved to [#200](https://github.com/CaseGuard-AI/CaseGuard/issues/200). That lets #164 close on this PR.

## Decisions

- **`packages/contracts/taxonomy/case-taxonomy.v1.yaml`** holds `version`, `branches`, `areas` (id, branch, seed, subcategories, anchor_law), `proceeding_types` (id, branch, subtypes) and `statute_rules` (statute, optional PPC `sections: {from, to}`, area, optional subcategory). It holds exactly what the doc says, with snake_case ids.
- **`transfer` is `either`**, because the SHC codes split it (Cr.Tran criminal, Civil Tran civil). `constitutional_petition` is `either` (its branch comes from the area). `unclassified` has `branch: null`.
- **Procedural statutes** (CrPC, CPC, QSO, Limitation Act) map to `area: procedure`. That is a marker that they never decide an area, not an area itself (doc §3.1).
- **The consistency test lives in services/ai** (`tests/test_case_taxonomy.py`). services/ai already has `pyyaml` and owns the `corpus.documents.area/subcategory/proceeding_type` columns. The test checks that ids are unique and snake_case, the 9/11/19 counts, that the rules point at real areas and sub-categories, and that every CSV row uses a known proceeding type on a compatible branch.
- **Growing the lists:** sub-categories can be added in v1. A new, renamed or removed area or proceeding type is a v2 file and a re-label (doc §6).
- The CI Redocly lint globs only `openapi/*.yaml`, so the new folder needs no CI change.

## Files

- new `packages/contracts/taxonomy/case-taxonomy.v1.yaml`, `services/ai/tests/test_case_taxonomy.py`
- `docs/engineering/case-taxonomy.md`: approved status, §9 decision column, §10 links
- `packages/contracts/README.md`, `CHANGELOG.md`, `docs/engineering/session-handoff.md`, `docs/engineering/work-log.md`

## Verification

- `uv run pytest tests/test_case_taxonomy.py` passes (5 tests). ruff, ruff format and mypy are clean.
- CI `ai · ruff, mypy, pytest` and `ci-ok` are green.
