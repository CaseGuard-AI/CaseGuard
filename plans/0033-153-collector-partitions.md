> **Status:** Done · **Issue:** [#153](https://github.com/CaseGuard-AI/CaseGuard/issues/153) · **PR:** [#165](https://github.com/CaseGuard-AI/CaseGuard/pull/165)

# #153: collector partitions, selection files and PARTITIONS.md

## Context

Handoff critical-path item 4. The crawl is split into partitions (data-storage.md §2, #140) so that each can be crawled, owned and snapshotted (#152) on its own. #147 made the live sites work, so this is now unblocked. The taxonomy proposal (case-taxonomy.md §4, #164) supplies the SHC case-type map that the selection generator needs.

## Decisions

- **`--partition <name>`** applies a preset from `partitions.py`: the source, the SHC scope, PDFs on/off, the selection, and an output dir of `<output>/partitions/<name>/`.
  - `--source` must agree with the preset or be left out.
  - `--output-dir` overrides the dir as is.
- **Selections only filter what is processed.** They never change parsing, so they live in `BaseScraper.run`:
  - non-matching items are counted as `not_selected` and never fetched;
  - discovery stops once every selected id has been found;
  - ids that never turned up are logged and emitted as `selection_missing`.
- **`pk-code-seed`** uses a committed list of title regexes (`selections/pk-code-seed.txt`) that match the 7 seed statutes and the Constitution. Pakistan Code lists no separate amendment acts: each text is the consolidated version with amendments marked.
- **SHC selections are keyed on the collector document id.**
  - It's `make_id()` over the discovered URL (the `doc=` download link), so it's known before any fetch.
  - It's identical to the id stored by `shc-meta`, so #16's loader upgrades the head-note-only row to the full judgment.
- **`selections/matter_type_map.csv`** holds all 57 codes from case-taxonomy.md §4: proceeding type, branch (`criminal|civil|either`) and `confirmed`.
  - Constitutional petitions are `either`, and are excluded until the area classifier exists.
  - It was checked against the 18,027-record crawl: nothing unmapped and nothing unused.
- **`tools/make_selection.py`:**
  - only judgments on the branch, with a linked file;
  - stratified by case type × year with largest-remainder seats;
  - deterministic for a given input, map, n and seed;
  - `#` header lines carry the source snapshot, which the collector records.
- **Run metadata:** `runs` gains `partition`, `selection_file`, `selection_sha256` and `source_snapshot`. Older `state.db` files get the columns added on open.
- **SHC scope** can now come from settings (`Settings.shc_scope`), so a partition doesn't depend on the environment. `PKLEGAL_SHC_SCOPE` still works.

## Not in this PR

- **The full crawls.** They need `PKLEGAL_USER_AGENT` set to a team contact address first (handoff, human item).
- **Committing the real `shc-criminal.csv` / `shc-civil.csv`.** They should be generated from the first published `shc-meta` snapshot, and after the supervisor answers the taxonomy questions (#164).

## Verification

- `ruff` is clean, and `pytest` gives 170 passed (33 new in `tests/test_partitions.py`):
  - the seed list's matches and misses;
  - a selection run that stores only the listed ids, under the same ids, and stops early;
  - missing ids reported, wrong-source ids refused;
  - the CLI presets and refusals; run metadata and the old-`state.db` migration;
  - the generator's exclusions, proportional seats, determinism, and a read-back round trip.
- **Live:**
  - `--partition shc-meta --max-pages 1 --limit 40`: 40 records, and a re-run continues;
  - a 2-judgment civil selection made from it, then `--partition shc-civil --selection …`: 2 PDFs downloaded, 73 rows not selected, early stop, metadata recorded;
  - `--partition pk-code-seed --limit 3`: the Code of Civil Procedure, the CrPC and the Contract Act stored with full PDF text. The 140 other index entries were never fetched.
- **On real data:** the generator over the 18,027-record crawl gives 1,987 eligible civil and 7,857 eligible criminal judgments, with the same output every run.
