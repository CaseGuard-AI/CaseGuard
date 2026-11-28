> **Status:** In review · **Issue:** [#152](https://github.com/CaseGuard-AI/CaseGuard/issues/152) · **PR:** [#255](https://github.com/CaseGuard-AI/CaseGuard/pull/255)

# #152: corpus snapshot push/pull/status (`data:push`, `data:pull --snapshot`, `data:status`)

## Context

Crawls were shared by hand-uploading tars to `caseguard/corpus` (session-handoff.md), with no manifest, no checks and nothing to pull them back with. This builds the snapshot half of data-storage.md §3, §5 and §7, following handoff-plan.md §5. The dump half (#154) already exists in services/ai; its patterns (`CorpusHub`, `Manifest`, `verify_dump`) are copied, not imported, so the two services stay independent.

## Plan

1. **`services/collector/snapshots/`** (`python -m snapshots push|pull|status`), with `huggingface_hub` added to the collector only:
   - `manifest.py`: identity (format, partition, folder, publisher), provenance (git commit + dirty flag of `services/collector`, the partition preset, run ids and runs from `state.db`, the newest run's selection file, SHA-256 and source snapshot), counts (by source, `document_type`, `matter_type`, `extraction_status`, head-note-only, third-party, files) and bytes + SHA-256 per file. `verify_snapshot` rechecks the checksums and recounts the records.
   - `pack.py`: `records.jsonl.gz` from the combined `documents/<source>.jsonl` (dated per-run copies left out; the newest line per id wins; `file_path` made partition-relative so no local path leaves the machine; deterministic gzip), `state.db` via the SQLite backup API (journal mode DELETE, one file), uncompressed `files.tar` of `raw/` + `text/` with forward-slash names (left out when empty). `unpack` lays it back out, extracting the tar with `filter="data"` and refusing entries outside `raw/`/`text/`, and writes `snapshot.json`.
   - `gate.py`: reports every problem: checksum or count mismatch, dirty or unknown git tree, secret-looking files, files the collector wouldn't write (wrong folder or extension, `uploads/`), token or private-key shapes in the records (never echoed), `hf_*` records in a normal partition or normal records in a bootstrap one.
   - `hub.py`: `next_folder` picks `<date>[-N]`, treating any existing file in a folder (hand uploads included) or the tag as taken; `publish` is one commit with `parent_commit` plus tag `snap/<p>/<folder>`; `folders` lists only folders with a manifest; `resolve`, `download` at the tag; `inventory` for status.
   - `pull.py`: resolve, download the manifest, then records + state (+ `files.tar` only with `--with-files`), verify, refuse a non-empty partition without `--yes`, unpack.
   - `status.py`: snapshots per partition, dumps and `LATEST`, usage vs 100 GB with the corpus-v2 warning from 75 GB, local partitions and where they came from.
2. **`scripts/data.mjs`**: routes `push`/`pull --snapshot` to the collector, `pull --dump`/`dump` to services/ai, `status` to both (the loaded corpus comes from services/ai's own `corpus_summary`/`describe`, run with `python -c`, so no services/ai code changes). `spawnSync("uv", ...)` without a shell; `--dry-run` prints the commands. Root `data:pull`, `data:push`, `data:status`.
3. **Tests** (`tests/test_snapshots.py`, offline, fake `HfApi`): manifest contents, pack layout, dedup, every gate refusal, pack→pull→pack round trip, files.tar skipped by default, clobber refusal, tar entry check, `-N` folders, never-overwrite, a hand-uploaded folder, resolve, status and the 75 GB warning.
4. **Docs**: data-storage.md status and §7, session-handoff.md upload/download steps, PARTITIONS.md, `.env.example` comment, CHANGELOG.

## Not done here

- The first real `data:push` of each partition: the owners do that (the 2026-11-10 hand-uploaded tars have no manifest and aren't pullable).
- Matching the loaded corpus to a dump folder: `data:status` shows the loaded corpus's summary (counts, model, built at, input snapshots), as `data:pull --dump` does.

## Review fixes (PR #255)

1. `push` clears its own staging folder (`.snapshots/<p>/<folder>`) first, so a refused, declined or `--no-upload` push doesn't block the next one. An explicit `--out` that isn't empty is still refused.
2. `unpack` builds the new layout in a temporary folder next to the partition and swaps `documents/`, `state/` (and `raw/` + `text/`) in whole, so a refusal leaves the partition untouched.
3. Swapping `state/` whole drops an old `state.db-wal`/`-shm`, which SQLite would otherwise replay onto the new database.
4. Only folders with a manifest and their `snap/<p>/<folder>` tag are pullable. `publish` first tags any untagged folder at `main` (safe, since published folders never change), and `data:status` marks them.
5. `pull` checks `--yes` before resolving or downloading anything.
6. The gate refuses a record whose `file_path` is still absolute after packing.
7. `push --date` is checked on every path.
8. Connection and timeout errors (httpx2, httpx, requests) print one line and exit 1.
