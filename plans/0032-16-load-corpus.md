> **Status:** In progress · **Issue:** [#16](https://github.com/CaseGuard-AI/CaseGuard/issues/16) · **PR:** [#163](https://github.com/CaseGuard-AI/CaseGuard/pull/163)

# #16: load the collector's JSONL into `corpus.documents`

## Context

This is handoff critical-path item 6, the first link in "load → embed → retrieve → answer". It needs the #15 tables, so this branch is based on `feature/ai-alembic-corpus-schema`: **merge after #160**. It uses #147's `raw.headnote_only` flag when it's present.

**Requirements:** NFR-1 (provenance), PRD §15, collector README §10.4 (head-note-only records), ADR-0002 (caseguard_ai writes corpus).

## Decisions

- **The loader lives in services/ai** (`caseguard_ai.ingest.load`), next to the table definitions it writes, and runs as `caseguard_ai`. Exposed as `pnpm data:load`.
- **Inputs:** collector output dirs (`documents/<source>.jsonl`; dated per-run copies skipped) or JSONL/JSONL.gz files. The `.gz` form is the snapshot format of #152.
- **Upsert keyed on `collector_id`.** A row is updated only when something meaningful changed (`IS DISTINCT FROM` over the hash, title, URL, flags, snapshot, raw), so re-runs report `unchanged`.
- **Dedup on `content_hash`**, both within a batch and against the DB. The same text under another id is counted as `duplicate text` and not stored twice.
- **Never downgrade:** a head-note-only record never replaces a stored full judgment (`kept full text`). This is enforced both in Python and in the upsert's `WHERE`.
  - *Found by running it on real data:* the 18k-record metadata pass replaced the 5 judgments that already had full text.
- **`kind`:** an `order` from a legislation source is a statute.
  - *Found on real data:* "Acceding State (Property) Order, 1961" had been loaded as a judgment.
- **Skips, never half-loads:** under 40 characters of text, no source URL, no id. Each is counted with a reason.
- **`decided_on`** is set for judgments only. `third_party` / `source_tier = 2` for `hf_*` records.
- **Taxonomy columns stay empty** until the taxonomy is agreed (`docs/engineering/case-taxonomy.md`, PR #161).

## Verification

- `ruff`, strict `mypy` and `pytest` are clean. `tests/test_load.py` covers:
  - kinds, provenance and dates, the third-party label, the head-note flag and the older note;
  - skip reasons, and directory reading without the dated copies plus `.gz`;
  - DB: idempotent re-run, update on change, dedup within a batch and against the DB, the never-downgrade guard and the upgrade path, skips not written, dry run.
- **Mutation check:** with the downgrade guard removed, its test fails (`kept_full_text 0 == 1`).
- **Real data** (scratch DB):
  - the live `--limit 5` output: 10 inserted (5 statutes, 4 full judgments, 1 head-note-only);
  - then the 18,027-record SHC metadata pass: 18,022 inserted, 4 full judgments kept, in about 23 s;
  - a second run: 18,023 unchanged.
