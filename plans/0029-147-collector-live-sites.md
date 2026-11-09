> **Status:** In progress · **Issue:** [#147](https://github.com/CaseGuard-AI/CaseGuard/issues/147) · **PR:** _TBD_

# #147: collector live-site fix (TLS chain, relative links, non-PDF downloads)

## Context

**Why:** the live sample in #139 showed the collector storing **0 statutes and 0 SHC judgment files**. It is the first item on the handoff's critical path (`docs/engineering/handoff.md` §2): partitions (#153), snapshots (#152) and the whole M1 data path need a working crawl.

**Requirements:** NFR-1 (provenance), NFR-14 (robots/terms), PRD §15; collector README §10.4 (head-note-only records).

## What the live sites do now (captured 2026-11-09)

- **pakistancode.gov.pk** sends the intermediate `GoGetSSL RSA DV SSL CA 2`, but its leaf was issued by `GoGetSSL RSA DV CA`. Without the right intermediate there's no path to a root, so httpx fails with `CERTIFICATE_VERIFY_FAILED`. The right one is at the leaf's AIA URL (`http://crt.usertrust.com/GoGetSSLRSADVCA.crt`). It's issued by USERTrust RSA, which is in certifi, and valid until 2028-09-05.
- **Pakistan Code index:** detail links are relative, `href="UY2FqaJw1-…-sg-jjjjjjjjjjjjj"`, with no `/english/`. The metadata line sits in the *next sibling* block (`.accordion-section-content`), not in the title's block. Detail pages link the PDF absolutely, plus a ViewerJS iframe `#../pdffiles/…`.
- **SHC judge tables:** `<base href="/caselaw/" />`, and in the Case No. cell `<a href="download-file.php?doc=…&citation=…">`. The old `view-file/…` link sits inside an HTML comment just above it.

## Decisions

- **TLS: add, never weaken.**
  - `utils/tls.py::ssl_context()` is certifi's roots plus the committed `certs/extra-intermediates.pem`. The chain must still end at a trusted root.
  - The httpx client and the robots.txt fetch use the same context.
  - A **certificate failure on robots.txt skips the host** (fail closed, NFR-14). Before, it was silently "allow-all".
  - robots.txt is always verified, even with the old `PKLEGAL_VERIFY_TLS=0`.
- **Links resolve like a browser** (`utils/links.py`): against `<base href>` if present, else the page URL. Comments are stripped before any raw-text scan.
  - Pakistan Code matches `DETAIL_HREF` against the *resolved* path.
  - SHC passes the `<base>` URL only for links. The no-file fallback URL (`<judge page>#case=N`) is unchanged, so record ids and provenance stay stable.
- **File outcome is explicit:**
  - `raw.file_status` is `ok | not_downloaded | download_failed | empty | not_pdf | missing_link` (new `FileStatus` enum).
  - SHC sets **`raw.headnote_only`** true or false, and the note says why. #16 and #18 read the flag, not the note text.
  - A non-PDF body is never saved. A cached file is reused only if its bytes start `%PDF-`.

## Changes

- New files:
  - `services/collector/utils/tls.py`
  - `services/collector/utils/links.py`
  - `services/collector/certs/extra-intermediates.pem`
- Changed:
  - `utils/http_client.py` and `utils/robots.py`: the TLS context, fail closed.
  - `scrapers/pakistan_code.py`: relative links, sibling metadata, PDF forms.
  - `scrapers/shc_caselaw.py`: `<base href>`, file_status, headnote_only.
  - `scrapers/base_scraper.py::ingest_pdf`: file_status, the cached-file check.
  - `models/legal_document.py`: `FileStatus`.
- `certifi` is now a direct dependency (`pyproject.toml`, `uv.lock`, `requirements.txt`).
- Tests: `tests/test_live_markup_147.py` (21 tests), with fixtures trimmed from the live pages: `pakistan_code_index_relative.html` and `shc_judge_table_relative.html`.
- Docs: the collector README (§7, §8, §10.4, test count), the handoff (§1, §2 row 1, §5 gotchas) and CHANGELOG.

## Verification

- `uv run pytest`: **137 passed**, where there were 116 before. `ruff check` and `ruff format --check` are clean. `mypy` reports the same 15 errors as `staging` (CI treats it as a warning only); none are new.
- **Live acceptance** (output to a scratch dir):
  - `main.py --source pakistan_code --limit 5`: discovered 6, **stored 5, all with PDFs**, 0 failures.
  - `main.py --source shc_caselaw --limit 5`: **stored 5, 4 with judgment PDFs** (`file_status=ok`, `headnote_only=false`). One returned a non-PDF and is stored as `file_status=not_pdf`, `headnote_only=true`, and nothing was saved under `raw/`.

## Not in this PR

- Partitions and selection files (#153). Snapshots (#152).
- Setting a real contact address in `PKLEGAL_USER_AGENT`. That's a human action, needed before any full crawl.
