"""#147: the live sites' current markup, TLS chain and file responses.

The *_relative.html fixtures are trimmed copies of the live pages captured on 2026-11-09.
The older fixtures stay too, so both link styles keep working.
"""

import ssl
import urllib.error
from pathlib import Path

import fitz
import httpx
import pytest

from config import SOURCES, Settings
from extractors.html_extractor import make_soup
from scrapers.pakistan_code import PakistanCodeScraper
from scrapers.shc_caselaw import SindhHighCourtScraper
from storage.file_storage import FileStorage
from storage.jsonl_storage import JsonlStorage
from storage.state_store import StateStore
from utils import http_client as http_client_module
from utils import robots as robots_module
from utils.http_client import HttpClient
from utils.links import document_base, resolve, strip_comments
from utils.logging_config import JsonlEventLogger
from utils.rate_limiter import RateLimiter
from utils.robots import RobotsCache
from utils.tls import EXTRA_INTERMEDIATES, ssl_context

PC_INDEX_URL = "https://pakistancode.gov.pk/english/LGu0xAD?alp=P&page=1&action=inactive"
SHC_TABLE_URL = (
    "https://caselaw.shc.gov.pk/caselaw/public/reported-judgements-detail-all/844/AFR/AFR"
)
DOC_1 = (
    "https://caselaw.shc.gov.pk/caselaw/download-file.php?doc=ODU0MjhjZm1zLWRjODM%3D&citation=Nil"
)


def _pdf_bytes(text: str = "IN THE HIGH COURT OF SINDH. Judgment text. " * 20) -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_textbox(fitz.Rect(40, 40, 560, 800), text, fontsize=10)
    data = doc.tobytes()
    doc.close()
    return data


def _build(scraper_cls, source_key, tmp_path, handler, *, download_pdfs):
    settings = Settings()
    settings.output_dir = tmp_path / "data"
    settings.request_delay = 0.0
    settings.download_pdfs = download_pdfs
    settings.ensure_dirs()
    client = HttpClient(
        "test",
        respect_robots=False,
        retry_count=1,
        backoff_cap=0.01,
        rate_limiter=RateLimiter(0.0, 4),
    )
    client._client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)
    client.rate_limiter.default_delay = 0.0
    client.rate_limiter.set_host_delay(SOURCES[source_key].base_url, 0.0)
    return scraper_cls(
        settings=settings,
        client=client,
        state=StateStore(settings.state_db),
        files=FileStorage(settings.raw_dir, settings.text_dir),
        storage=JsonlStorage(settings.jsonl_dir, source_key),
        events=JsonlEventLogger(settings.log_dir / "e.jsonl"),
        source_config=SOURCES[source_key],
    )


# ---- link helpers -----------------------------------------------------
def test_base_href_wins_over_the_page_url():
    soup = make_soup('<html><head><base href="/caselaw/" /></head><body></body></html>')
    assert document_base(soup, SHC_TABLE_URL) == "https://caselaw.shc.gov.pk/caselaw/"
    assert resolve(soup, SHC_TABLE_URL, "download-file.php?doc=x") == (
        "https://caselaw.shc.gov.pk/caselaw/download-file.php?doc=x"
    )


def test_without_base_links_resolve_against_the_page():
    soup = make_soup("<html><body></body></html>")
    assert (
        resolve(soup, PC_INDEX_URL, "UY2F-sg-jjj")
        == "https://pakistancode.gov.pk/english/UY2F-sg-jjj"
    )


def test_strip_comments_removes_commented_links():
    soup = strip_comments(
        make_soup('<div><!-- <a href="view-file/x">x</a> --><a href="y">y</a></div>')
    )
    assert [a["href"] for a in soup.find_all("a")] == ["y"]
    assert "view-file" not in str(soup)


# ---- Pakistan Code ----------------------------------------------------
@pytest.fixture
def pakistan_code(tmp_path, fixture_html):
    scraper = _build(
        PakistanCodeScraper,
        "pakistan_code",
        tmp_path,
        lambda r: httpx.Response(404),
        download_pdfs=False,
    )
    yield scraper
    scraper.client.close()
    scraper.state.close()


