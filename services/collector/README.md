> **CaseGuard monorepo note.** This service was imported from `CaseGuard-AI/data_collector` with `git subtree`, and **this folder is now the source of truth**; the old repo should be archived. Inside CaseGuard:
>
> ```bash
> cd services/collector
> uv sync --all-extras --dev     # creates services/collector/.venv
> uv run python main.py --help
> uv run pytest
> ```
>
> Settings are read from `.env` here, or from the repo-root `.env` (`PKLEGAL_*` variables; see the root `.env.example`). The collector writes only to the `corpus` schema, as role `caseguard_ai` (ADR-0002). Sources follow the PRD §15 source policy: LHC stays disabled without written permission.

# pk-legal-ingest

A provenance-tracked ingestion pipeline for Pakistani legal documents — federal
statutes, provincial legislation, and court judgments — built as the data layer
for a legal RAG system.

The design goal is not "download as much as possible". It is: **every record in
the corpus can be traced back to the exact page and file it came from, so an AI
answer built on it can cite the original.** That constraint drives most of the
decisions below, including the ones that make the crawler slower or narrower
than it could be.

---

## 1. Source verification log

This matters more than the code. Before anything was written, each target site
was inspected live. Sources are labelled honestly, and **no selectors, form
fields or endpoints were invented for sites that could not be inspected.**

Checked: 16 September 2026.

| Source | Status | What was confirmed | What was not |
|---|---|---|---|
| **Pakistan Code** `pakistancode.gov.pk` | ✅ `verified` | Server-rendered HTML. Alphabetical index at `/english/LGu0xAD?alp=<A-Z>&page=<n>&action=<inactive\|active\|null\|notactive>`; also `/english/LGu0xBD.php` (chronological) and `/english/LGu0xVD.php` (category). Detail links are opaque tokens ending `-sg-jjj…`. Statute text lives **only** in a PDF at `/pdffiles/administrator<hash>.pdf`, embedded via ViewerJS. Metadata is a pipe-delimited line: `General Laws \| XVIII of 1999 \| Promulgation Date: September 24 1999. \| Archive 0 \| Under Review` | CSS class names (the parser deliberately does not use them) |
| **Sindh High Court** `caselaw.shc.gov.pk` | ✅ `verified` | Plain HTML tables. Judge index at `/caselaw/public/rpt-afr` links to per-judge tables at `/caselaw/public/reported-judgements-detail-all/<judge_id>/{-1\|AFR/AFR}` — **~70,000 judgments across 33 sitting judges**, each row carrying citation, case no./type/year, parties with roles, bench, judges, order date, head-note, attached cases and connected SCP status, plus a direct file link at `/caselaw/download-file.php?doc=<token>`. Sibling reports: `rpt-benchwise`, `rpt-cat-judgement`, `rpt-sbdb-cons`, `rpt-jo` | Keyword/advance search forms (`pview.php?rpt=search`). Not needed — the judge index already reaches the whole corpus |
| **Federal Shariat Court** `federalshariatcourt.gov.pk` | ✅ `verified` (leading cases) | Reachable, responds normally. Judgment PDFs served directly from `/Judgments/<name>.pdf` with the petition number in the filename (separators are inconsistent: `S.P.NO.36-L-1992.pdf`, `Shariat Petition No. 29 - I - of 1993.pdf`). Leading-judgements table at `/en/leading-judgements/` (≈`?p=209`): S.No. \| Title \| Reference with Date of Decision \| Download — ~70 landmark cases back to 1980, several with `PLD-2023 FSC-301`-style citations | Paging/filter parameters of the bulk `/judgement.php` CFMS listing (reported 25,000+ judgments). Read with a plain GET only — see §10 |
| **Supreme Court** `supremecourt.gov.pk`, `scp.gov.pk` | ⚠️ `needs_probe` | Judgment PDFs are served from `https://scp.gov.pk/files/judgments/<CASE>.pdf` (case number in the filename, e.g. `C.P._3451_2017.pdf`). Endpoints `/latest-judgements/`, `/judgement-search/`, `/cause-list-search/`, `/online-case-status/` exist. `scp.gov.pk/JudgmentSearch.aspx` is ASP.NET WebForms, so any search POST needs `__VIEWSTATE`/`__EVENTVALIDATION` scraped from a prior GET | **Everything about the DOM.** Both domains returned bot-protection challenges to automated requests. Run `--probe` from your own network before trusting the parser |
| **Lahore High Court** `lhc.gov.pk`, `data.lhc.gov.pk` | ⛔ `blocked_by_robots` | Collections exist under `/reported_judgments/…` (`judgments_approved_for_reporting`, `…_by_former_judges`, `green_bench_orders`) with an AJAX backend at `/dynamic/approved_judgments_result_new.php?year=<yyyy>`; Rules & Orders volumes at `/rules_and_orders` | Nothing was fetched. **robots.txt disallows automated access**, and the site carries an explicit notice that its content may not be downloaded without prior permission. Ships disabled — see §9 |

