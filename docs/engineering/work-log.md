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

### "Law as of" date (#96, PR #181)
A question can now be asked about the law on a past date. The date was already accepted and audited, but nothing used it. Now:
- the search leaves out judgments decided after the date, inside the database queries. Judgments with an unknown date stay in;
- statutes stay as they are, because no historical versions are curated yet. The answer says so in a note, in its own language;
- the note is stored with the message and shown under the answer.

The new column is migration **0009**. Number 0008 is kept for the roles migration. Plan: `plans/0040`.

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

### Contracts for user API keys and model choice (#93)
The contract the api, services/ai and web work codes against, stacked on the ADR:
- api.v1: list, save and delete your own keys (`/me/keys`, only the last four characters come back), `GET /models` for the enabled providers and their models, and `defaultModel` in settings;
- ai.v1: an optional `credential` on `AnswerRequest`, refused unless the provider is allowed and is a cloud provider, used for the generation role only.

`defaultModel` is now required in the settings response, so the api's settings contract tests fail until the api change (#94) returns it. Plan: `plans/0041`.

### API: user keys, model list and default model (#94)
apps/api now does its half of ADR-0009, stacked on the contracts (#93):
- `app.user_api_keys` (migration `0010_user_api_keys`) holds each key as AES-256-GCM ciphertext with a fresh IV, bound to the user and provider, plus `last4` for display;
- `/me/keys` saves, lists and deletes keys (403 for a disabled, unknown or local provider; 503 when `KEY_ENCRYPTION_KEY` is unset), and `GET /models` lists the enabled providers with a static model catalogue and `hasKey`;
- `/me/settings` reads and writes `defaultModel` (403 for a provider that isn't enabled, 400 for a model it doesn't offer);
- a question carries `credential` only when that provider is allowed, is a cloud provider and has a saved key, and the audit row gets the provider and model, never the key;
- the logger redacts `apiKey` and `credential.apiKey`, and a log-capture test checks a test key never reaches the output.

Migration numbers 0008 and 0009 are reserved for the roles and law-as-of branches, so this one is 0010 (journal `idx` 10; the runner orders by the journal's `when`, not `idx`). `.env.example` now leaves `KEY_ENCRYPTION_KEY` empty: a local `.env` with the old placeholder must be blanked or given a generated key. Plan: `plans/0041`.

### services/ai: a user's own key per request (FR-SET-2, step 2d of #92)
services/ai now accepts `credential` on the answer route, stacked on the contracts:
- it is refused with 400 before any model call unless the provider is in `allowedProviders` and has a cloud preset (`PRESET_BASE_URLS`, whose hosts match the ones the gateway already infers); `ollama` never takes one;
- otherwise it is the generation role's provider for this request only, and the gateway checks the allow-list again; the judge role keeps the env configuration;
- the key is a `SecretStr` on the way in and `repr=False` in `ProviderConfig`, so it shows up in no log, error or trace. Tests capture structlog and stdlib logs on a good answer, HTTP 500 and 401, and a timeout, and look for the key.

The route tests for this run without a database (`tests/test_credential.py`). Plan: `plans/0041`.

### Models & keys in Settings (#95)
A new section on the settings page, after Theme, built against the frozen contract:
- each enabled cloud provider shows `••••last4` and the date of a saved key, a password field to save or replace it, and Delete behind a confirmation; local providers say no key is needed;
- the typed key is cleared once saved, and the save mutation is reset and not cached, so the key is not kept in the page after the request;
- a default-model select grouped by provider (cloud providers only, since a default model is used only with the user's own key), with "Deployment default" for `null` and a hint when the chosen provider has no key yet;
- friendly errors for 403 (provider off or local), 503 (the server can't store keys), 400 and network failures.

The new Urdu strings under `Settings.models` need a native review (#105). It needs the api (#94) for a live demo.

### Research history sidebar (FR-RES-8, #86)
The Research Hub now lists past conversations, so a user can get back to an earlier thread:
- newest first, with a relative date, and the open one marked;
- a column on desktop and a drawer on phones, mirrored for Urdu;
- "New question", "Load more", and empty, loading and error states;
- a new question shows at the top straight away, without a reload.

It uses the existing `GET /conversations`, so only `apps/web` changed. "Save to case" waits for Cases. The new Urdu strings need native review (#105). Plan: `plans/0039`.

## 2026-11-16

### `pnpm research:ask`, the answer path from the terminal (#191)
A CLI that runs the Research Hub answer path end to end, without the web and api in between:
- it calls `answer_question` with the same dependencies as `/ai/v1/research/answer`, so what it prints is what the route would return;
- it shows what the route hides: the provider and model, latency, finish reason, token usage, and the raw model reply, so format problems are visible;
- `--providers` is the api's allow-list, `--json` is for scripts, `--show-prompt` prints the numbered passages; log lines go to stderr.

Found on the way: the NIM preset `nvidia/nemotron-3-super-120b-a12b` is end-of-life (HTTP 410), so `.env.example` and the README move to `nvidia/nemotron-3.5-super-vl-120b-a12b`. The measurement itself is #192: the demo corpus is placeholders, and embedding the real seed laws needs a machine with more memory than the development laptop. Plan: `plans/0042`.

## 2026-11-18

### Documents contract and the ingestion handoff (#100)
The contracts for uploads (roadmap A8), so the API (#101), the web (#102) and the ingestion workers (Stream C) can be built in parallel:
- api.v1: upload to a case (multipart, PDF/DOCX/PNG/JPEG/TIFF by content sniffing, 25 MB), list with a `caseId` filter, get, download through the API, delete (purged by a retried job) and retry. Statuses `queued / processing / done / flagged / failed`, and `flags` that name the stage and page, so a flagged document is never shown as clean;
- ai.v1: apps/api submits each attempt (`POST …/ingestion`, 202, idempotent per attempt) and polls it (`GET …/ingestion`); services/ai never calls apps/api, and apps/api decides on retries from `retryable`. ADR-0010 records why: no callback endpoint, one writer per schema, and a crashed job can just run again;
- `DocumentFlag` and `DocumentMediaType` live in ai.v1 and api.v1 `$ref`s them, like `Language`.

Only contracts, generated types and docs changed. Plan: `plans/0046`.

### Cases in the web app (FR-CASE-1, FR-CASE-4, FR-CASE-5, #99)
`/cases` is no longer a placeholder. A user can now keep each matter as a case and its research with it:
- a list of active cases, with archived ones on their own tab, showing the case number, court, next hearing and when it was last updated;
- a form for a new case and for editing one, with the fields of Table 4.29; parties and relevant laws are lists, and the limits match the API's, so most mistakes show before anything is sent;
- a case dashboard with the details, the research saved to the case, Edit, Archive (after a confirmation) and Unarchive, and "Ask in this case"; Documents, Drafts and Precedents say when they arrive;
- in the Research Hub, a question asked from a case starts its conversation in that case, and an open conversation can be saved to a case or taken out of one.

Only `apps/web` changed. The new Urdu strings under `Cases` need native review (#105). Plan: `plans/0045`.

### Dashboard: recent research and cases (FR-DASH-1, #104)
`/` is no longer the shell placeholder. It now has:
- a "Start research" card that opens the Research Hub;
- the five most recent conversations, with a relative date, each opening its thread;
- the five most recently updated active cases, with case number, court and next hearing, each opening the case;
- loading, empty and error-with-retry states for each list on its own.

The trust-badge and API-status demo left the page. Drafts join once they have a contract. The recent-cases query sits under the cases module's query key (#99), so any case change refreshes it. The new Urdu strings need native review (#105). Plan: `plans/0047`.

### Case taxonomy v1 approved (#164)
The supervisor approved [`case-taxonomy.md`](case-taxonomy.md) on 2026-11-18 and accepted all six recommendations in §9. The four `(confirm)` SHC codes are still open. The vocabulary is now [`packages/contracts/taxonomy/case-taxonomy.v1.yaml`](../../packages/contracts/taxonomy/case-taxonomy.v1.yaml), and a services/ai test checks it against the collector's `matter_type_map.csv`. Sub-categories can grow inside an area. A new area or proceeding type means a v2. The classifier and the 200-judgment review moved to #200. Plan: `plans/0048`.

### Hugging Face storage set up (#151)
The `caseguard` org and the private dataset `caseguard/corpus` exist, and members have write access with their own tokens. `.env.example` already had `HF_TOKEN=` and `HF_CORPUS_REPO=caseguard/corpus`. The storage spec and the handoffs now name the real repo instead of `<org>/corpus`. #152 (snapshot push/pull/status) is unblocked.

### Notifications contract (#103)
The contract for roadmap A9, so the API and the web bell can be built while the document jobs (#101) land:
- `GET /notifications` lists the caller's notifications newest first, optionally only the unread ones, and always returns the unread total, so the bell shows a dot only when there is something to read;
- `POST /notifications/{id}/read` and `POST /notifications/read-all` mark them read;
- a notification says what happened to which document (`document_done`, `document_flagged`, `document_failed`) and carries no display text, so the web words it in English or Urdu.

Only contracts, generated types and docs changed. Plan: `plans/0051`.

## 2026-11-19

### Documents page and case uploads (FR-DOC-1, FR-DOC-3, FR-DOC-4, #102)
`/documents` and the case dashboard's Documents card are no longer placeholders:
- on a case, a file can be dropped or picked; the type (PDF, DOCX, PNG, JPEG, TIFF) and the 25 MB limit are checked before sending, and the API's refusals (too large, not a recognised type, archived case) are shown in words; an archived case shows its files but no uploader;
- every document shows its processing status, and the list refreshes itself while anything is queued or processing;
- a flagged document has a warning badge and lists what is uncertain (stage, page, message), so it never reads as clean; a failed one shows why;
- download (through the API, with the session), retry for failed or flagged documents, and delete after a confirmation;
- `/documents` lists all of the user's documents with a link to each case.

Built against the documents contract (#100) with stubbed API calls; the end-to-end check waits for the API (#101). Only `apps/web` changed. The new Urdu strings need native review (#105). Plan: `plans/0050`.

### Document uploads, storage and jobs in the API (#101)
The API half of roadmap A8, on the #100 contract:
- uploads to a case, up to 25 MB, with the type taken from the file's bytes (PDF, DOCX, PNG, JPEG, TIFF); anything else is a 415 and nothing is stored;
- files in a blob store outside the web root (`fs` driver on the Compose `uploads` volume; `s3` waits for demo hosting), downloads only through the API after the ownership check;
- pg-boss jobs: `document.ingest` submits each attempt to services/ai and polls it one step at a time, logs every stage per attempt, and retries up to 3 attempts before a document is `failed`, never dropped; `document.purge` removes the chunks, the file and the row after a delete;
- every status change goes through `setDocumentStatus`, the hook for notifications (#103).

pg-boss can't create its own schema as `caseguard_app` (ADR-0007), so `bootstrap.sql` now creates `pgboss`; an existing volume needs `pnpm db:rebootstrap`. services/ai has no ingestion yet (Stream C), so a real upload currently ends `failed` with "processing service is unavailable". Plan: `plans/0049`.

### Notifications: store, routes and the header bell (FR-NOT-1, #103)
- apps/api keeps each user's notifications in `app.notifications` and serves the contract's list, mark-read and mark-all-read; another user's notification is a 404.
- The header has a bell again. It asks for the unread count once a minute and shows a dot only when something is unread, so the dot `plans/0017` worried about is never permanent. It opens a sheet listing what happened to which document, in English or Urdu, each linking to its case.
- The document jobs (#101) create one, in the same transaction as the status change, when a document enters `done`, `flagged` or `failed`; never for `queued` or `processing`. A deleted document's notifications stay, with the filename, and lose only the link to it.

The new Urdu strings need native review (#105). Plan: `plans/0051`.

## 2026-11-21

### Contracts for precedents, drafting and the linter (#209)
The three remaining M3 screens (#106, #107, #108) were waiting on operations that didn't exist. One contract PR now adds all of them, so that three tracks can be built in parallel without conflicts in the specs.
- **Precedents.** Search is hybrid retrieval plus one graph hop, with every hit labelled `retrieved` or `graph_derived` and its graph flags (ADR-0011). A judgment's relationships come with provenance and status.
- **Drafting.** Templates for the bail application, plaint and legal notice. Drafts can be filled from a case and are saved with a version (409 if stale). AI assist for a section puts its citations through the trust layer. Drafts export to DOCX and PDF.
- **Linter.** It is deterministic and read-only (ADR-0012). Rule sets cite their sources, and a stored report keeps the text as sent, with its SHA-256.

Plan: `plans/0052`.

### The procedural linter's engine and rule sets (#214)
The first step of Track L (plan `0052`): services/ai now answers `GET /ai/v1/lint/rulesets` and `POST /ai/v1/lint`.
- Two versioned YAML rule sets, bail application first (ss.497 and 498 CrPC), then the plaint (Order VII CPC, verified under Order VI r.15). A rule cites its provision only where one plainly underlies it; FIR particulars, the prayer, the affidavit and similar practice requirements have `source: null`, which the web shows as "no rule source identified".
- The engine is pure and deterministic (ADR-0012): no database and no model, so it works with AI features off. Spans are UTF-16 offsets for the web, and `inputSha256` proves the text was not changed.
- Every rule has a seeded-defect test that produces exactly its finding, and the complete fixtures lint clean.

Next: lint reports in apps/api (#215) and the `/linter` screen (#108). Plan: `plans/0059`.