def test_relative_detail_links_are_discovered(pakistan_code, fixture_html):
    items = list(
        pakistan_code._parse_index(fixture_html("pakistan_code_index_relative.html"), PC_INDEX_URL)
    )
    assert [i.hint("title") for i in items] == [
        "PAF Air War College Institute Act, 2021",
        "Pakistan (Army and Air Force) Reserves Act, 1950",
        "Pakistan (Exchange of Prisoners) Ordinance, 1948",
    ]
    assert all(i.url.startswith("https://pakistancode.gov.pk/english/UY2F") for i in items)
    assert all(i.url.endswith("-sg-jjjjjjjjjjjjj") for i in items)
    # The metadata line next to each relative link is still found.
    assert items[0].hint("document_number") == "XVI of 2021"


@pytest.mark.parametrize(
    ("markup", "expected"),
    [
        ('<a href="https://pakistancode.gov.pk/pdffiles/a.pdf">PDF</a>', "/pdffiles/a.pdf"),
        ('<a href="../pdffiles/b.pdf">PDF</a>', "/pdffiles/b.pdf"),
        ('<a href="/pdffiles/c.pdf">PDF</a>', "/pdffiles/c.pdf"),
        (
            '<iframe src="https://pakistancode.gov.pk/ViewerJS/#../pdffiles/d.pdf"></iframe>',
            "/pdffiles/d.pdf",
        ),
    ],
)
def test_pdf_links_in_every_live_form(markup, expected):
    page = "https://pakistancode.gov.pk/english/UY2F-sg-jjj"
    found = PakistanCodeScraper._find_pdf(make_soup(f"<html><body>{markup}</body></html>"), page)
    assert found == "https://pakistancode.gov.pk" + expected


def test_a_commented_out_pdf_link_is_not_a_link():
    soup = make_soup('<html><body><!-- <a href="/pdffiles/old.pdf">old</a> --></body></html>')
    assert PakistanCodeScraper._find_pdf(soup, "https://pakistancode.gov.pk/english/x-sg-j") is None


# ---- SHC --------------------------------------------------------------
def _shc(tmp_path, file_response, *, download_pdfs=True):
    calls: list[str] = []

    def handler(request):
        url = str(request.url)
        if "download-file.php" in url:
            calls.append(url)
            return file_response()
        return httpx.Response(404)

    scraper = _build(
        SindhHighCourtScraper, "shc_caselaw", tmp_path, handler, download_pdfs=download_pdfs
    )
    scraper._calls = calls
    return scraper


def _rows(scraper, fixture_html):
    return list(
        scraper._parse_table(fixture_html("shc_judge_table_relative.html"), SHC_TABLE_URL, "Judge")
    )


def test_relative_download_links_honour_base_href(tmp_path, fixture_html):
    scraper = _shc(tmp_path, lambda: httpx.Response(404), download_pdfs=False)
    rows = _rows(scraper, fixture_html)
    assert [r.hint("case_number") for r in rows] == ["1167/2010", "29/2016", "937/2024"]
    assert rows[0].hint("download_url") == DOC_1
    assert rows[1].hint("download_url") is None  # this row links no file
    assert (
        rows[2]
        .hint("download_url")
        .startswith("https://caselaw.shc.gov.pk/caselaw/download-file.php?doc=")
    )
    # The row without a file keeps the judge page as its provenance, not the <base> URL.
    assert rows[1].url.startswith(SHC_TABLE_URL + "#case=")


def test_commented_out_view_file_links_are_ignored(tmp_path, fixture_html):
    assert "view-file" in fixture_html("shc_judge_table_relative.html")
    scraper = _shc(tmp_path, lambda: httpx.Response(404), download_pdfs=False)
    for row in _rows(scraper, fixture_html):
        assert "view-file" not in row.url
        assert "view-file" not in (row.hint("download_url") or "")


def test_a_real_pdf_is_stored_and_the_record_is_the_judgment(tmp_path, fixture_html):
    scraper = _shc(
        tmp_path,
        lambda: httpx.Response(
            200, content=_pdf_bytes(), headers={"content-type": "application/pdf"}
        ),
    )
    document = scraper.parse_document(_rows(scraper, fixture_html)[0], None)
    assert document.raw["file_status"] == "ok"
    assert document.raw["headnote_only"] is False
    assert "Judgment text" in document.full_text
    assert Path(document.file_path).read_bytes().startswith(b"%PDF-")