### Why Sindh High Court replaced Lahore High Court in the MVP

The brief asked for Pakistan Code + Supreme Court + Lahore High Court. LHC is
off the table without permission, and SCP could not be inspected. SHC was
substituted because it is reachable *and* publishes the richest free case
metadata of any Pakistani court portal. The MVP is therefore:

1. **Pakistan Code** — statutes (working end to end)
2. **Sindh High Court** — judgments (working end to end, ~70k reachable)
3. **Federal Shariat Court** — judgments (working end to end for leading cases)
4. **Supreme Court** — judgments (scaffolded, needs one probe from your network)

Three working court/statute sources instead of the one the brief could have
produced, and none of them required ignoring a robots.txt.

---

## 2. Install

Python 3.11+.

```bash
git clone <your-repo> && cd pk-legal-ingest
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env          # then edit it — see below
```

**Edit the user agent in `.env` before your first run.** Put a real contact
address in it. That is what makes a site administrator email you instead of
silently blocking your university's IP range:

```
PKLEGAL_USER_AGENT="PKLegalFYP-Research-Crawler/0.1 (FYP, <university>; contact: you@university.edu.pk)"
```

OCR is optional and off by default. It needs the tesseract binary:
`sudo apt install tesseract-ocr` / `brew install tesseract`.

### Prove it works without touching the internet

```bash
python tools/demo_offline_run.py
```

This spins up a local replay server that serves the structures captured from
pakistancode.gov.pk and runs the whole pipeline against it — discovery, PDF
download, text extraction, hashing, dedup, JSONL, crawl state, report. Run it
twice: the second run should fetch nothing and skip everything, which is the
incremental path working.

---

## 3. Usage

```bash
python main.py --list-sources                      # what's implemented, and its status

# test mode — a handful of documents
python main.py --source pakistan_code --limit 10
python main.py --source shc_caselaw --limit 25

# see what would happen without writing anything
python main.py --source pakistan_code --max-pages 2 --dry-run

python main.py --source federal_shariat_court --limit 10

# real runs
python main.py --source pakistan_code
python main.py --source all --start-year 2020 --end-year 2026

# SHC holds ~70k judgments: take metadata first, files later
python main.py --source shc_caselaw --no-pdfs           # fast metadata pass
PKLEGAL_SHC_SCOPE=all python main.py --source shc_caselaw --no-pdfs

# re-attempt only what failed, without re-walking the site
python main.py --retry-failed --source pakistan_code

# third-party bootstrap corpora (kept provenance-separate, see §10)
python main.py --list-bootstrap
python main.py --bootstrap pakistan_laws --limit 50
python main.py --bootstrap-compare pakistan_laws        # is your crawl complete?

# Supreme Court: probe first, from your own network
python main.py --source supreme_court --probe
python main.py --source supreme_court --ingest-dir ./manual_pdfs   # hand-downloaded PDFs

# inspection
python main.py --report        # last run's validation report
python main.py --status        # crawl-state counts
python main.py --sample 5 --source pakistan_code

# load JSONL into Postgres once the corpus is stable
export PKLEGAL_DATABASE_URL='postgresql+psycopg://user:pass@localhost:5432/pklegal'
python main.py --load-db --source pakistan_code
```

Useful flags: `--delay`, `--timeout`, `--retries`, `--concurrency`,
`--max-pages`, `--limit`, `--start-year`, `--end-year`, `--no-pdfs`, `--ocr`,
`--force`, `--dry-run`, `--output-dir`, `--log-level`.

