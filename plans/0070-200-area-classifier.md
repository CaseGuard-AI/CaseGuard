> **Status:** In progress (code in review; the 200-judgment hand review and the 85% bar remain with the team) · **Issue:** [#200](https://github.com/CaseGuard-AI/CaseGuard/issues/200) · **PR:** draft into `staging`

# Statute→area classifier, taxonomy v1

## Context
Taxonomy v1 (#164, `packages/contracts/taxonomy/case-taxonomy.v1.yaml`) defines the areas of law and the `statute_rules`. `corpus.documents.area` and `subcategory` have existed since migration 0001 but nothing filled them. `docs/engineering/case-taxonomy.md` §5 sets the rules (deterministic, statutes strongest, operative part over precedent mentions, keywords only as a tie-break, otherwise `unclassified`, no LLM), and §6 sets the review (about 200 stratified judgments, precision and recall per area, the unclassified rate, an 85% bar).

## Constraints
- No migration, no new columns, no change to `db/tables.py`. Write `area` and `subcategory`, and keep evidence, confidence and `taxonomy_version` under `raw.area_label` (a jsonb merge, so other raw keys are kept).
- The shape of the taxonomy YAML stays as it is. No new dependencies. Root `package.json` gets one script, `ai:classify-areas`.
- Two other tracks run in parallel: #253 (ingestion routes, migration 0003, `ingest/`, `db/tables.py`) and #152 (snapshots, `scripts/data.mjs`). Stay out of their files.

## Steps
1. `caseguard_ai/taxonomy/rules.py`: load the YAML into typed rules, validated. A section comparator `section_key("338-H") == (338, "H")` handles inclusive PPC ranges with lettered sections. The file is found from the repo root or `services/ai`, or from `CASEGUARD_TAXONOMY` / `--taxonomy`.
2. `taxonomy/classify.py`: a pure `Classifier.classify(text, headnote, cited_laws, headnote_only) -> AreaLabel`.
   - Section lists before a code ("ss. 302, 324/34 PPC") are mapped by range.
   - Other statutes are matched by name and short forms (CNS Act, ATA, SRPO...), in the text and in `raw.cited_laws`.
   - Procedural law is evidence only.
   - Weights: a reference within 150 characters of a law-report citation or case-law wording counts as a precedent (0.25). One in the opening or closing 1,500 characters, or next to offence or relief wording, is operative (2.0). Head-note 1.5, cited_laws 1.0, body 1.0.
   - Each statute rule (Act or PPC range) scores once at its strongest. The winner needs a score of at least 1.0 and 1.5× the runner-up.
   - Keywords give +0.5 each, only for areas within 1.5× of the leader. The tie is broken only if the new leader has keyword hits of its own and then has a 1.5× lead.
   - The leader needs a reference that is not a precedent mention. A head-note reference is always `headnote` weight. The relief cue is "relief sought/claimed/prayed", and the reference itself is left out of the context check.
   - The loader (`ingest/load.py`) keeps `raw.area_label` on upsert and ignores it when deciding whether a row changed, so a reload neither drops labels nor rewrites every labelled row (#257 review).
   - Otherwise `unclassified`, keeping the evidence and the leader's confidence.
   - Head-note-only records are labelled from the head-note, or `unclassified` without one.
   - PPC sub-category hints (homicide, hurt, theft...) apply only inside the area the rule gives.
3. `taxonomy/cli.py`, run as `python -m caseguard_ai.taxonomy.classify`:
   - Keyset batches over judgments; writes only rows whose label changed, so it is idempotent.
   - `--dry-run` prints the distribution.
   - `--sample N --out` writes a CSV stratified round-robin by proceeding type, then bench (seat), with blank gold columns.
   - `--score` prints the per-area precision and recall table and the bar. `taxonomy/review.py` holds the pure sample and score logic.
4. Tests (`tests/test_area_classifier.py`): table-driven classifier cases, sample and score, and one DB test (skipped without `AI_TEST_DATABASE_URL`) showing the write keeps other raw keys and a re-run writes nothing.
5. Docs: `case-taxonomy.md` §6.1 (sample → label → score), this plan, CHANGELOG, draft PR (Part of #200).

## Verification
- `uv run pytest` in services/ai, plus `ruff check`, `ruff format --check` and `mypy` as CI runs them. The DB test ran against Docker Postgres with pgvector on 5433.
- `pnpm ai:classify-areas --dry-run` on the dev corpus. The distribution is in the PR.

## Left for the team
- Run `--sample 200`, hand-label it, `--score`, and put the table in the final report. Switch area filters on only if the bar is met.
- Tune the named constants or add statutes to the YAML (an additive edit) from what the review shows.
