# Session handoff: continue from here

*Updated 2026-11-10.* This file covers only **what to do next**. For what has been done, see [`work-log.md`](work-log.md), one heading per piece of work.

- **To continue with Claude Code:** pull `staging` and say "read docs/engineering/session-handoff.md and continue".
- **Background:** [`handoff.md`](handoff.md) is the team handoff; [`handoff-plan.md`](handoff-plan.md) is the plan for implementing it.

## Start here (for a teammate)

1. **Get the code:** `git switch staging`, then `git pull`.
2. **Set up** with [`local-setup.md`](local-setup.md): Docker, `pnpm install`, then `uv sync` in `services/ai` and in `services/collector`.
   - Copy `.env.example` to `.env`. Set `PKLEGAL_USER_AGENT` to the team contact address, and add your model provider key if you use a cloud provider.
3. **Pick a task** from "Who does what" below. Most of them need no corpus data at all.
4. **Add a heading** to [`work-log.md`](work-log.md) for each important piece of work.

## Who does what now

The full corpus is being embedded on one laptop (about 8 hours on CPU). None of these tasks waits for it:

| Who | Task | Needs the corpus? |
|---|---|---|
| Repo lead | **#151:** finish the Hugging Face setup (see below) | No |
| Taxonomy owner | **#164:** send [`case-taxonomy.md`](case-taxonomy.md) to the supervisor, with the full-crawl numbers (9,491 civil, 19,090 criminal, 27,947 constitutional petitions) | No |
| One member | **#22, test set:** 60 dev + 40 held-out questions, half civil and half criminal, about 10% unanswerable, each with its gold section (e.g. "PPC s. 302"). Written from the law texts. **Freeze it before any tuning.** | No |
| One member | **#17, Supreme Court probe:** `uv run python main.py --source supreme_court --probe` from a home or university network; record the result in the collector README §1 | No |
| One member | **Demo model:** install Ollama and `ollama pull qwen2.5:7b`, or get a free NVIDIA NIM or Gemini key | No |
| Others | **Stream A P1 items** (#86–#113), in the order of the [Stream A roadmap](stream-a-roadmap.md) | No |
| Whoever tries the demo | **M1 demo** (see "Running the demo") | Yes: a small one is enough |

## Hugging Face (`caseguard` org)

The org exists: https://huggingface.co/caseguard. Nothing has been uploaded yet.

**One-time setup:**
1. Create the dataset at https://huggingface.co/new-dataset: owner `caseguard`, name `corpus`, **Private**.
2. Invite members with **write** at https://huggingface.co/organizations/caseguard/members.
3. Each member creates a **fine-grained** token (https://huggingface.co/settings/tokens) with write on `caseguard/corpus`, and adds it to `.env` only (never commit it):
   ```
   HF_TOKEN=hf_xxxxxxxx
   HF_CORPUS_REPO=caseguard/corpus
   ```
4. Install the CLI and log in:
   ```powershell
   uv tool install "huggingface_hub[cli]"
   hf auth login
   hf auth whoami      # should list caseguard
   ```

**What gets uploaded:** only two things, both so nobody has to repeat slow work.
- **The crawls** (`services/collector/data/partitions/<name>/`), so nobody re-scrapes.
- **The finished database** (one `corpus.dump` file, after embedding), so nobody re-embeds. Most teammates only need this one.

Code goes to GitHub. `.env` and tokens go nowhere. The models download themselves.

**Uploading the crawls** (from `services/collector`, with no crawl running). Never reuse a date folder: for a second upload on the same day, use `2026-11-10-2`.
- `shc-meta` has thousands of small files, which upload slowly. Upload only the records and the crawl state:
  ```powershell
  hf upload caseguard/corpus data\partitions\shc-meta snapshots/shc-meta/2026-11-10 --repo-type dataset --include "documents/*" --include "state/*"
  ```
- For the others, pack each crawl into one file first. Plain `tar -cf` is fast; `-czf` (compressed) is slow while the CPU is busy embedding:
  ```powershell
  tar -cf shc-civil.tar -C data\partitions shc-civil
  hf upload caseguard/corpus shc-civil.tar snapshots/shc-civil/2026-11-10/shc-civil.tar --repo-type dataset
  ```
  Do the same for `shc-criminal` and `pk-code-seed`. Keep `raw\` in these: the PDFs are there.

**Uploading the database** (only after `pnpm data:embed` has finished):
```powershell
docker compose exec db pg_dump -U caseguard -d caseguard --schema=corpus --data-only -Fc -f /tmp/corpus.dump
docker compose cp db:/tmp/corpus.dump ./corpus.dump
hf upload caseguard/corpus ./corpus.dump dumps/2026-11-10/corpus.dump --repo-type dataset
```

**Downloading:**
```powershell
hf download caseguard/corpus --repo-type dataset --include "snapshots/*" "dumps/*" --local-dir hf-corpus
```
- To use a crawl, unpack it into `services/collector/data/partitions/` (`tar -xf <file>.tar -C services\collector\data\partitions`).
- Restoring the dump by hand is fiddly: the tables must be emptied first, and the database migrations must match. #154 builds `pnpm data:pull --dump` for this. Until it exists, build your own small corpus (next section).

## Building a corpus on your own machine

**For the demo, a small corpus is enough** (about 15 minutes): the 8 seed laws only.
```powershell
cd services\collector
uv run python main.py --partition pk-code-seed
cd ..\..
pnpm db:up
pnpm db:migrate:ai
pnpm data:load -- <full path to services\collector\data\partitions\pk-code-seed> --snapshot local@<date>
pnpm data:embed        # downloads bge-m3 (about 2.3 GB) the first time; safe to stop and rerun
```

**For the full corpus** (hours: about 8 of them embedding), also crawl the judgments before loading:
```powershell
uv run python main.py --partition shc-meta            # about 10 minutes
uv run python tools/make_selection.py --from data/partitions/shc-meta --partition shc-criminal --n 3000 --source-snapshot shc-meta@<date>
uv run python tools/make_selection.py --from data/partitions/shc-meta --partition shc-civil --n 3000 --source-snapshot shc-meta@<date> --exclude tax_reference --exclude company_insolvency --exclude statutory_appeal --exclude succession_petition
uv run python main.py --partition shc-criminal --limit 300
uv run python main.py --partition shc-civil --limit 300
```
Then pass all four partition folders to one `pnpm data:load` command.

- **If downloads fail** because the court site is down: `--requeue-failed-downloads`, then rerun the partition.
- **The selection files** (`selections/shc-criminal.csv`, `shc-civil.csv`) aren't committed yet. They go in their own PR after the supervisor answers #164, so everyone gets the same judgments. Until then, each machine generates its own.

## Running the demo

1. Run `pnpm stack:up`.
2. In the admin console, enable a provider: Ollama with `OLLAMA_MODEL`, or NIM/Gemini with a key in `.env`.
3. In the Research Hub, ask "What is the punishment under s. 302 PPC?". You should get a cited answer with statuses.

The reranker downloads on first use (about 2.3 GB). How well a 7–8B model follows the answer format hasn't been tested yet.

## Open items

- **#152, crawl snapshots:** `pnpm data:push`, `pull` and `status`, which do the Hugging Face steps above automatically. Ready to build now that the org exists.
- **#154, database dumps:** `pnpm data:dump`, plus `data:pull --dump` to restore.
- **`--full-text-first` for `data:embed`** (not built): embed the laws and full judgments before the 56k short head-notes, so the demo works within minutes.
- **Small follow-ups:**
  - add the 10 unmapped SHC case-type codes to `selections/matter_type_map.csv`, marked `confirmed=no`;
  - look into the "not a PDF" downloads (about 10%; maybe Word files);
  - records with status "invalid"/"duplicate" are re-processed on every run;
  - a retry of `research/answer` with the same `requestId` replaces the earlier trace and its citations.
- **Waiting on people:** #164 (supervisor), #17 (network).

## How to work here (gotchas)

- **Branches and merges:**
  - work off `staging`, one concern per PR, PR base `staging` (never `main`);
  - squash-merge with `--match-head-commit`, and never delete branches;
  - the repo lead normally approves merges.
- **Plans** go in `plans/NNNN-<issue>-<slug>.md`. 0037 is the latest.
- **Test databases:** the services/ai tests need `AI_TEST_DATABASE_URL`, pointing at a bootstrapped scratch database, never the dev one (see `services/ai/README.md`).
  - Use `127.0.0.1`, not `localhost`: on Windows, Python stalls on IPv6.
- **Existing Docker volumes** need `pnpm db:rebootstrap` once, then `pnpm db:migrate:ai`.
- **Writing code with Claude Code on Windows:** bash heredocs and `sed` collapse `\\`, which corrupted regexes and `\n` several times. Write code with the editor tools instead. Python `write_text` writes CRLF unless you pass `newline="\n"`.
- **While a crawl or embed runs** in your main folder, use a git worktree (`git worktree add ../cg-x <branch>`) instead of switching branches.
- **CHANGELOG/handoff conflicts:** unite both sides. Afterwards, check that `git diff --stat origin/staging` shows only the PR's own files; once, git's auto-merge silently duplicated code.
