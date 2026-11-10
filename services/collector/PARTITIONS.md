# Partitions

The registry of crawl partitions ([data-storage.md §2](../../docs/engineering/data-storage.md#2-partitions), [#140](https://github.com/CaseGuard-AI/CaseGuard/issues/140)). Each partition has **one owner at a time**, and only the owner crawls and publishes it. To take one over, pull its latest snapshot (with `state.db`), put your name below in the same PR as your first change, and carry on from where it stopped.

| Partition | Source | Bounds | Selection file | Owner | Latest snapshot |
|---|---|---|---|---|---|
| `pk-code-seed` | `pakistan_code` | Seed statutes (PRD §15.3), their amendment acts, the Constitution and its amendment acts; with PDFs | [`selections/pk-code-seed.txt`](selections/pk-code-seed.txt) (title patterns) | — | — |
| `shc-meta` | `shc_caselaw` | Every judgment on every judge's full listing (`scope=all`), **metadata only** | — | — | — |
| `shc-criminal` | `shc_caselaw` | Files for the criminal judgments in the selection | `selections/shc-criminal.csv` (not generated yet) | — | — |
| `shc-civil` | `shc_caselaw` | Files for the civil judgments in the selection | `selections/shc-civil.csv` (not generated yet) | — | — |
| `scp`, `ihc`, … | | Added later the same way | | | |

## Running one

```bash
uv run python main.py --list-partitions
uv run python main.py --partition pk-code-seed
uv run python main.py --partition shc-meta
uv run python main.py --partition shc-criminal --limit 200   # a first batch
```

- Each partition writes to its own directory, `data/partitions/<name>/` (with `documents/`, `raw/`, `text/`, `state/state.db`), so it can be snapshotted on its own (#152).
- **Set `PKLEGAL_USER_AGENT` to a real team contact address before a full crawl.**
- Each run records the partition, the selection file, its SHA-256 and the source snapshot in `state.db`'s `runs` table, for the snapshot manifest.
- Selected items that were never found are logged at the end of the run (`selection_missing` event).
- On Windows, keep the output path short (the default under the repo is fine). File names carry up to 90 characters of the title, and Windows paths stop at 260 characters.

## Selection files

`shc-criminal.csv` and `shc-civil.csv` are generated from an `shc-meta` crawl and **committed**, so everyone fetches the same judgments:

```bash
uv run python tools/make_selection.py --from data/partitions/shc-meta \
    --partition shc-criminal --n 3000 --source-snapshot shc-meta@<date>
```

- Each SHC case type is looked up in [`selections/matter_type_map.csv`](selections/matter_type_map.csv), the code map from [case-taxonomy.md §4](../../docs/engineering/case-taxonomy.md#4-shc-case-type--proceeding-type-all-57-codes).
  - Only codes on the partition's branch are eligible.
  - Constitutional petitions (`either`: the branch depends on the subject) and codes missing from the map are left out and counted, never guessed.
  - `confirmed = no` marks the codes whose reading the taxonomy asks the supervisor to confirm (#164). They're kept, and the selection notes them.
- Judgments without a linked file are left out.
- The sample is stratified by case type × year, with seats in proportion to each stratum's size. The same input, map, `--n` and `--seed` always give the same file.
- The `#` lines at the top record the source snapshot, map checksum, seed and counts. The collector reads `source_snapshot` back into the run metadata.
- The default size is 3,000 per branch (PRD §15.3 says "start with about 3–5k"). How many civil judgments SHC really has is tracked in #148. The taxonomy sample found 1,987 eligible civil judgments among 18,027.
