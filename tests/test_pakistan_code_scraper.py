"""URL discovery + parsing for the Pakistan Code, against fixtures captured
from the live site's rendered structure."""

import httpx
import pytest

from config import SOURCES, Settings
from scrapers.pakistan_code import PakistanCodeScraper
from storage.file_storage import FileStorage
from storage.jsonl_storage import JsonlStorage
from storage.state_store import StateStore
from utils.http_client import HttpClient
from utils.logging_config import JsonlEventLogger
from utils.rate_limiter import RateLimiter


def _pdf_bytes(body: str = "") -> bytes:
    """A small real PDF so the full ingest path (download -> extract -> hash)
    is exercised rather than mocked away."""
    import fitz
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), "AN ACT to provide for the preservation of")
    page.insert_text((72, 120), "archival material and for matters connected")
    page.insert_text((72, 140), "therewith. It extends to the whole of Pakistan.")
    if body:
        page.insert_text((72, 170), body)
    data = doc.tobytes()
    doc.close()
    return data


@pytest.fixture
def scraper(tmp_path, fixture_html):
    settings = Settings()
    settings.output_dir = tmp_path / "data"
    settings.request_delay = 0.0
    settings.download_pdfs = True
    settings.max_pages = 1
    settings.ensure_dirs()

    index = fixture_html("pakistan_code_index.html")
    detail = fixture_html("pakistan_code_detail.html")
    empty = fixture_html("pakistan_code_empty.html")

    def handler(request):
        url = str(request.url)
        if "LGu0xAD" in url:
            body = index if "alp=A" in url else empty
            return httpx.Response(200, text=body,
                                  headers={"content-type": "text/html"})
        if "-sg-j" in url:
            # give each statute its own PDF filename, as the real site does
            unique = str(abs(hash(url)) % 10**8)
            body = detail.replace("dfd455a3106327ca3f1c51b7d86c4840", unique)
            return httpx.Response(200, text=body,
                                  headers={"content-type": "text/html"})
        if url.endswith(".pdf"):
            # vary the body per PDF so these are three distinct documents
            body = f"Distinct clause for {url[-12:]}"
            return httpx.Response(200, content=_pdf_bytes(body),
                                  headers={"content-type": "application/pdf"})
        return httpx.Response(404)

    # backoff is capped here only so the suite stays fast; the retry logic
    # itself is exercised properly in tests/test_retry.py
    client = HttpClient("test", respect_robots=False, retry_count=2,
                        backoff_base=1.0, backoff_cap=0.01,
                        rate_limiter=RateLimiter(0.0, 4))
    client._client = httpx.Client(transport=httpx.MockTransport(handler),
                                  follow_redirects=True)
    instance = PakistanCodeScraper(
        settings=settings, client=client, state=StateStore(settings.state_db),
        files=FileStorage(settings.raw_dir, settings.text_dir),
        storage=JsonlStorage(settings.jsonl_dir, "pakistan_code"),
        events=JsonlEventLogger(settings.log_dir / "e.jsonl"),
        source_config=SOURCES["pakistan_code"],
    )
    instance._fixture_index = index
    instance._fixture_detail = detail
    instance._fixture_empty = empty
    # config.SOURCES sets a 2-6s per-host politeness delay; irrelevant against
    # a mock transport and it would make the suite take minutes.
    client.rate_limiter.set_host_delay(SOURCES[instance.source_key].base_url, 0.0)
    client.rate_limiter.default_delay = 0.0
    yield instance
    client.close()
    instance.state.close()


def test_discovery_finds_detail_links(scraper):
    items = list(scraper.discover())
    urls = {item.url for item in items}
    assert len(urls) == 3
    assert all("-sg-j" in url for url in urls)


def test_discovery_parses_the_pipe_delimited_metadata(scraper):
    items = {i.hint("title"): i for i in scraper.discover()}
    nao = items["National Accountability Ordinance, 1999"]
    assert nao.hint("category") == "General Laws"
    assert nao.hint("document_number") == "XVIII of 1999"
    assert nao.hint("promulgation_date") == "September 24 1999"
    assert nao.document_type == "ordinance"
    assert nao.year == 1999


def test_discovery_ignores_pagination_links(scraper):
    assert all("LGu0xAD" not in item.url for item in scraper.discover())


def test_junk_promulgation_date_is_not_captured(scraper):
    items = {i.hint("title"): i for i in scraper.discover()}
    gas = items["Natural Gas Regulatory Authority Ordinance, 2000"]
    # the site renders the missing date as "December ." -- must not be kept
    assert gas.hint("promulgation_date") is None


def test_pdf_is_downloaded_extracted_and_hashed(scraper):
    item = next(i for i in scraper.discover()
                if i.hint("title") == "National Archives Act, 1993")
    doc = scraper.parse_document(item, scraper.client.get(item.url))
    assert doc.extraction_status == "ok"
    assert "archival material" in doc.full_text
    assert doc.file_path and doc.file_path.endswith(".pdf")
    assert doc.mime_type == "application/pdf"
    assert doc.page_count == 1
    assert doc.compute_content_hash()


def test_parse_document_builds_a_provenance_complete_record(scraper):
    items = {i.hint("title"): i for i in scraper.discover()}
    item = items["National Archives Act, 1993"]
    response = scraper.client.get(item.url)
    doc = scraper.parse_document(item, response)

    assert doc.source == "pakistan_code"
    assert doc.source_website == "https://pakistancode.gov.pk"
    assert doc.source_url == item.url
    assert doc.title == "National Archives Act, 1993"
    assert doc.document_number == "VI of 1993"
    assert doc.date == "1993-12-01"
    assert doc.document_type == "act"
    assert doc.jurisdiction == "Pakistan"
    assert doc.category == "General Laws"
    assert "/pdffiles/administrator" in doc.document_file_url
    assert doc.document_file_url.endswith(".pdf")


def test_missing_date_is_left_none_with_a_note(scraper):
    items = {i.hint("title"): i for i in scraper.discover()}
    item = items["Natural Gas Regulatory Authority Ordinance, 2000"]
    doc = scraper.parse_document(item, scraper.client.get(item.url))
    assert doc.date is None
    assert doc.raw.get("year") == 2000
    assert any("promulgation date" in note for note in doc.notes)


def test_identical_text_under_two_urls_is_stored_once(scraper, monkeypatch):
    """The Pakistan Code index lists the same statute under several sections,
    so cross-URL duplicate detection has to work on content, not just URL."""
    same = _pdf_bytes()

    def handler(request):
        url = str(request.url)
        if "LGu0xAD" in url:
            body = scraper._fixture_index if "alp=A" in url else scraper._fixture_empty
            return httpx.Response(200, text=body,
                                  headers={"content-type": "text/html"})
        if "-sg-j" in url:
            return httpx.Response(200, text=scraper._fixture_detail,
                                  headers={"content-type": "text/html"})
        return httpx.Response(200, content=same,
                              headers={"content-type": "application/pdf"})

    scraper.client._client = httpx.Client(transport=httpx.MockTransport(handler),
                                          follow_redirects=True)
    scraper.run()
    assert scraper.stats.stored == 1
    assert scraper.stats.duplicates == 2


def test_full_run_stores_each_document_once(scraper):
    scraper.run()
    assert scraper.stats.stored == 3
    rows = list(JsonlStorage.read(scraper.storage.path))
    assert len(rows) == 3
    # a second run must store nothing new (incremental)
    scraper.stats.stored = 0
    scraper.run()
    assert scraper.stats.stored == 0
    assert scraper.stats.skipped_seen == 3
