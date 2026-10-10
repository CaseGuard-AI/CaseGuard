"""Sindh High Court: judge index -> per-judge table -> normalised judgments.

Fixtures mirror the live markup, including the two column layouts the portal
serves, which is why the parser maps cells by header name.
"""

import httpx
import pytest

from config import SOURCES, Settings
from scrapers.shc_caselaw import SindhHighCourtScraper
from storage.file_storage import FileStorage
from storage.jsonl_storage import JsonlStorage
from storage.state_store import StateStore
from utils.http_client import HttpClient
from utils.logging_config import JsonlEventLogger
from utils.rate_limiter import RateLimiter


@pytest.fixture
def scraper(tmp_path, fixture_html, monkeypatch):
    monkeypatch.setenv("PKLEGAL_SHC_SCOPE", "afr")
    settings = Settings()
    settings.output_dir = tmp_path / "data"
    settings.request_delay = 0.0
    settings.download_pdfs = False
    settings.ensure_dirs()

    index = fixture_html("shc_judge_index.html")
    table = fixture_html("shc_judge_table.html")
    listing = fixture_html("shc_listing.html")

    def handler(request):
        url = str(request.url)
        if "rpt-afr" in url:
            return httpx.Response(200, text=index, headers={"content-type": "text/html"})
        if "reported-judgements-detail-all" in url:
            return httpx.Response(200, text=table, headers={"content-type": "text/html"})
        if "top-trend-judgements" in url:
            return httpx.Response(200, text=listing, headers={"content-type": "text/html"})
        return httpx.Response(404)

    # backoff is capped here only so the suite stays fast; the retry logic
    # itself is exercised properly in tests/test_retry.py
    client = HttpClient(
        "test",
        respect_robots=False,
        retry_count=2,
        backoff_base=1.0,
        backoff_cap=0.01,
        rate_limiter=RateLimiter(0.0, 4),
    )
    client._client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)
    instance = SindhHighCourtScraper(
        settings=settings,
        client=client,
        state=StateStore(settings.state_db),
        files=FileStorage(settings.raw_dir, settings.text_dir),
        storage=JsonlStorage(settings.jsonl_dir, "shc_caselaw"),
        events=JsonlEventLogger(settings.log_dir / "e.jsonl"),
        source_config=SOURCES["shc_caselaw"],
    )
    client.rate_limiter.set_host_delay(SOURCES["shc_caselaw"].base_url, 0.0)
    client.rate_limiter.default_delay = 0.0
    instance._fixtures = {"index": index, "table": table, "listing": listing}
    yield instance
    client.close()
    instance.state.close()


# ---- judge index -----------------------------------------------------
def test_judge_index_picks_the_afr_links_in_afr_scope(scraper):
    judges = scraper._judge_pages()
    assert len(judges) == 2
    assert all(url.endswith("/AFR/AFR") for _, url in judges)
    assert judges[1][0] == "Hon'ble Justice Mrs. Kausar Sultana Hussain"


def test_scope_all_picks_the_full_listing_links(scraper, monkeypatch):
    monkeypatch.setenv("PKLEGAL_SHC_SCOPE", "all")
    assert all(url.endswith("/-1") for _, url in scraper._judge_pages())


def test_unknown_scope_falls_back_to_afr(scraper, monkeypatch):
    monkeypatch.setenv("PKLEGAL_SHC_SCOPE", "nonsense")
    assert scraper.scope == "afr"


# ---- table parsing ---------------------------------------------------
def test_discovery_yields_one_item_per_row(scraper):
    items = list(scraper.discover())
    # two judges x three rows, deduplicated on the download URL
    assert len({i.url for i in items}) == 3
    assert all(i.inline for i in items)
    assert all("download-file.php" in i.url for i in items)


def test_case_cell_is_split_into_four_fields(scraper):
    items = {i.hint("case_number"): i for i in scraper.discover()}
    suit = items["333/2004"]
    assert suit.hint("matter_type") == "Suit"
    assert suit.hint("bench_type") == "S.B."
    assert suit.hint("court_text") == "Sindh High Court, Karachi"
    assert suit.year == 2004


def test_attached_cases_are_split_off_the_court_name(scraper):
    items = {i.hint("case_number"): i for i in scraper.discover()}
    const = items["709/2019"]
    assert const.hint("court_text") == "Sindh High Court, Circuit at Hyderabad"
    assert const.hint("attached_cases") == "710, 711, 714"


def test_full_record_from_a_table_row(scraper):
    items = {i.hint("case_number"): i for i in scraper.discover()}
    doc = scraper.parse_document(items["1811/2017"], None)

    assert doc.court == "Sindh High Court"
    assert doc.raw["seat"] == "Circuit at Hyderabad"
    assert doc.province == "Sindh"
    assert doc.matter_type == "Cr.Bail"
    assert doc.category == "Criminal Appellate Jurisdictions"
    assert doc.judgment_date == "2018-03-26"
    assert doc.citation == "2019 MLD 30"
    assert doc.raw["all_citations"] == ["2019 MLD 30", "2021 SBLR Sindh 1602"]
    assert doc.judges == ["Agha Faisal", "Kausar Sultana Hussain"]
    assert doc.parties[0]["role"] == "applicant"
    assert doc.parties[1]["name"] == "THE STATE"
    assert "C.P.L.A.3142/2019" in doc.connected_cases
    assert doc.case_status == "disposed"
    assert doc.document_file_url.startswith("https://caselaw.shc.gov.pk")


def test_nil_citation_is_not_stored(scraper):
    items = {i.hint("case_number"): i for i in scraper.discover()}
    doc = scraper.parse_document(items["333/2004"], None)
    assert doc.citation is None
    assert "citation" not in doc.to_dict()


def test_headnote_becomes_summary_and_feeds_cited_laws(scraper):
    items = {i.hint("case_number"): i for i in scraper.discover()}
    doc = scraper.parse_document(items["1811/2017"], None)
    assert "Post arrest bail" in doc.summary
    assert any("Income Tax Ordinance, 2001" in law for law in doc.cited_laws)


def test_row_only_text_is_flagged_honestly(scraper):
    items = {i.hint("case_number"): i for i in scraper.discover()}
    doc = scraper.parse_document(items["333/2004"], None)
    assert doc.full_text
    assert any("not the judgment itself" in n for n in doc.notes)


def test_same_judgment_under_two_judges_is_stored_once(scraper):
    scraper.run()
    assert scraper.stats.stored == 3
    assert scraper.stats.skipped_seen == 3  # second judge's copy of each


def test_falls_back_to_top_trend_when_judge_index_fails(scraper):
    listing = scraper._fixtures["listing"]

    def handler(request):
        if "top-trend-judgements" in str(request.url):
            return httpx.Response(200, text=listing, headers={"content-type": "text/html"})
        return httpx.Response(500)

    scraper.client._client = httpx.Client(
        transport=httpx.MockTransport(handler), follow_redirects=True
    )
    items = list(scraper.discover())
    assert len(items) == 3
    assert items[0].hint("case_number") == "208/2015"
