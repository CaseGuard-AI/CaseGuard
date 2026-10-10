"""Federal Shariat Court: leading-judgements table -> normalised judgments."""

import httpx
import pytest

from config import SOURCES, Settings
from scrapers.federal_shariat_court import FederalShariatCourtScraper
from storage.file_storage import FileStorage
from storage.jsonl_storage import JsonlStorage
from storage.state_store import StateStore
from utils.http_client import HttpClient
from utils.logging_config import JsonlEventLogger
from utils.rate_limiter import RateLimiter


def _pdf_bytes(body: str) -> bytes:
    import fitz
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 90), "IN THE FEDERAL SHARIAT COURT")
    page.insert_text((72, 110), "PRESENT")
    page.insert_text((72, 130), "MR. JUSTICE DR. SYED MUHAMMAD ANWER")
    page.insert_text((72, 150), "MR. JUSTICE AMEER MUHAMMAD KHAN")
    page.insert_text((72, 180), body)
    page.insert_text((72, 210), "Relied upon PLD 2022 FSC 57 in this matter.")
    data = doc.tobytes()
    doc.close()
    return data


@pytest.fixture
def scraper(tmp_path, fixture_html):
    settings = Settings()
    settings.output_dir = tmp_path / "data"
    settings.request_delay = 0.0
    settings.ensure_dirs()
    leading = fixture_html("fsc_leading.html")

    def handler(request):
        url = str(request.url)
        if "leading-judgements" in url or "p=209" in url:
            return httpx.Response(200, text=leading,
                                  headers={"content-type": "text/html"})
        if url.endswith(".pdf") or ".pdf" in url:
            return httpx.Response(200, content=_pdf_bytes(f"Body for {url[-20:]}"),
                                  headers={"content-type": "application/pdf"})
        if "judgement.php" in url:
            return httpx.Response(200, text="<html><body>no table</body></html>",
                                  headers={"content-type": "text/html"})
        return httpx.Response(404)

    client = HttpClient("test", respect_robots=False, retry_count=1,
                        backoff_base=1.0, backoff_cap=0.01,
                        rate_limiter=RateLimiter(0.0, 4))
    client._client = httpx.Client(transport=httpx.MockTransport(handler),
                                  follow_redirects=True)
    instance = FederalShariatCourtScraper(
        settings=settings, client=client, state=StateStore(settings.state_db),
        files=FileStorage(settings.raw_dir, settings.text_dir),
        storage=JsonlStorage(settings.jsonl_dir, "federal_shariat_court"),
        events=JsonlEventLogger(settings.log_dir / "e.jsonl"),
        source_config=SOURCES["federal_shariat_court"],
    )
    client.rate_limiter.set_host_delay(
        SOURCES["federal_shariat_court"].base_url, 0.0)
    client.rate_limiter.default_delay = 0.0
    yield instance
    client.close()
    instance.state.close()


def test_discovery_finds_each_judgment_pdf(scraper):
    items = list(scraper.discover())
    assert len({i.url for i in items}) == 3
    assert all(i.url.endswith(".pdf") for i in items)


def test_reference_column_is_captured(scraper):
    items = list(scraper.discover())
    transgender = next(i for i in items if "Transgender" in (i.hint("title") or ""))
    assert "PLD-2023 FSC-301" in transgender.hint("reference")
    assert transgender.year == 2023


def test_pld_fsc_citation_is_parsed(scraper):
    item = next(i for i in scraper.discover()
                if "Transgender" in (i.hint("title") or ""))
    doc = scraper.parse_document(item, None)
    assert doc.citation == "PLD 2023 FSC 301"
    assert doc.court == "Federal Shariat Court"
    assert doc.date == "2023-05-19"


def test_missing_citation_stays_none(scraper):
    item = next(i for i in scraper.discover()
                if "Chaddar" in (i.hint("title") or ""))
    doc = scraper.parse_document(item, None)
    assert doc.citation is None
    assert doc.date == "2025-03-19"


def test_case_number_parsed_from_inconsistent_filenames(scraper):
    # the site uses spaces, dots and dashes interchangeably
    assert scraper._case_number("S.P.NO.30-L-1991.pdf") == \
        "Shariat Petition No. 30-L/1991"
    assert scraper._case_number("Shariat Petition No. 10 - I - of 2023.pdf") == \
        "Shariat Petition No. 10-I/2023"
    assert scraper._case_number("not a case") is None


def test_petition_year_and_decision_year_are_both_kept(scraper):
    """The Riba judgment is a 1991 petition decided in 2022 -- both matter."""
    item = next(i for i in scraper.discover() if "Riba" in (i.hint("title") or ""))
    doc = scraper.parse_document(item, None)
    assert item.year == 2022                 # decision year, for filtering
    assert doc.raw["petition_year"] == 1991  # filing year, kept separately
    assert doc.case_number == "Shariat Petition No. 30-L/1991"


def test_pdf_is_downloaded_and_judges_parsed_from_the_header(scraper):
    item = next(i for i in scraper.discover()
                if "Transgender" in (i.hint("title") or ""))
    doc = scraper.parse_document(item, None)
    assert doc.extraction_status == "ok"
    assert "FEDERAL SHARIAT COURT" in doc.full_text
    assert "Syed Muhammad Anwer" in " ".join(doc.judges)
    assert any("parsed from the PDF" in n for n in doc.notes)
    assert "PLD 2022 FSC 57" in doc.cited_cases


def test_full_run_is_incremental(scraper):
    scraper.run()
    assert scraper.stats.stored == 3
    assert scraper.stats.pdfs == 3
    scraper.stats.stored = 0
    scraper.run()
    assert scraper.stats.stored == 0