@pytest.mark.parametrize(
    ("response", "status", "reason"),
    [
        (
            lambda: httpx.Response(200, content=b"", headers={"content-type": "application/pdf"}),
            "empty",
            "was empty",
        ),
        (
            lambda: httpx.Response(
                200, content=b"<html>error</html>", headers={"content-type": "application/pdf"}
            ),
            "not_pdf",
            "was not a PDF",
        ),
        (
            lambda: httpx.Response(
                200, content=b"PK\x03\x04docx", headers={"content-type": "application/octet-stream"}
            ),
            "not_pdf",
            "was not a PDF",
        ),
    ],
)
def test_non_pdf_downloads_are_flagged_and_never_saved(
    tmp_path, fixture_html, response, status, reason
):
    scraper = _shc(tmp_path, response)
    document = scraper.parse_document(_rows(scraper, fixture_html)[0], None)
    assert document.raw["file_status"] == status
    assert document.raw["headnote_only"] is True
    # The record's text is the table row; the failed file is kept in extraction_error.
    assert "did not return a PDF" in document.extraction_error
    assert document.file_path is None
    assert any(reason in note for note in document.notes)
    assert not any(scraper.settings.raw_dir.rglob("*.pdf"))


def test_no_pdfs_and_missing_links_are_labelled_head_note_only(tmp_path, fixture_html):
    scraper = _shc(tmp_path, lambda: httpx.Response(404), download_pdfs=False)
    rows = _rows(scraper, fixture_html)
    linked, unlinked = scraper.parse_document(rows[0], None), scraper.parse_document(rows[1], None)
    assert (linked.raw["file_status"], linked.raw["headnote_only"]) == ("not_downloaded", True)
    assert (unlinked.raw["file_status"], unlinked.raw["headnote_only"]) == ("missing_link", True)
    assert any("no judgment file was linked" in n for n in unlinked.notes)
    assert scraper._calls == []


def test_a_non_pdf_left_on_disk_is_not_reused(tmp_path, fixture_html):
    scraper = _shc(
        tmp_path,
        lambda: httpx.Response(
            200, content=_pdf_bytes(), headers={"content-type": "application/pdf"}
        ),
    )
    row = _rows(scraper, fixture_html)[0]
    first = scraper.parse_document(row, None)
    Path(first.file_path).write_bytes(b"<html>stale error page</html>")
    second = scraper.parse_document(row, None)
    assert second.raw["file_status"] == "ok"
    assert len(scraper._calls) == 2
    assert Path(second.file_path).read_bytes().startswith(b"%PDF-")


# ---- TLS --------------------------------------------------------------
def test_the_bundled_intermediate_is_trusted_next_to_certifi():
    names = [
        dict(part[0] for part in cert["subject"]).get("commonName")
        for cert in ssl_context().get_ca_certs()
    ]
    assert "GoGetSSL RSA DV CA" in names
    assert len(names) > 100  # certifi's roots are still there
    assert ssl_context().verify_mode == ssl.CERT_REQUIRED
    assert ssl_context().check_hostname is True
    assert EXTRA_INTERMEDIATES.is_file()


def test_the_http_client_verifies_with_that_context(monkeypatch):
    seen = {}
    real = httpx.Client

    def capture(*args, **kwargs):
        seen["verify"] = kwargs.get("verify")
        return real(*args, **kwargs)

    monkeypatch.setattr(http_client_module.httpx, "Client", capture)
    HttpClient("test").close()
    assert seen["verify"] is ssl_context()


def test_robots_tls_failure_fails_closed(monkeypatch):
    def broken(*args, **kwargs):
        raise urllib.error.URLError(
            ssl.SSLCertVerificationError("unable to get local issuer certificate")
        )

    monkeypatch.setattr(robots_module.urllib.request, "urlopen", broken)
    robots = RobotsCache("test")
    assert robots.allowed("https://bad-chain.example/page") is False
    assert robots.allowed("https://bad-chain.example/other") is False


def test_robots_unreachable_still_means_allow_all(monkeypatch):
    def offline(*args, **kwargs):
        raise urllib.error.URLError(ConnectionRefusedError("refused"))

    monkeypatch.setattr(robots_module.urllib.request, "urlopen", offline)
    assert RobotsCache("test").allowed("https://no-robots.example/page") is True
