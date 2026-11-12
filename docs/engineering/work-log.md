# Work log

Important work on the handoff ([`handoff.md`](handoff.md)), newest last. Each entry is short: what was done and why it matters. The detail lives in the linked plan, PR and issue. Where things stand now: [`session-handoff.md`](session-handoff.md).

## 2026-11-10

### The plan for the whole handoff
Read `handoff.md` and wrote the implementation plan, [`handoff-plan.md`](handoff-plan.md): what to build, in what order, and what only a person can do. Choices agreed:
- embeddings and the reranker run in-process;
- the AI model provider is switchable (local Ollama, free cloud tiers, NVIDIA NIM);
- manual items are a checklist, so no code waits on them.

### Refresh rate limit (#83, PRs #157, #158)
`POST /auth/refresh` got its own limit, 120 per IP per 15 minutes, separate from sign-up and password reset. Page reloads from one shared network no longer lock people out. The contract declares the 429 response (#157 is the contract, #158 the code). Plan: `plans/0028`.

### Collector works on the live sites again (#147, PR #159)
The collector had been storing nothing from Pakistan Code or SHC. Fixed:
- Pakistan Code's broken certificate chain, by bundling the missing intermediate certificate (TLS checks stay on);
- relative links on both sites, `<base href>` and `../pdffiles/`;
- SHC's new download links;
- empty and non-PDF downloads, which are now flagged instead of saved.

SHC records also say explicitly when they're only a head-note. A live `--limit 5` run stored statutes and judgments with full text. Plan: `plans/0029`.

### Database schemas for services/ai (#15, PR #160)
Alembic migrations for:
- the `corpus` schema: documents, chunks with bge-m3 vectors and a full-text index, and the corpus settings record;
- the `ai` schema: answer traces, citations, the single trust store for citation statuses, and users' case chunks.

The AI image migrates on start, and CI tests the migrations. Existing Docker volumes need `pnpm db:rebootstrap` once. Plan: `plans/0030`.

### Model gateway (#21, PR #162)
One way to call any OpenAI-compatible AI provider (NVIDIA NIM, Gemini, Groq, OpenRouter, OpenAI, Anthropic, Ollama), with local Ollama as the fallback. Only providers the Admin has allowed are ever used; if none fits, the answer is 503. ADR-0008 records that embeddings and the reranker run in-process. Plan: `plans/0031`.

### Corpus loader (#16, PR #163)
`pnpm data:load` puts the collector's records into `corpus.documents`:
- re-runs are safe, and duplicate text is stored once;
- provenance and the head-note and third-party labels are kept;
- a head-note row can never replace a full judgment;
- records with no usable text or no source link are skipped and counted.

Plan: `plans/0032`.

### Case taxonomy proposal for the supervisor (PR #161, issue #164)
[`case-taxonomy.md`](case-taxonomy.md) proposes labelling every judgment with an area of law and sub-category, plus a proceeding type; civil or criminal follows from those two. The numbers come from 18,027 real SHC judgments: all 57 case-type codes are mapped, and 7 questions are set out for the supervisor.

### Merged the first seven handoff PRs into `staging`
Merged #157, #158, #159, #161, #162, #160 and #163, in that order. Conflicts were resolved by keeping both sides, and each merge was locked to the commit CI had tested. One auto-merge silently duplicated code; it was caught and fixed before merging. Every suite passed on `staging` afterwards, and `main` was not touched. Closed #83, #147, #15, #21 and #16.

### Collector partitions (#153, PR #165)
`--partition <name>` crawls one bounded slice of the corpus into its own folder, ready to share later (#152):
- `pk-code-seed`: the 7 seed statutes and the Constitution, by title;
- `shc-meta`: the metadata of every SHC judgment, no PDFs;
- `shc-criminal` / `shc-civil`: PDFs for a chosen selection only.

Unselected items are never downloaded, and discovery stops once everything selected has been found. Each run records the partition, the selection file's checksum and the source snapshot. [`PARTITIONS.md`](../../services/collector/PARTITIONS.md) is the registry. Plan: `plans/0033`.

### SHC case-type map and selection generator (#153, PR #165)
- `selections/matter_type_map.csv` maps all 57 SHC case types from the taxonomy to a proceeding type and to civil, criminal or "either".
- `tools/make_selection.py` draws a balanced, repeatable sample for one branch, by case type and year. It leaves out constitutional petitions, judgments without a file and, with `--exclude`, chosen proceeding types.

### Chunking and bge-m3 embeddings (#18, PR #167)
`pnpm data:embed` turns loaded documents into searchable chunks:
- statutes by section, with locators like "s. 302", "Art. 199" and "O. XXI r. 60" (chunks never cross a section);
- judgments in paragraph windows of about 500 tokens;
- head-note-only records as one flagged chunk.

The chunks are embedded with BAAI/bge-m3 in-process, pinned to a model revision, and the full-text index fills automatically.
- **Safe to re-run:** stop it any time; it redoes only what changed, and it refuses to mix two embedding models.
- **Tuned on the live text** of the CPC, CrPC and Contract Act: it finds every section that hasn't been repealed.

Plan: `plans/0034`.

### Loader fix: one judgment in two partitions (PR #166)
Loading `shc-meta` together with `shc-civil` or `shc-criminal` crashed, because both hold each selected judgment under the same id. It was found by running #153 and #18 on live data. The loader now keeps one record per id, and the full judgment always wins over its head-note row.

### Hybrid retrieval (#19, PR #168)
Search over the corpus, in four steps:
1. a meaning-based search (bge-m3 vectors) and a keyword search (Postgres full text), top 50 each;
2. the two lists merged with RRF (k = 60);
3. the top 20 re-scored by the bge-reranker cross-encoder;
4. the best 8 returned, each with its section, title and official link.

A user's private case files are searched only for their own allowed cases. The rule is enforced inside the database queries, and a test with hidden "marker" documents proves other users' files never come back (FR-CASE-6, release-blocking). Every ranked list is kept for the answer trace. Plan: `plans/0035`.

### The first real crawls, and what they changed
Run on one laptop with the partitions:
- **`pk-code-seed`:** stored all 7 seed statutes with full text. It also showed two pattern mistakes, both fixed in #165:
  - an unanchored "Limitation Act" pulled in two unrelated Acts;
  - the Constitution was missed, because the site's title has a double space.

  Pakistan Code lists no separate amendment acts: each statute's text is the consolidated version.
- **`shc-meta`:** 56,649 judgments in about 10 minutes: 9,491 civil, 19,090 criminal, 27,947 constitutional petitions, and 121 with 10 case-type codes not in the map yet.
- **Selections:** a proportional civil sample was 42% tax references. `--exclude` was added, and with tax, company, special-law appeals and succession left out, 4,684 civil judgments remain (taxonomy decision 3). 3,000 criminal and 3,000 civil judgments were selected.
- **First PDF batches:** criminal 300 stored (231 with full text); civil 333 stored (244 with full text). 22 scans need OCR, about 10% of downloads weren't PDFs, and 24 downloads failed while the SHC site was down.

### Retry failed PDF downloads (PR #169)
Judgments whose PDF download failed because the court site was down (HTTP 521/525) are now retried on the next run, and the full judgment replaces the head-note row. Permanent problems (scans, non-PDF files) aren't retried. `--requeue-failed-downloads` marks failures stored before this fix for retry. Plan: `plans/0036`.

### Answer route (#20, PR #170)
`POST /ai/v1/research/answer`, step by step:
1. find passages;
2. ask the AI model to answer, citing them with exact quotes;
3. check every citation: the passage was found, the document exists, and the quote is word for word;
4. store the answer with its statuses.

In M1 a citation is at best "needs review", never "verified", because the support check comes later. Questions the corpus can't answer return "not answerable". It also adds the citation and source lookups the web app calls. 175 AI tests pass. Plan: `plans/0037`.

### Merged the second and third rounds into `staging`
- **Second round:** #165, #166, #167 and #168, in that order. #167 and #168 needed their CHANGELOG, handoff and README conflicts resolved by keeping both sides, and each resolved branch was checked to differ from `staging` only by its own files. Closed #153, #18 and #19.
- **Third round:** #169 and #170. The review of #170 checked:
  - the existence check: verbatim quotes, only line breaks forgiven, short quotes rejected;
  - that nothing is ever "verified" in M1;
  - that the question is never logged or stored;
  - that every new route needs the service token.

  Closed #20.

All CI was green, all branches were kept, and `main` was untouched.

### Closed #148: SHC has enough civil judgments
The ≤2% worry came from the small "reported only" listings. The full catalogue has 9,491 civil judgments, all with files, so the PRD's 3–5k civil target can be met. The labelling question stays with the supervisor (#164).

### Session handoff on GitHub (PR #171)
[`session-handoff.md`](session-handoff.md), this log and [`handoff-plan.md`](handoff-plan.md) were added to the repo, so a teammate can pull `staging` and continue. The crawled data itself isn't shared until the Hugging Face repo exists (#151). Until then, the handoff gives the commands to rebuild it.

### Forward-only session handoff, with the Hugging Face steps
[`session-handoff.md`](session-handoff.md) now covers only what comes next. Done work lives in this log. New in it:
- the `caseguard` Hugging Face org: setup, what to upload and how (fast options for `shc-meta`), and downloading;
- a small corpus (the 8 laws, about 15 minutes) for the demo, so nobody has to wait for the 8-hour full embedding;
- who does what while the embedding runs.

### Corpus dumps: `data:dump` and `data:pull --dump` (#154)
The embedded corpus can now be shared, so teammates restore it instead of embedding for 8 hours:
- `pnpm data:dump` checks the embed run finished, writes `corpus.dump` and `manifest.json`, and publishes them to a new `dumps/<date>[-N]/` on Hugging Face. It never overwrites, and it moves `LATEST` and tags the dump (`--freeze` for evaluation dumps).
- `pnpm data:pull -- --dump latest` checks the checksum and the migration revision, shows what you have, asks, and replaces only `corpus`.

It uses `COPY` through psycopg, not `pg_dump`, so it needs no matching Postgres client on Windows or in CI. Plan: `plans/0038`.

## 2026-11-12

### Lawyer, Researcher and Administrator roles (FR-AUTH-2)
The app had only `user` and `admin`; the PRD names three roles. Now:
- migration `0008_user_roles` turns every `user` into a `lawyer` and allows `lawyer`, `researcher` and `admin`;
- sign-up asks "Lawyer or Researcher" (Lawyer by default). Asking for `admin`, or any other role, is a 400, so admins still come only from `pnpm db:create-admin`;
- the admin console shows each user's role, and admin routes stay 403 for Lawyers and Researchers.

Old access tokens that say `user` are refused, and the web's refresh replaces them. The Urdu role names and sign-up strings need a native speaker's review (A11).

### Stale flag on old sources (FR-TRUST-6)
A citation now carries the `stale` chip when its corpus source was last retrieved more than 180 days ago, or has no retrieval date at all. The window is `TRUST_STALE_DAYS` (TBD-13). The flag doesn't change the status, and users' own case files are never flagged. The web app and the contracts already had the flag and its labels, so only services/ai changed.

### The citation support check (FR-TRUST-3, FR-TRUST-9)
Citations can now be **verified**. After the existence check passes, the claim is tested against the stored quote:
- by a multilingual NLI model, `MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7`, pinned to `b5113eb3…` and run in-process (ADR-0008 addendum). P(entailment) ≥ 0.7 passes, P(contradiction) ≥ 0.7 fails, anything else is uncertain;
- only when NLI is uncertain, by the LLM judge (prompt `support-v1`), and only if the request's allow-list reaches a judge provider. A judge error stays uncertain.

A failed existence never runs the support check, so no model can rescue it. The verifier version is `m2-support-1`. Tests use a stub checker, so CI downloads nothing.

`pnpm ai:support-eval` scores 46 hand-labelled pairs (PPC, CrPC, CPC, Contract Act, Constitution). First run, NLI alone, CPU:

| | precision | recall | n |
|---|---|---|---|
| pass | 1.000 | 0.667 | 21 |
| uncertain | 0.435 | 0.833 | 12 |
| fail | 0.778 | 0.538 | 13 |

Accuracy is 0.674. Nothing unsupported passed, so no citation was wrongly verified. The misses fall into uncertain, so those citations go to review (and to the judge, when one is allowed). The 0.7 thresholds are still TBD-13 defaults until calibrated on the development set.

### ADR-0009: user API keys (#92)
Decided how a user's own model key reaches services/ai (FR-SET-2), choosing option (a) from the roadmap:
- apps/api alone stores keys, encrypted with AES-256-GCM under `KEY_ENCRYPTION_KEY`;
- it sends the decrypted key with each request over the internal network, and services/ai never stores or logs it;
- keys work only for cloud providers the Admin has enabled, and the API shows only the last four characters.

Key rotation is left for later. Plan for all of FR-SET-2 (ADR, contracts, api, services/ai, web): `plans/0041`.
