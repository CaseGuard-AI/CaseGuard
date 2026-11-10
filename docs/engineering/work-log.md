# Work log

Important work on the handoff (`docs/engineering/handoff.md`), newest last. Each entry is short: what was done and why it matters. The detail lives in the linked plan, PR and issue.

## 2026-11-10

### Merged the first seven handoff PRs into `staging`
The A1 refresh rate limit (#157, #158), the collector live-site fix (#159), the taxonomy proposal (#161), the model gateway (#162), the `corpus`/`ai` schemas (#160) and the corpus loader (#163) were merged in that order. Conflicts were resolved by uniting both sides, and each merge was locked to the commit CI had tested. Every suite passed on `staging` afterwards, and `main` was not touched. Closed #83, #147, #15, #21 and #16.

### Collector partitions (#153)
`--partition <name>` crawls one bounded slice of the corpus into its own directory, ready to snapshot (#152):
- `pk-code-seed`: the 7 seed statutes and the Constitution (consolidated texts), by title;
- `shc-meta`: all SHC metadata, no PDFs;
- `shc-criminal` / `shc-civil`: PDFs for a committed selection only.

Selections are filtered before anything is fetched, and discovery stops once everything selected has been found. Each run records the partition, the selection file's checksum and the source snapshot in `state.db`. Also added `services/collector/PARTITIONS.md` (the owner registry). Plan: `plans/0033-153-collector-partitions.md`.

### SHC case-type map and selection generator (#153)
`selections/matter_type_map.csv` holds all 57 SHC case types from the taxonomy (§4), each mapped to a proceeding type and civil / criminal / either. It was checked against 18,027 real records: nothing unmapped. `tools/make_selection.py` draws a stratified, repeatable sample (case type × year) for one branch. It leaves out constitutional petitions and judgments without a file. On the real crawl, 1,987 civil and 7,857 criminal judgments are eligible.

### Chunking and bge-m3 embeddings (#18)
`pnpm data:embed` turns loaded documents into searchable chunks:
- statutes by section, with locators like "s. 302", "Art. 199" and "O. XXI r. 60" (chunks never cross a section);
- judgments in paragraph windows of about 500 tokens;
- head-note-only records as one flagged chunk.

The chunks are embedded with BAAI/bge-m3 in-process, pinned to a model revision, and the full-text index fills automatically. The job is safe to stop and re-run: it redoes only what changed, and it refuses to mix two embedding models. Section detection was tuned on the live CPC, CrPC and Contract Act, and finds every section that hasn't been repealed. Plan: `plans/0034-18-ai-ingestion-embeddings.md`.

### Loader fix: one judgment in two partitions (PR #166)
Loading `shc-meta` together with `shc-civil`/`shc-criminal` crashed: both hold each selected judgment under the same id. Found by running #153 and #18 on live data. The loader now keeps one record per id in each batch, and the full judgment always wins over its head-note row.

### Hybrid retrieval (#19, PR #168)
Search over the corpus, in four steps:
1. a meaning-based search (bge-m3 vectors) and a keyword search (Postgres full text), top 50 each;
2. the two lists merged with RRF (k = 60);
3. the top 20 re-scored by the bge-reranker cross-encoder;
4. the best 8 returned, each with its section, title and official link.

A user's private case files are searched only for their own allowed cases. The rule is enforced inside the database queries, and a test with hidden "marker" documents proves other users' files never come back (FR-CASE-6, release-blocking). Every ranked list is kept for the answer trace. Plan: `plans/0035-19-ai-hybrid-retrieval.md`.

### Merged the second round into `staging`
Merged #165 (partitions), #166 (loader fix), #167 (chunking and embeddings) and #168 (search), in that order. Each merge was locked to the commit CI had tested. After #165 merged, #167 and #168 needed the CHANGELOG and handoff conflicts resolved by keeping both sides, and each resolved branch was checked to differ from `staging` only by its own files. Final `staging`: AI 119 passed, collector 170 passed, CI green. Closed #153, #18 and #19; all branches kept.

### Retry failed PDF downloads (PR #169)
Judgments whose PDF download failed because the court site was down (HTTP 521/525) are now retried on the next run, and the full judgment replaces the head-note row. Permanent problems (scans, non-PDF files) aren't retried. `--requeue-failed-downloads` marks failures stored before this fix for retry. Merged into `staging`.

### Answer route (#20, PR #170, open)
`POST /ai/v1/research/answer`, step by step:
1. find passages;
2. ask the AI model to answer, citing them with exact quotes;
3. check every citation: the passage was found, the document exists, and the quote is word for word;
4. store the answer with its statuses.

In M1 a citation is at best "needs review" (never "verified", because the support check comes later). Questions the corpus can't answer return "not answerable". Also adds the citation and source lookups the web app calls. 175 AI tests pass.

### Merged #169 and #170; closed #148
The failed-download retry (#169) and the answer route (#170) were reviewed and merged into `staging` (CI green; branches kept), and #20 closed. The answer route's review checked:
- the existence check: verbatim quotes, only line breaks forgiven, short quotes rejected;
- that nothing is ever "verified" in M1;
- that the question is never logged or stored;
- that every new route needs the service token.

Closed #148 with the full-catalogue numbers: 9,491 civil judgments, so the civil target can be met.
