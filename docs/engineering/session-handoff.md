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
| Taxonomy owner | **#200:** the statute→area classifier and the 200-judgment review. The taxonomy itself is approved (#164, [`case-taxonomy.md`](case-taxonomy.md), vocabulary in `packages/contracts/taxonomy/case-taxonomy.v1.yaml`) | No |
| One member | **#22, test set:** 60 dev + 40 held-out questions, half civil and half criminal, about 10% unanswerable, each with its gold section (e.g. "PPC s. 302"). Written from the law texts. **Freeze it before any tuning.** | No |
| One member | **#17, Supreme Court probe:** `uv run python main.py --source supreme_court --probe` from a home or university network; record the result in the collector README §1 | No |
| One member | **Demo model:** install Ollama and `ollama pull qwen2.5:7b`, or get a free NVIDIA NIM or Gemini key | No |
| Partner | **Research history (#86), user API keys (#92–#95), "law as of" date (#96):** steps in [`handoff-res8-set2-res11.md`](handoff-res8-set2-res11.md) | No |
| Others | **Stream A P1 items** (#86–#113), in the order of the [Stream A roadmap](stream-a-roadmap.md) | No |
| Whoever tries the demo | **M1 demo** (see "Running the demo") | Yes: a small one is enough |

## Hugging Face (`caseguard` org)

Set up (#151, done 2026-11-18): the org https://huggingface.co/caseguard and the private dataset `caseguard/corpus`. Members have **write**, managed at https://huggingface.co/organizations/caseguard/members.

**For each member (once):**
1. Create a **fine-grained** token (https://huggingface.co/settings/tokens) with write on `caseguard/corpus`, and adds it to `.env` only (never commit it):
   ```
   HF_TOKEN=hf_xxxxxxxx
   HF_CORPUS_REPO=caseguard/corpus
   ```
2. Install the CLI and log in:
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

**Uploading the database** (#154; only after `pnpm data:embed` has finished): run `pnpm data:dump`.
- It refuses an unfinished embed, and builds `corpus.dump` + `manifest.json` in `services/ai/.dumps/<today>/`.
- It asks before publishing to a new `dumps/<date>[-N]/`, and moves `dumps/LATEST` and tags it.
- Use `-- --freeze eval-frozen-1` for the dump behind an evaluation.
- Don't upload a `pg_dump` by hand: `data:pull` can't restore it.

**Downloading the database:** run `pnpm db:migrate:ai`, then `pnpm data:pull -- --dump latest`.
- It checks the checksum and the migration revision, shows what you have, and asks before replacing your local `corpus`.
- Your `app` and `ai` data are untouched.

**Downloading the crawls:**
```powershell
hf download caseguard/corpus --repo-type dataset --include "snapshots/*" --local-dir hf-corpus
```
- To use a crawl, unpack it into `services/collector/data/partitions/` (`tar -xf <file>.tar -C services\collector\data\partitions`).
- Until the first dump is published, build your own small corpus (next section).

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
- **The selection files** (`selections/shc-criminal.csv`, `shc-civil.csv`) aren't committed yet. The taxonomy is approved (#164), so they can go in their own PR now, and everyone gets the same judgments. Until then, each machine generates its own.

## Running the demo

1. Run `pnpm stack:up`.
2. In the admin console, enable a provider: Ollama with `OLLAMA_MODEL`, or NIM/Gemini with a key in `.env`.
3. In the Research Hub, ask "What is the punishment under s. 302 PPC?". You should get a cited answer with statuses.

The reranker downloads on first use (about 2.3 GB). How well a model follows the answer format hasn't been measured yet: `pnpm research:ask -- "<question>" --providers nvidia-nim` runs the answer path from the terminal and shows the raw reply (#191); the measurement on the real seed laws is #192.

## Open items

- **#152, crawl snapshots:** `pnpm data:push`, `pull` and `status`, which do the Hugging Face steps above automatically. Unblocked: `caseguard/corpus` is live (#151).
- **#154, database dumps:** `pnpm data:dump` and `data:pull --dump` are built (plan 0038). Next: publish the first real dump once the full embed finishes.
- **`--full-text-first` for `data:embed`** (not built): embed the laws and full judgments before the 56k short head-notes, so the demo works within minutes.
- **Small follow-ups:**
  - add the 10 unmapped SHC case-type codes to `selections/matter_type_map.csv`, marked `confirmed=no`;
  - look into the "not a PDF" downloads (about 10%; maybe Word files);
  - records with status "invalid"/"duplicate" are re-processed on every run;
  - a retry of `research/answer` with the same `requestId` replaces the earlier trace and its citations.
- **Waiting on people:** #17 (network); the 4 `confirmed=no` SHC codes in `matter_type_map.csv` (taxonomy §9 q7).

## How to work here (gotchas)

- **Branches and merges:**
  - work off `staging`, one concern per PR, PR base `staging` (never `main`);
  - squash-merge with `--match-head-commit`, and never delete branches;
  - the repo lead normally approves merges.
- **Plans** go in `plans/NNNN-<issue>-<slug>.md`. 0038 is the latest.
- **Test databases:** the services/ai tests need `AI_TEST_DATABASE_URL`, pointing at a bootstrapped scratch database, never the dev one (see `services/ai/README.md`).
  - Use `127.0.0.1`, not `localhost`: on Windows, Python stalls on IPv6.
- **Existing Docker volumes** need `pnpm db:rebootstrap` once, then `pnpm db:migrate:ai`.
- **Writing code with Claude Code on Windows:** bash heredocs and `sed` collapse `\\`, which corrupted regexes and `\n` several times. Write code with the editor tools instead. Python `write_text` writes CRLF unless you pass `newline="\n"`.
- **While a crawl or embed runs** in your main folder, use a git worktree (`git worktree add ../cg-x <branch>`) instead of switching branches.
- **CHANGELOG/handoff conflicts:** unite both sides. Afterwards, check that `git diff --stat origin/staging` shows only the PR's own files; once, git's auto-merge silently duplicated code.
