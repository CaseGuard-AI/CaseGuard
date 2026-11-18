# Data storage

Where CaseGuard's data lives, so that **one person crawls and embeds, and everyone else just pulls**.

> **Status:** decided 2026-11-09 in the wayfinder map [#137](https://github.com/CaseGuard-AI/CaseGuard/issues/137). The commands below are **planned**: they don't exist until their build issues land. Terms (partition, corpus snapshot, corpus dump, integrator, user upload) are defined in [`CONTEXT.md`](../../CONTEXT.md).

## At a glance

| Data | Who can see it | Where it lives | How you get it |
|---|---|---|---|
| **Corpus snapshots**: collector output per partition | Team + supervisor | Private Hugging Face dataset `caseguard/corpus`, `snapshots/` | `pnpm data:pull --snapshot <partition>` |
| **Corpus dump**: the loaded, embedded `corpus` schema | Team + supervisor | Same repo, `dumps/` | `pnpm data:pull --dump latest` |
| **User uploads**: case files | **Only their owner, inside their case** | Dev: Docker volume `uploads`. Demo: S3-compatible storage (Supabase preferred) | Through the API only |
| `app` and `ai` schemas | Each laptop only | Your local Postgres | Never shared |

**New member, day one:** run migrations, then `pnpm data:pull --dump latest`. You have a working Research Hub corpus without crawling or embedding anything.

## 1. Storage: Hugging Face

- **Repo:** one **private dataset repo** in a **free Hugging Face organization** (100 GB private storage, no card). Decided in [#142](https://github.com/CaseGuard-AI/CaseGuard/issues/142).
- **Roles:**

  | Who | Role |
  |---|---|
  | Repo lead (Rebelhere) | `admin` |
  | Other members | `write` |
  | Supervisor | `read`, if he wants access |

- **Credentials:** each person creates their **own free access token** and puts it in their own `.env` as `HF_TOKEN=...`.
  - Students' tokens: write scope. The supervisor's: read-only.
  - Never commit a token. Never share one.

```
caseguard/corpus
├── snapshots/
│   └── <partition>/<YYYY-MM-DD>[-N]/
│       ├── manifest.json
│       ├── records.jsonl.gz
│       ├── state.db
│       └── files.tar
└── dumps/
    ├── LATEST                       ← the only file ever overwritten
    └── <YYYY-MM-DD>[-N]/
        ├── manifest.json
        └── corpus.dump
```

**Tags:**
- `snap/<partition>/<date>` for every snapshot;
- `dump/<date>` for every dump;
- `dump/eval-frozen-<n>` for the dumps behind evaluation results.

**A published folder is never changed or deleted. Fix a mistake by publishing a new version.**

## 2. Partitions

The crawl is split into **partitions** ([#140](https://github.com/CaseGuard-AI/CaseGuard/issues/140)). Each partition has **one owner at a time**, and only the owner publishes it. There are no fixed owners: whoever picks up a partition's crawl issue owns it, and one person may own them all.

| Partition | Covers |
|---|---|
| `pk-code-seed` | Seed statutes (PRD §15.3), their amendment acts, Constitution articles |
| `shc-meta` | Metadata-only pass of **all** SHC judgments (`PKLEGAL_SHC_SCOPE=all --no-pdfs`). The catalogue to select from. |
| `shc-criminal` | PDFs for criminal judgments selected from `shc-meta` |
| `shc-civil` | PDFs for civil judgments selected from `shc-meta` |
| `scp`, `ihc`, … | Added later the same way |

- **Selection files:** `shc-criminal` and `shc-civil` fetch only what is listed in their committed selection file, `services/collector/selections/<partition>.csv` (case id, matter type, reason), generated from a named `shc-meta` snapshot.
- **Registry:** `services/collector/PARTITIONS.md` records each partition's bounds, current owner and selection file.
- **Handing over:** the new owner pulls the latest snapshot (including `state.db`), updates the registry and carries on crawling from where it stopped.

Whether SHC has enough civil judgments is tracked separately in [#148](https://github.com/CaseGuard-AI/CaseGuard/issues/148).

## 3. Corpus snapshots

Decided in [#141](https://github.com/CaseGuard-AI/CaseGuard/issues/141). A snapshot is a **full copy** of one partition, never a diff.

| File | Contents | Who needs it |
|---|---|---|
| `records.jsonl.gz` | Every record, including `full_text` | The integrator, or anyone loading the DB (about 0.2 GB per 10k judgments) |
| `state.db` | Crawl state | The partition owner, to resume incrementally |
| `files.tar` | `raw/` (original PDFs) and `text/`, uncompressed | Only for re-extraction, OCR or auditing an original (about 2.7 GB per 10k judgments) |
| `manifest.json` | Provenance, counts and checksums (below) | Everyone |

`logs/` and the dated per-run JSONL copies are **not** included.

**`manifest.json`:**

| Part | Fields |
|---|---|
| Identity | format version, partition, date, publisher |
| Provenance | collector git commit and dirty flag; collector settings (sources, scope, years, flags); run ids; selection file and source `shc-meta` snapshot, if any |
| Counts | by source, `document_type`, `matter_type` and `extraction_status`; head-note-only count; third-party count |
| Files | name, bytes and SHA-256 of every file |

The counts double as the corpus-statistics table for the report.

**`data:push` refuses to publish** when:
- a checksum or count doesn't match;
- the collector working tree is dirty;
- it finds anything that looks like a user upload, `.env` or token;
- third-party (`hf_*`) records are mixed into a normal partition. Bootstrap data gets its own partition.

**When to publish:** only meaningful changes. That means about 5% more records, a fix (re-extraction, OCR) or a new selection file, not every crawl.

## 4. Corpus dumps

Decided in [#143](https://github.com/CaseGuard-AI/CaseGuard/issues/143). The **integrator** (the person is decided later; the role is fixed) builds a dump from the latest snapshot of every partition.

- **Scope:** the `corpus` schema only. `app` and `ai` are never dumped.
- **Data-only.** The tables come from our Alembic migrations, and the manifest records the Alembic revision. **Restore refuses if your local revision differs.** Run migrations first.
- **Pinned embedding settings:** the manifest and a small `corpus` metadata table record:
  - the embedding model and exact revision (bge-m3), dimensions and normalisation;
  - chunker version and settings;
  - FTS configuration;
  - the input snapshots (`partition@date`).

  Retrieval **refuses to run** if the query-side model differs from the corpus's.
- **Restore replaces** your local `corpus` schema. It never merges. It shows the dump you currently have and asks before replacing.
- **When:** on demand after partitions publish, **at most about weekly**, plus a frozen dump before the M1 evaluation and before the final evaluation.

## 5. Retention

Decided in [#149](https://github.com/CaseGuard-AI/CaseGuard/issues/149).

- **Keep everything during the FYP.** One full version is about 3 GB of snapshots plus a dump of about 1 GB.
- **Monitor:** `pnpm data:status` reports usage against the 100 GB limit.
- **At 75 GB:** start a fresh `caseguard/corpus-v2`, seeded with the latest snapshot of each partition plus every `dump/eval-frozen-*`. Move `LATEST` there and retire the old repo. History is never rewritten.
- **No off-site copy for now.** Revisit before the final evaluation (Backblaze B2 is the fallback).

## 6. User uploads

Decided in [#145](https://github.com/CaseGuard-AI/CaseGuard/issues/145). It becomes the storage section of #101. User uploads **never** enter a snapshot or dump.

- **Blob-store interface** in `apps/api` (put / get / delete / deletePrefix), with backends selected by `STORAGE_DRIVER`:
  - `fs` for dev and CI. In Compose, a named volume `uploads` at `/data/uploads`: `api` mounts it read-write, `ai` read-only. Native runs use the git-ignored `/uploads` at the repo root (`UPLOADS_DIR`). **Implemented in #101** (`apps/api/src/storage/blob-store.ts`). Files are world-readable inside the volume because `ai` runs as another user; only `api` and `ai` mount it.
  - `s3` for the hosted demo. The provider (Supabase preferred) is decided with demo hosting. Not built yet: a follow-up once hosting is decided.
- **Access:** upload and download go **through the API**, with an ownership check on every request. No presigned URLs in P1.
- **Keys:** `users/{user_id}/cases/{case_id}/{document_id}`. The original filename lives only in the database. Jobs carry `{document_id, user_id, case_id, storage_key}`.
- **Derived chunks and embeddings** live in the private **`ai` schema** (e.g. `ai.case_chunks`), never in `corpus`. That is what keeps the corpus dump public. Retrieval combines the corpus with the active case only (FR-CASE-6).
- **Encryption:** the provider's encryption at rest only, in P1. App-level encryption is a known limitation: revisit if real client files are ever stored.
- **Deletion:**
  - archiving a case keeps its files;
  - deleting a document purges the blob **and** its chunks, through a retryable job;
  - deleting an account (if built) purges `users/{user_id}/`.

## 7. Planned commands

| Command | Who | Does |
|---|---|---|
| `pnpm data:push --snapshot <partition>` | Partition owner | Packs, runs the publish checks, uploads, tags |
| `pnpm data:pull --snapshot <partition> [--date D] [--with-files]` | Anyone | Downloads a snapshot. Skips `files.tar` unless asked. |
| `pnpm data:dump` | Integrator | Builds and publishes a corpus dump, updates `LATEST` |
| `pnpm data:pull --dump latest\|<date>\|eval-frozen-<n>` | Anyone | Verifies checksums, checks the Alembic revision, replaces the local `corpus` |
| `pnpm data:status` | Anyone | Lists snapshots and dumps, shows your loaded dump, shows repo usage |

## Not covered here

- **Building the commands:** see the build issues:
  - HF org/repo setup: #151 (done: [huggingface.co/caseguard](https://huggingface.co/caseguard), private dataset `caseguard/corpus`)
  - snapshot push/pull/status: #152
  - collector partition support: #153
  - dump build/restore: #154
  - upload storage: #101
- **The civil/criminal case taxonomy:** a separate decision for the supervisor. The dump carries its labels once they exist.
- **A shared, hosted database for development:** ruled out. Everyone restores locally.
- **Demo-environment details:** decided with demo hosting.