There is no `--ignore-robots`. It is accepted and then refused, because the
right response to a disallow is to ask the site owner, not to route around it.

---

## 4. Layout

```
pk-legal-ingest/
├── main.py                     CLI
├── config.py                   settings + per-source access policy
├── models/legal_document.py    the normalised schema + validation
├── scrapers/
│   ├── base_scraper.py         the shared run loop (see below)
│   ├── pakistan_code.py        ✅ verified
│   ├── shc_caselaw.py          ✅ verified (~70k judgments)
│   ├── federal_shariat_court.py ✅ verified (leading cases)
│   ├── supreme_court.py        ⚠️  needs probe; has --probe and --ingest-dir
│   ├── lahore_high_court.py    ⛔ permission-gated, ships disabled
│   ├── _template.py            copy this to add a court
│   └── registry.py             key -> class
├── extractors/                 html / pdf / metadata
├── storage/
│   ├── state_store.py          SQLite: seen URLs, content hashes, failures
│   ├── jsonl_storage.py        primary output
│   ├── file_storage.py         original PDFs + extracted text
│   ├── database.py             SQLAlchemy models (Postgres-ready, optional)
│   └── bootstrap_datasets.py   third-party HF corpora, provenance-separated
├── utils/                      http client, rate limiter, robots, hashing, dates, logging
├── pipeline/                   runner + validation report
├── tools/demo_offline_run.py   offline end-to-end smoke test
├── tests/                      116 tests
└── docs/example_output.json    real output from the offline run
```

A concrete scraper implements exactly two methods:

```python
def discover(self) -> Iterator[Discovered]:            # find candidate documents
def parse_document(self, item, response) -> LegalDocument | None
```

Politeness, retries, skip-if-seen, conditional GETs, PDF download and
extraction, hashing, duplicate detection, validation, storage and failure
tracking all live in `BaseScraper` and happen once. That split is why adding a
court is ~150 lines of parsing rather than a copy of the pipeline.

---

## 5. The data model

`models/legal_document.py`. Every record carries `source`, `source_website`,
`source_url`, plus `document_url` / `document_file_url` / `file_path` so the
original is always reachable.

**The rule the whole project hangs on: a field is populated only when the source
actually stated it.** `None` means "the source did not say", never "we guessed".
Anything inferred rather than read goes into `notes`, so provenance stays
honest. Empty fields are dropped from the JSON rather than written as `null`.

A real record from `docs/example_output.json` (produced by the offline run, so
the host is the replay server — against the live site these are
`pakistancode.gov.pk` URLs):

```jsonc
{
  "source": "pakistan_code",
  "source_website": "https://pakistancode.gov.pk",
  "source_url":   "https://pakistancode.gov.pk/english/UY2FqaJw1-…-sg-jjjjjjjjjjjjj",
  "document_url": "https://pakistancode.gov.pk/english/UY2FqaJw1-…-sg-jjjjjjjjjjjjj",
  "document_file_url": "https://pakistancode.gov.pk/pdffiles/administrator<hash>.pdf",
  "id": "pakistan_code-b3176153d2cb234a6f064a0c",
  "document_type": "ordinance",
  "title": "National Accountability Ordinance, 1999",
  "document_number": "XVIII of 1999",
  "category": "General Laws",
  "case_status": "Under Review",
  "jurisdiction": "Pakistan",
  "date": "1999-09-24",
  "promulgation_date": "1999-09-24",
  "full_text": "AN ACT to provide for …",
  "language": "en",
  "file_path": "data/raw/pakistan_code/1999/National_Accountability_Ordinance_1999_c4ba49b5a205.pdf",
  "mime_type": "application/pdf",
  "page_count": 1,
  "content_hash": "196391785a84ec46…",
  "extraction_status": "ok",
  "scraped_at": "2026-09-16T18:46:47+00:00",
  "raw": {
    "meta_line": "General Laws | XVIII of 1999 | Promulgation Date: September 24 1999. | Archive 0 | Under Review",
    "pdf_sha256": "946691b2ce83d96e…"
  }
}
```

