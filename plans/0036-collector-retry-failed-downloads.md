> **Status:** In review · **Issue:** none (found on the first `shc-civil` crawl, 2026-11-10)

# Collector: retry files whose download failed

## Context

During the first `--partition shc-civil --limit 300` crawl, the SHC site answered HTTP 521/525 (Cloudflare: origin down) for a while. 24 judgments were stored as head-note rows with `raw.file_status = download_failed` and marked `ok` in `state.db`, so no rerun would ever fetch their files. `--retry-failed` only re-requests the URL. It doesn't re-ingest, because the record is still marked seen.

## Decisions

- **A failed download is a passing problem.** `_store` still writes the record, so the metadata isn't lost, but marks its crawl state `retry` and keeps the open failure. `should_process` already treats every status other than `ok` as not done, so the next run of the same crawl processes it again.
  - A success writes the full judgment under the same id (the id comes from the URL).
  - The corpus loader (#16, #166) replaces the head-note row.
- **`empty` and `not_pdf` are the file itself, not a passing problem.** They stay `ok` and aren't fetched every run; `--force` still re-fetches them.
- **The rule is generic** (any source using `ingest_pdf`), keyed on `raw.file_status`, which `ingest_pdf` sets.
- **Records stored before the fix:** `--requeue-failed-downloads` reads the crawl's combined JSONL. It takes the latest line per id, so judgments already re-fetched are skipped, and sets `retry` on the URLs whose record is still `download_failed`. Both the document URL and the source URL are tried, because the state key differs by source.

## Verification

- `ruff` is clean, and `pytest` gives 173 passed. `tests/test_retry_downloads.py` (3, with `httpx.MockTransport`) covers:
  - 521 on the first run means a head-note record with `download_failed`; on the second run, the PDF is stored under the same id and the healthy judgment isn't re-fetched;
  - a non-PDF answer isn't re-fetched on the next run;
  - a pre-fix `state.db` (all `ok`): requeue finds exactly the failed one, the rerun fetches it, and nothing is left to requeue.
- **Mutation check:** marking failed downloads `ok` again makes the retry test fail.
