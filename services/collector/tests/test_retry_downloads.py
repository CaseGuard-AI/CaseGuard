"""A judgment whose file could not be downloaded is fetched again on the next run.

On 2026-11-10 the SHC site answered HTTP 521/525 for a while: those judgments were stored as
head-note rows and, before this fix, marked done, so no rerun ever fetched their files.
"""

from __future__ import annotations

import json
from collections import Counter

import httpx

from main import failed_download_urls
from scrapers.shc_caselaw import SindhHighCourtScraper
from storage.state_store import StateStore
from tests.test_live_markup_147 import SHC_TABLE_URL, _build, _pdf_bytes


class Site:
    """Answers per download URL: "down" (HTTP 521), "pdf" or "html" (not a PDF)."""

    def __init__(self) -> None:
        self.answer: dict[str, str] = {}
        self.hits: Counter[str] = Counter()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.hits[url] += 1
        kind = self.answer.get(url, "pdf")
        if kind == "down":
            return httpx.Response(521, text="Web server is down")
        if kind == "html":
            return httpx.Response(
                200, text="<html>Sorry</html>", headers={"content-type": "text/html"}
            )
        return httpx.Response(
            # Each judgment's own text, or the second would be a duplicate of the first.
            200,
            content=_pdf_bytes(f"IN THE HIGH COURT OF SINDH. Judgment at {url}. " * 20),
            headers={"content-type": "application/pdf"},
        )


def _crawl(tmp_path, site: Site, rows: list) -> list[dict]:
    scraper = _build(SindhHighCourtScraper, "shc_caselaw", tmp_path, site, download_pdfs=True)
    scraper.discover = lambda: iter(rows)  # type: ignore[method-assign]
    try:
        scraper.run()
    finally:
        scraper.client.close()
        scraper.state.close()
    path = scraper.storage.combined_path
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _rows(tmp_path, fixture_html) -> list:
    scraper = _build(
        SindhHighCourtScraper,
        "shc_caselaw",
        tmp_path / "parse",
        lambda r: httpx.Response(404),
        download_pdfs=True,
    )
    rows = list(
        scraper._parse_table(fixture_html("shc_judge_table_relative.html"), SHC_TABLE_URL, "Judge")
    )
    scraper.client.close()
    scraper.state.close()
    linked = [r for r in rows if r.hint("download_url")]
    assert len({r.url for r in linked}) >= 2
    return linked[:2]


def test_a_failed_download_is_retried_and_replaces_the_headnote_row(tmp_path, fixture_html):
    down, fine = _rows(tmp_path, fixture_html)
    site = Site()
    site.answer[down.url] = "down"

    first = _crawl(tmp_path, site, [down, fine])
    by_url = {r["document_url"]: r for r in first}
    assert by_url[down.url]["raw"]["file_status"] == "download_failed"
    assert by_url[down.url]["raw"]["headnote_only"] is True
    assert by_url[fine.url]["raw"]["file_status"] == "ok"

    site.answer[down.url] = "pdf"  # the site is back
    hits_before = dict(site.hits)
    records = _crawl(tmp_path, site, [down, fine])
    retried = [r for r in records if r["document_url"] == down.url]
    assert [r["raw"]["file_status"] for r in retried] == ["download_failed", "ok"]
    assert retried[0]["id"] == retried[1]["id"]  # same id: the loader upgrades the row
    assert retried[1]["raw"]["headnote_only"] is False and retried[1]["full_text"]
    # The judgment that was fine is not fetched again.
    assert site.hits[fine.url] == hits_before[fine.url]


def test_a_file_that_is_not_a_pdf_is_not_fetched_every_run(tmp_path, fixture_html):
    broken, _ = _rows(tmp_path, fixture_html)
    site = Site()
    site.answer[broken.url] = "html"
    _crawl(tmp_path, site, [broken])
    hits = site.hits[broken.url]
    records = _crawl(tmp_path, site, [broken])
    assert site.hits[broken.url] == hits
    assert [r["raw"]["file_status"] for r in records] == ["not_pdf"]


def test_records_stored_before_the_fix_can_be_requeued(tmp_path, fixture_html):
    down, fine = _rows(tmp_path, fixture_html)
    site = Site()
    site.answer[down.url] = "down"
    first = _crawl(tmp_path, site, [down, fine])
    # Simulate a state.db written before this fix: everything marked done.
    data = tmp_path / "data"
    store = StateStore(data / "state" / "state.db")
    store._conn().execute("UPDATE seen SET status='ok'")
    store._conn().commit()

    combined = data / "documents" / "shc_caselaw.jsonl"
    urls = failed_download_urls(combined)
    assert down.url in urls and fine.url not in urls
    assert store.requeue(urls) == 1
    assert store.should_process(down.url) and not store.should_process(fine.url)
    store.close()

    site.answer[down.url] = "pdf"
    records = _crawl(tmp_path, site, [down, fine])
    assert len(records) == len(first) + 1
    assert records[-1]["raw"]["file_status"] == "ok"
    # Once fetched, nothing is left to requeue.
    assert failed_download_urls(combined) == []
