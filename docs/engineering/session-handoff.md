# Session handoff: continue from here

*Updated 2026-11-10.*
- **To continue with Claude Code:** pull `staging` and say "read docs/engineering/session-handoff.md and continue".
- **Where to read more:**
  - [`handoff.md`](handoff.md) is the team handoff, the overall picture;
  - [`handoff-plan.md`](handoff-plan.md) is the plan for implementing all of it;
  - [`work-log.md`](work-log.md) is the history of what was done, one heading per piece of work.

## Start here (for a teammate picking this up)

1. **Get the code:** `git switch staging`, then `git pull`. Everything below is merged there.
2. **Set up** with [`local-setup.md`](local-setup.md): Docker, `pnpm install`, then `uv sync` in `services/ai` and in `services/collector`.
   - Copy `.env.example` to `.env`, and set `PKLEGAL_USER_AGENT` to the team contact address.
   - Put your model provider key in `.env` too, if you use a cloud provider.
3. **Build your own copy of the corpus.** It isn't shared yet; see "The corpus data is not shared yet" below for the commands. It takes about an hour, mostly the PDF downloads and the embedding.
4. **Run the M1 demo:** step 1 of "Next steps" below.
5. **Then pick the next item** from "Next steps", and add a heading for each important piece of work to [`work-log.md`](work-log.md).

## Where things stand

**Merged into `staging`** (CI green each time, branches kept, `main` untouched):

| Issue | What | PR |
|---|---|---|
| #83 | Refresh rate limit | #157, #158 |
| #147 | Collector works on the live sites | #159 |
| #15 | Alembic + `corpus`/`ai` schemas | #160 |
| — | Case taxonomy proposal ([`case-taxonomy.md`](case-taxonomy.md)) | #161 |
| #21 | Model gateway (NIM, Gemini, Ollama, …; only Admin-allowed providers) | #162 |
| #16 | Loader (`pnpm data:load`) | #163, fix #166 |
| #153 | Partitions, selections, [`PARTITIONS.md`](../../services/collector/PARTITIONS.md) | #165 |
| #18 | Chunking + bge-m3 embeddings (`pnpm data:embed`) | #167 |
| #19 | Hybrid retrieval (RRF + reranker, scope in SQL) | #168 |
| — | Retry failed PDF downloads (`--requeue-failed-downloads`) | #169 |
| #20 | Answer route + `/citations`, `/sources` (existence check, stored statuses) | #170 |
| #148 | Civil share question: answered by the full crawl (closed with the numbers) | — |

**Open PRs:** none.

## The corpus data is not shared yet

Crawled data is git-ignored, and the shared Hugging Face repo (#151) doesn't exist yet. **Each person's data lives only on their own machine**, under `services/collector/data/partitions/`.

One laptop has crawled this (2026-11-10):

| Partition | Contents |
|---|---|
| `pk-code-seed` | The 7 seed statutes, with full text. Rerunning it after the pattern fix adds the Constitution (`stored=8`). |
| `shc-meta` | 56,649 SHC judgments (metadata): 9,491 civil, 19,090 criminal, 27,947 constitutional petitions, 121 unmapped (10 new case-type codes). |
| `shc-criminal` | 300 stored, 231 with full text. |
| `shc-civil` | 333 stored, 244 with full text, 24 download failures (the SHC site was down). |

**To build the same data on another machine** (from `services/collector`, after setting `PKLEGAL_USER_AGENT` in your `.env` to the team contact address):

```powershell
uv run python main.py --partition pk-code-seed
uv run python main.py --partition shc-meta            # about 10 minutes
uv run python tools/make_selection.py --from data/partitions/shc-meta --partition shc-criminal --n 3000 --source-snapshot shc-meta@<date>
uv run python tools/make_selection.py --from data/partitions/shc-meta --partition shc-civil --n 3000 --source-snapshot shc-meta@<date> --exclude tax_reference --exclude company_insolvency --exclude statutory_appeal --exclude succession_petition
uv run python main.py --partition shc-criminal --limit 300
uv run python main.py --partition shc-civil --limit 300
```

Then, from the repo root:
```powershell
pnpm db:up
pnpm db:migrate:ai
pnpm data:load -- <full path to each partition folder, all four in one command> --snapshot local@<date>
pnpm data:embed        # CPU; downloads bge-m3 (about 2.3 GB) the first time; safe to stop and rerun
```

- **The selection files** (`selections/shc-criminal.csv`, `shc-civil.csv`) aren't committed yet. They should go in their own PR once the supervisor answers #164, so everyone downloads the same judgments. Until then, each machine generates its own.
- **To retry downloads that failed** while the court site was down:
  ```powershell
  uv run python main.py --partition shc-civil --requeue-failed-downloads
  uv run python main.py --partition shc-civil
  ```

## Next steps

1. **The M1 demo**, once the corpus is loaded and embedded:
   - run `pnpm stack:up`;
   - enable a provider in the admin console: Ollama with `OLLAMA_MODEL`, or NIM/Gemini with a key in `.env`;
   - in the Research Hub, ask "What is the punishment under s. 302 PPC?" and expect a cited answer with statuses;
   - the reranker downloads on first use (about 2.3 GB). How well a real 7–8B model follows the answer format is untested.
2. **Small follow-ups:**
   - add the 10 unmapped SHC codes to `selections/matter_type_map.csv`, marked `confirmed=no`;
   - add the full-catalogue numbers to `case-taxonomy.md` for the supervisor;
   - look into the "not a PDF" downloads (about 10%; maybe Word files);
   - records with status "invalid"/"duplicate" are re-processed on every run (existing `should_process` behaviour);
   - #170: a retry with the same `requestId` replaces the earlier trace and its citations (only matters if the api ever retries).
3. **Remaining handoff items:**
   - #152 snapshots and #154 dumps, both blocked on **#151**: the repo lead creates the HF org;
   - #22 test set (60 dev + 40 held-out; freeze it before any tuning);
   - #17 SCP probe, from a home or university network;
   - #164: the supervisor's taxonomy decisions.
4. **Stream A P1 items** (#86–#113), in the order the [Stream A roadmap](stream-a-roadmap.md) gives.

## How to work here (gotchas)

- **Branches and merges:**
  - work off `staging`, one concern per PR, PR base `staging` (never `main`);
  - squash-merge with `--match-head-commit`, and never delete branches;
  - the repo lead normally approves merges.
- **Plans** go in `plans/NNNN-<issue>-<slug>.md`. 0037 is the latest.
- **Update [`work-log.md`](work-log.md)** with a heading and a short description for each important piece of work.
- **Test databases:** the services/ai tests need `AI_TEST_DATABASE_URL`, pointing at a bootstrapped scratch database, never the dev one (see `services/ai/README.md`).
  - Use `127.0.0.1`, not `localhost`: on Windows, Python stalls on IPv6.
- **Existing Docker volumes** need `pnpm db:rebootstrap` once, then `pnpm db:migrate:ai`.
- **Writing code with Claude Code on Windows:** bash heredocs and `sed` collapse `\\`, which corrupted regexes and `\n` several times. Write code with the editor tools instead. Python `write_text` writes CRLF unless you pass `newline="\n"`.
- **While a crawl or embed runs** in your main folder, use a git worktree (`git worktree add ../cg-x <branch>`) instead of switching branches.
- **CHANGELOG/handoff conflicts:** unite both sides. Afterwards, check that `git diff --stat origin/staging` shows only the PR's own files; once, git's auto-merge silently duplicated code.