`raw` keeps the source's own fields verbatim, so nothing is lost to
normalisation and you can always re-derive a field later without re-crawling.

Case-law records additionally use `case_number`, `court`, `bench`, `judges`,
`parties` (with roles), `advocates`, `citation`, `matter_type`, `case_status`,
`connected_cases`, `cited_laws`, `cited_cases`, `summary` (the court's own
head-note / tag line), `judgment_date`, `hearing_dates`.

`id` is a stable hash of `source + document_url`, so re-running upserts instead
of duplicating.

---

## 6. Incremental scraping and deduplication

`storage/state_store.py` — a SQLite database with three tables:

- **`seen`** — one row per processed URL, with `content_hash`, `etag`,
  `last_modified`, `revision`, `status`. Drives skip-if-seen, change detection,
  and conditional `If-None-Match` / `If-Modified-Since` requests (a 304 costs
  almost nothing).
- **`hashes`** — `content_hash → first document that carried it`. This catches
  **cross-URL duplicates**, which is not hypothetical: the Pakistan Code index
  lists the same statute under several sections, so URL-level dedup alone is not
  enough. Duplicates are recorded and flagged, not stored twice.
- **`failures`** — failed URLs with attempt counts, so a retry pass doesn't have
  to re-walk the whole site.

Content hashes are computed over whitespace- and case-normalised text, so
reformatting doesn't masquerade as a new version.

Documents that fail validation are stored **flagged**, not dropped — losing them
silently would hide gaps in the corpus — and are re-tried on the next run, which
is what you want when you later switch OCR on.

---

## 7. PDF pipeline

Most Pakistani legal text is in PDFs, so this path is deliberate:

1. Download, save the original untouched under `data/raw/`, record its SHA-256.
2. Extract text with **PyMuPDF**, falling back to **pdfplumber** on odd layouts.
3. Classify: `ok` / `empty` / `scanned_no_ocr` / `failed`, using a
   characters-per-page threshold to tell a born-digital PDF from a scan.
4. Save extracted text separately under `data/text/`.
5. Optional OCR (`--ocr`) rasterises at 300 dpi and runs tesseract.

**A PDF whose text extraction fails is never silently discarded.** It is stored
with `extraction_status` and `extraction_error` set, counted in the report, and
picked up again on a later run. A URL that returns HTML instead of a PDF is
caught by magic bytes rather than trusting the `Content-Type` header.

