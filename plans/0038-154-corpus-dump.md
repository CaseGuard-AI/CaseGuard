> **Status:** Done · **Issue:** [#154](https://github.com/CaseGuard-AI/CaseGuard/issues/154) · **PR:** [#174](https://github.com/CaseGuard-AI/CaseGuard/pull/174)

# #154: corpus dump build and restore (`data:dump`, `data:pull --dump`)

## Context

Embedding the full corpus takes about 8 hours on CPU. Until now the only way to share the result was a hand-made `pg_dump`, which the handoff called fiddly to restore: the tables must be emptied first and the migrations must match. This builds the two commands from `docs/engineering/data-storage.md` §4 and §7, so one person embeds and everyone else pulls. It needs no corpus to build, and touches no collector code, while the crawler work goes on in parallel.

## Decisions

- **Python `COPY`, not `pg_dump`.** Postgres is pg17 in Docker; neither Windows hosts nor the CI runner have a matching `pg_dump`. `COPY … (FORMAT binary)` through psycopg needs no client binary, runs as `caseguard_ai` (the ADR-0002 roles stay intact), and is tested in CI against the scratch database.
- **Format.** `corpus.dump` is an uncompressed tar holding one gzip-compressed binary COPY per table: `corpus_meta`, `documents` and `chunks`. The generated `chunks.tsv` is left out and rebuilt by Postgres. `manifest.json` records the Alembic revision, the `corpus_meta` row, the copied columns, the row counts, the SHA-256 and the git provenance.
- **Build refuses:** an empty corpus, a corpus never embedded, an unfinished embed run (`built_at` null), or any chunk without a vector. Every table is read in one `REPEATABLE READ` transaction.
- **Restore checks before it acts.** In order:
  1. the checksum;
  2. the Alembic revision (refused on a mismatch: run `pnpm db:migrate:ai`);
  3. the table columns;
  4. it shows the loaded and the incoming corpus, and asks.

  Then it does `TRUNCATE` plus `COPY` in one transaction, and the row counts must match the manifest. `app` and `ai` are never touched. The model check after a restore is the existing `retrieval/guard.py`.
- **Hugging Face** (`ingest/hub.py`, over `HfApi`; a fake in tests):
  - `dumps/<date>[-N]/` is never overwritten (`-2`, `-3`, … on the same day);
  - the folder, its files and `dumps/LATEST` go up in **one commit**, with `parent_commit` so a concurrent publish is refused;
  - tags: `dump/<folder>`, plus `dump/eval-frozen-<n>` with `--freeze`, which is refused if the tag already exists;
  - resolving: `latest` reads `LATEST`, and `eval-frozen-<n>` reads `LATEST` at that tag; downloads are always pinned to the immutable tag.
- **Safety:**
  - `data:dump` asks before publishing, unless `--yes`;
  - `data:pull` asks before replacing, unless `--yes`;
  - Hugging Face errors give a one-line message;
  - the token is never printed.
- `DumpRefused` lives in `ingest/errors.py`: run with `-m`, `dump.py` is `__main__`, and a class defined there would differ from the one `hub.py` raises (found in the CLI smoke test).

## Files

- New:
  - `services/ai/src/caseguard_ai/ingest/dump.py`, `hub.py`, `pull.py`, `errors.py`
  - `services/ai/tests/test_dump.py`
- Edited:
  - `config.py` (`HubSettings`: `HF_TOKEN`, `HF_CORPUS_REPO`)
  - `pyproject.toml` / `uv.lock` (`huggingface-hub`)
  - root `package.json` (`data:dump`, `data:pull`), `.env.example`, `.gitignore`
  - docs: services/ai README, session handoff, work log, CHANGELOG

## Verification

- `uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest`: 190 passed. The one skip (`test_ready`) was already there.
  - The run used a scratch pgvector pg17 bootstrapped with `infra/db/sql/bootstrap.sql`, like CI.
- The tests cover:
  - the round trip (identical rows, `tsv` regenerated);
  - replacing a corpus, a declined confirm, and restoring into an empty DB;
  - the revision gate, a tampered checksum, and a model mismatch after a restore;
  - the build refusals, and the dump holding only corpus tables;
  - the hand-made `pg_dump` refusal;
  - the hub's never-overwrite rule, `LATEST`, tags, freeze, resolution and download.
- CLI smoke test on the scratch DB:
  - `data:dump --no-upload --out …`, then `data:pull --from …` with y and with n;
  - a bad `--freeze`, a bad `--dump`, and a real HF 404 (read-only) all exit cleanly.
- **Not done:** a real upload to `caseguard/corpus`. That waits for the finished embed and the integrator.
