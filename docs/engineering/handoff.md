# Handoff: start here

> **Status:** Living document, updated 2026-11-09 (#147, #15 done). **Whoever finishes an item below updates this page in the same PR**, so the next person always starts from the truth.

This page tells whoever picks up work next where the project stands and what to do first. Owners aren't fixed: pick the next free item, assign yourself, and go.

## 1. Where we are

| Area | State | Read |
|---|---|---|
| **Stream A** (`apps/web`, `apps/api`) | **Mostly done:** auth, settings, admin console, Research Hub UI, email. The P1 screens remain (#97–#108). | [Stream A roadmap](stream-a-roadmap.md) |
| **Data storage** | **Decided, not built.** Hugging Face corpus repo, partitions, snapshot and dump formats, user-upload storage. | [Data-storage spec](data-storage.md), [`CONTEXT.md`](../../CONTEXT.md) |
| **Collector** (`services/collector`) | **Works on the live sites again** (#147). A `--limit 5` run stores 5 statutes with PDFs and 4 of 5 SHC judgments with files; the fifth answered with a non-PDF and is flagged. Next: partitions (#153). | [Collector README](../../services/collector/README.md) |
| **M1 data/AI path** (#15–#20, #22) | **Schemas done (#15);** load, embed, retrieve and answer (#16–#20) are next. The Research Hub has no corpus to answer from yet, so every question gets a 503. | [PRD §16.2](../PRD.md#162-milestones) |
| **Corpus collected so far** | Only a small sample on one laptop (git-ignored `services/collector/data_sample*/`). **Nothing is shared yet.** | #139 (measurements) |

**Measured facts that shape the work (from #139):**
- PDFs average about 270 KB, and **none of the 37 sampled were scans**, so OCR is a fallback, not a main stage.
- About 10k judgments plus the seed statutes come to about 3 GB of snapshots and a dump of about 1 GB.
- **Civil judgments are 2% or less of SHC's reported listings** (#148).

## 2. Start here: the critical path

Do these in order. Each one unblocks the next. The arrows show what blocks what in the tracker.

| # | Issue | What | How to begin | Done when | Blocked by |
|---|---|---|---|---|---|
| 1 | ~~**#147** Collector live-site fix~~ **Done** | Make the collector work against the live sites again. | The issue has the four fixes. In short: (a) bundle the `GoGetSSL RSA DV CA` intermediate for pakistancode.gov.pk, and **never disable TLS verification**; (b) match relative detail/PDF links; (c) resolve SHC `download-file.php` links against `<base href="/caselaw/">` and ignore the commented-out `view-file` links; (d) flag non-PDF downloads. Add fixture tests for each. | A `--limit 5` live run stores statutes with PDFs and SHC judgments with files | — |
| 2 | **#151** HF org + corpus repo | Create the shared storage | Manual work for the repo lead: create the free HF org and the private `corpus` dataset, invite members, and add `HF_TOKEN=` to `.env.example` | Members can read and write the repo | — |
| 3 | ~~**#15** Alembic + `corpus`/`ai` schemas~~ **Done** | The tables everything else writes to | Also include what the storage decisions need: a **corpus metadata table** for embedding and chunker settings (#143); **user-upload chunks live in `ai`, never in `corpus`** (#145); nullable taxonomy columns (`area`, `subcategory`, `proceeding_type`) for the coming case taxonomy | Migrations run on the Docker DB, with ADR-0002 roles | — |
| 4 | **#153** Partition support | Crawl one partition on its own | Full-scope SHC pass, the selection-file generator and "fetch only this selection", plus `services/collector/PARTITIONS.md`. Then crawl **`pk-code-seed`** and **`shc-meta`**. | Both partitions crawled locally | #147 |
| 5 | **#152** Snapshot push/pull/status | Share the crawls | Python in `services/collector` (`huggingface_hub`, stdlib `tarfile`), exposed as `pnpm data:*`. Follow spec §3 exactly, including the publish checks. | The first snapshots are published, and a teammate pulls them | #151 |
| 6 | **#16 → #18 → #19 → #20** | Load, embed, retrieve, answer | Load JSONL into `corpus`. Chunk and embed with bge-m3 (statutes by section; judgments in windows of about 500 tokens, PRD §8.2). Hybrid retrieval with RRF. Answers with citations and the existence check. **Head-note-only SHC records must stay labelled** (collector README §10.4). | **M1's end-to-end demo works:** an English question gets a cited answer with a status | #15, and the previous item in the chain |
| 7 | **#154** Dump build/restore | Teammates stop re-embedding | Data-only `pg_dump` of `corpus`, gated on the Alembic revision, with pinned embedding metadata (spec §4) | A teammate restores the latest dump and the Research Hub answers | #15, #18, #152 |

**Can run in parallel with the path above:**
- **#22**: build and freeze the test set (60 dev + 40 held-out, half civil and half criminal). Needed for M1 sign-off.
- **#17**: SCP `--probe` from a team network (not a cloud machine).
- **Stream A P1 items** (#97–#108), in the order the [Stream A roadmap](stream-a-roadmap.md) gives. Document uploads (#101) must follow the upload design in spec §6.

## 3. Non-code actions (people, not PRs)

| Action | Why | Who |
|---|---|---|
| **Case taxonomy proposal** for the supervisor. Two labels per case: area of law (e.g. offences against the person, property, family) and proceeding type (bail, quashment, suit, revision…). **Proposal written: [`case-taxonomy.md`](case-taxonomy.md)** (with measured SHC numbers and 7 decisions for the supervisor). | The supervisor asked for sub-categories. The labels decide filters, linter rules and test-set balance. | Anyone, then the supervisor |
| **#148**: are there enough civil judgments? | SHC's civil share is tiny. The answer may be a lower target, extra sources (SCP, IHC), or accepting an imbalance. | Team + supervisor |
| **LHC permission letter** | LHC is off-limits without permission, and replies take weeks (PRD §15) | Team lead |
| **Real contact address in `PKLEGAL_USER_AGENT`** (a team email) | Court admins then email us instead of blocking us. Set it before any full crawl. | Whoever crawls first |
| **Pick the integrator** | The person who builds dumps (spec §4). Best: whoever has the strongest machine. | Team |
| **Choose demo hosting** | It decides the demo's upload storage (Supabase preferred) and whether the demo restores a dump | Team |

## 4. How to pick up an issue

1. **Claim it:** assign yourself on GitHub. An assigned issue is taken.
2. **Branch** off an up-to-date `staging`. The prefix must be `feature/`, `fix/`, `docs/`, `chore/`, `refactor/`, `test/`, `perf/`, `ci/`, `build/` or `revert/`; CI rejects others. Name it correctly before pushing, because renaming a PR's branch closes the PR.
3. **Plan:** save your plan as `plans/NNNN-<issue#>-<slug>.md` with a status line (see [`plans/README.md`](../../plans/README.md)).
4. **PR to `staging`:** conventional title (`fix(collector): …`), CI green.
5. **Merge:** squash-merge, and **never delete the branch**. Merging needs the repo lead's OK.
6. **Update this page** in the same PR if you finished or changed an item above.

Full rules: [Contributing](../../CONTRIBUTING.md), [Branching & release](branching-and-release.md).

## 5. Gotchas

- **After pulling #15, run `pnpm db:rebootstrap` once, then `pnpm db:migrate:ai`.** Bootstrap only runs when a Docker volume is first created, and #15 added a grant (`caseguard_ai` needs USAGE on `public` to see pgvector's `vector` type). Without it the migration fails with `type "vector" does not exist`.
- **`localhost` is slow for Python on Windows:** psycopg tries IPv6 `::1` first, and Docker publishes Postgres on `127.0.0.1` only, so every connection can stall 10 s or more (a migration took over 2 minutes). Use `127.0.0.1` in `AI_DATABASE_URL` and test URLs.
- **pgvector on Windows:** a natively installed Postgres often lacks pgvector. Use the Docker DB (`pnpm db:up`). If a native Postgres already holds port 5432, map Docker to another port (e.g. 5433) and update the `*_DATABASE_URL`s in `.env`. See [Local setup](local-setup.md).
- **Pakistan Code TLS:** fixed in #147. The collector trusts certifi plus `services/collector/certs/extra-intermediates.pem`. Never disable verification; if another host sends a broken chain, add its missing intermediate (from the leaf's AIA URL) to that file.
- **Collector output is git-ignored** (`services/collector/data/`, `data_*/`). Never commit corpus data. It is shared through snapshots (#152) only.
- **Head-note-only records:** where SHC links no judgment file (or the file is unusable), the record holds only the table row, with `raw.headnote_only: true` and a note saying why (#147). Never index it as a full judgment.
- **Third-party data** (`hf_*` bootstrap datasets) is never cited as official, and gets its own partition (spec §3).
- **PowerShell 5.1** mangles quoted `git commit -m` here-strings. Use `git commit -F <file>` from Git Bash.

## 6. Key documents

| Document | For |
|---|---|
| [PRD](../PRD.md) | Scope, priorities, requirements, milestones |
| [Data-storage spec](data-storage.md) | Where the corpus, dumps and uploads live, and the planned `data:*` commands |
| [`CONTEXT.md`](../../CONTEXT.md) | Glossary: partition, corpus snapshot, corpus dump, integrator, user upload |
| [Collector README](../../services/collector/README.md) | Sources, data model, CLI, known limitations |
| [ADR-0002](../adr/0002-two-backends-with-strict-boundary.md) | Which service owns which schema |
| [Stream A roadmap](stream-a-roadmap.md) | Web/API work left, in order |
| [Local setup](local-setup.md) | Running everything with or without Docker |
| Wayfinder map #137 (closed) | The decision trail behind the data-storage spec |