Every record that links a file says what happened to it in `raw.file_status`:
`ok`, `not_downloaded` (`--no-pdfs`), `download_failed`, `empty`, `not_pdf` or
`missing_link`. An empty body or a non-PDF is never saved under `raw/`. About 1
in 10 SHC downloads is one of these (#147). A cached file on disk is reused only
if it really is a PDF.

Filenames embed a hash of the source URL (`<slug>_<urlkey>.pdf`), so two
documents with the same title never collide and any file traces back to its URL.

---

## 8. Robustness and the validation report

`utils/http_client.py` is the single door every request goes through: robots
check → per-host politeness delay → request → retry with exponential backoff and
jitter. TLS is always verified, against certifi's roots plus the intermediates
bundled in `certs/extra-intermediates.pem` (`utils/tls.py`). pakistancode.gov.pk
sends the wrong intermediate, so a strict client can't build its chain without
that file (#147). robots.txt is fetched with the same trust; a host whose
certificate fails there is skipped, not treated as "no robots.txt". Links are
resolved like a browser does (`utils/links.py`): against `<base href>` when the
page has one, and never from inside an HTML comment.
It honours `Retry-After`, backs a host off further after a 429/503, and
**never retries a 400/401/403/404/410** — those will not succeed and retrying
them is just noise on someone's server.

A failure on one document never kills the run; a failure on one source never
kills the others.

Every run writes `data/reports/report_<run_id>.txt` and `.json`:

```
  Total discovered        : 3
  Total fetched           : 3
  Total parsed            : 3
  Total stored            : 3
  Total duplicates        : 0
  Total failed            : 0
  Skipped (already seen)  : 0
  Skipped (304 unchanged) : 0
  Changed since last run  : 0

  PDF documents           : 3
  HTML documents          : 0
  PDF extraction failures : 0
  Scanned PDFs (need OCR) : 0

  Failed validation       : 0
  Missing title or date   : 1
```

Plus a structured JSONL event log per run, which is what the report is built
from — so it reflects what happened, not what the code intended.

---

## 9. Ethics, and the Lahore High Court situation

Only publicly accessible material is collected. robots.txt is respected; there
is no override. Authentication, CAPTCHAs, paywalls and anti-bot protections are
never bypassed. Commercial databases (PakistanLawSite, paklawportal,
paklegaldatabase) are **not** scraped — use them manually to spot-check
citations in your curated precedent set, which is exactly the use your reference
document describes.

**Lahore High Court is disabled and gated behind two locks** (an environment
variable *and* `--i-have-permission`). robots.txt disallows it and the site
states its content may not be downloaded without prior permission. That is the
site owner saying no, not an obstacle to engineer around.

The right move for an FYP is to write to the LHC IT section / Registrar,
explain the academic purpose and the non-commercial scope, and ask for
permission or a data extract. Universities get these granted more often than you
would expect, and a permission letter is a genuinely strong artefact to put in
your report. Do the same for the Supreme Court if the probe comes back
challenged.

---

## 10. Known limitations — read before writing your methodology chapter

Be straight about these in the report; examiners respect it.

1. **SHC is reachable in full, but you still have to be deliberate about it.**
   The judge index reaches roughly 70,000 judgments. Do a `--no-pdfs` metadata
   pass first, then fetch files selectively. `PKLEGAL_SHC_SCOPE` defaults to
   `afr` (judgments the court approved for reporting — smaller, and the ones
   that carry citations); set it to `all` for everything.
2. **FSC coverage is leading cases plus the default listing.** The bulk
   `/judgement.php` CFMS page is read with a plain GET; its paging parameters
   were not inspected. Open it in a browser, watch the request when you change
   year or page, and add it to `JUDGEMENT_LIST_PARAMS`. Say this plainly in
   your methodology rather than implying full FSC coverage.
3. **Supreme Court is unproven.** The parser matches judgment-PDF URL patterns
   and reads the surrounding text block. That is deliberately crude: it either
   works against the real markup or finds nothing and says so loudly. Probe
   first, then tighten it.
4. **SHC `full_text` may be the head-note, not the judgment.** Where no judgment
   file is linked, or the file couldn't be used, the record carries the listing
   entry, **`raw.headnote_only: true`**, and a `notes` entry saying exactly why.
   Loaders and the index read the flag, not the note. Do not let those records into the RAG index unlabelled —
   a retrieved head-note presented as the full judgment is the kind of error
   that discredits the whole system.
5. **Metadata heuristics are heuristics.** Judge names are parsed only from
   fields the source labels as the bench, never from judgment bodies (otherwise
   you collect judges merely cited in precedent). Case-type splitting uses a
   vocabulary of abbreviations observed on the live SHC listing; an unrecognised
   type keeps the whole string as the title and flags it rather than guessing.
6. **Urdu.** Pakistan Code has Urdu mirrors; nothing here handles Urdu text
   extraction or the RTL issues that come with it.
7. **Provincial legislation, National Assembly, Senate, Gazette, FCC, IHC,
   PHC, BHC and district courts are not implemented** — they are listed in
   `PLANNED_SOURCES` so `--list-sources` stays honest about it.

### On the Hugging Face datasets

`AyeshaJadoon/Pakistan_Laws_Dataset` (~969 laws) and
`Ibtehaj10/supreme-court-of-pak-judgments` are useful for bootstrapping and for
**validating your own scraper's output** — if your Pakistan Code run produces
wildly fewer statutes than 969, something is wrong with your discovery loop.

`storage/bootstrap_datasets.py` loads them, and enforces the boundary so you
cannot get this wrong by accident. Every record:

* gets a `source` key prefixed `hf_` — never `pakistan_code` or a court key
* has `source_url` pointing at the dataset page, never a gov.pk URL
* has `document_url` left **empty**, because there is no original to link to
* carries `is_official_source: false` and `provenance: third_party_dataset` in
  `raw`, plus a note telling you to verify before citing

Carry that flag into your vector store. If a retrieved chunk came from here, the
answer must say "from a third-party dataset, verify against the Pakistan Code"
rather than citing a government URL it never fetched.

The coverage check is the most useful part for your report:

```bash
python main.py --bootstrap-compare pakistan_laws
```

It compares your crawl against the dataset's ~969 statutes and warns if you are
more than 20% short — which usually means discovery is missing index pages, not
that the corpus is genuinely smaller.

---

## 11. Adding a court

Copy `scrapers/_template.py`. Before writing code, answer these six questions
about the live site and put the answers in the module docstring the way
`pakistan_code.py` does:

1. How are documents discovered? (index / search / sitemap / API)
2. How does pagination work?
3. How is a document downloaded? (inline HTML / PDF link / viewer iframe)
4. Where does metadata live? (listing row / detail page / PDF header)
5. Is JavaScript required — and if so, is there an XHR you can call directly
   instead of driving a browser?
6. What do robots.txt and the site's terms say?

If you cannot answer one from the live site, **say so in the docstring and mark
the source `needs_probe` in `config.py` rather than guessing.** Then add one
line to `config.SOURCES` and one to `scrapers/registry.py`.

Browser automation is a last resort. Prefer the underlying XHR — it is faster,
more stable, and far gentler on the court's server.

---

## 12. Tests

```bash
pytest                    # 137 tests
pytest --cov              # with coverage
```

Covering URL discovery, HTML extraction, PDF extraction (including corrupt,
blank/scanned and missing files), metadata extraction, date normalisation,
hashing, duplicate detection, incremental skip/change detection, retry and
backoff behaviour (mocked transport — no live requests), storage round-trips,
and database insertion (SQLite, so no Postgres server needed).

Writing them caught seven real bugs, which is the main argument for keeping them:

- `"September".replace("Sept", "Sep")` produced `"Sepember"` — every September
  date silently normalised to `None`
- the judge regex treated "Agha" as an honorific and parsed **Agha Faisal** as
  "Faisal"
- `clean_text` collapsed all paragraph breaks
- the SHC case-type regex was non-greedy and turned "Civil Revision" into
  "Civil"
- the party splitter handled `V/S` and lowercase `vs` but not uppercase `VS`,
  which is what the SHC tables actually print — every party silently lost
- judge parsing missed ALL-CAPS judgment headers entirely (`MR. JUSTICE DR.
  SYED MUHAMMAD ANWER`), and once fixed returned names in caps, which would
  have produced duplicate rows in the `judges` table
- **crawl state was keyed on `document.source_url`**, but sources that discover
  documents from an index set that to the *listing page*, so many documents
  collapsed onto one state row and the whole source re-downloaded every run.
  Now keyed on the URL actually fetched

---

## 13. Where this fits in the RAG pipeline

```
Raw sources → scrapers → raw documents (+ original PDFs)
           → text extraction → cleaning → metadata extraction → deduplication
           → chunking → embeddings → vector DB → retriever → LLM
           → citation-grounded answer
```

This project covers everything down to deduplication, and preserves what the
citation step needs: `source_url`, `document_url`, `document_file_url`,
`title`, `document_number` / `case_number`, `citation`, `court`, `date` — plus
`notes`, which tells you when a field was inferred rather than read.

When you build the chunker, carry `id`, `source_url`, `title` and
`raw.is_official_source` onto every chunk. A chunk that cannot name its source
cannot be cited, and an uncitable answer is the failure mode this entire design
exists to prevent.

---

## 14. Suggested order of work

1. `python tools/demo_offline_run.py` — confirm the plumbing before touching a
   real site.
2. `python main.py --source pakistan_code --limit 10` — your first live run.
   Then the full statute corpus; it is small and finishes quickly.
3. `python main.py --bootstrap-compare pakistan_laws` — check your statute count
   against the ~969 in the reference dataset. Fix discovery before moving on.
4. `python main.py --source shc_caselaw --no-pdfs` — metadata for the case-law
   corpus. This is the single biggest win available to you.
5. `python main.py --source federal_shariat_court` — small, high-value, includes
   the landmark constitutional decisions.
6. `python main.py --source supreme_court --probe` from a normal connection, and
   send the LHC permission letter the same day — the reply takes weeks.
7. Only then start chunking and embedding.
