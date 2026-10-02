"""Supreme Court of Pakistan.

STATUS: needs_probe. Read this before you trust anything it produces.
---------------------------------------------------------------------
What was verified:
  * Judgment PDFs are served from https://scp.gov.pk/files/judgments/<CASE>.pdf
    with the case number in the filename, e.g. C.P._3451_2017.pdf
  * The WordPress site at www.supremecourt.gov.pk exposes /latest-judgements/
    (described as "latest 25 judgements", with a link onward to the judgement
    search form) and /judgement-search/ , /cause-list-search/ ,
    /online-case-status/ . The case-type vocabulary used by the case-status
    form is the SCP case-type list (C.A., C.P.L.A., Crl.A., S.M.C., H.R.C., ...).
  * scp.gov.pk/JudgmentSearch.aspx is a classic ASP.NET WebForms page, which
    means any search POST needs __VIEWSTATE / __EVENTVALIDATION tokens scraped
    from a prior GET of the same page.

What could NOT be verified:
  * Both supremecourt.gov.pk and scp.gov.pk rejected automated inspection
    (bot-protection challenge) from a datacentre IP. The DOM of the listing and
    the exact form field names are therefore unknown.

Consequence, and why this file looks the way it does:
  No CSS selectors or form field names are invented here. Discovery works by
  pattern-matching judgment-PDF URLs anywhere in the returned HTML and reading
  the surrounding text block for metadata. That is deliberately crude but
  honest: it either works on the real markup or it finds nothing and says so.

Before using this source for real:
    python main.py --source supreme_court --probe
from a normal (non-datacentre) connection. That saves the raw HTML to
data/probe/ so you can read the actual markup and tighten this parser. If the
probe is challenged there too, the practical options are (a) ask the SCP
Registrar / IT section for data access or an API, or (b) ingest judgments you
download by hand via `python main.py --source supreme_court --ingest-dir ...`.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterator
from urllib.parse import urljoin

from extractors.html_extractor import clean_text, make_soup
from extractors.metadata_extractor import (
    extract_case_number, extract_citations, extract_judges, split_parties,
)
from models.legal_document import DocumentType, LegalDocument
from scrapers.base_scraper import BaseScraper, Discovered, ScraperError
from utils.dates import extract_year, normalise_date
from utils.http_client import FetchError

LISTING_PATHS = (
    "/latest-judgements/",
    "/judgement-search/",
)
JUDGMENT_PDF = re.compile(
    r"https?://(?:www\.)?(?:scp|supremecourt)\.gov\.pk/[^\s\"'<>]*"
    r"(?:judgment|judgement|files/judgments)[^\s\"'<>]*\.pdf",
    re.I,
)
ANY_PDF = re.compile(r"[^\s\"'<>]+\.pdf", re.I)
# C.P._3451_2017.pdf  /  Crl.A.123-L-2020.pdf
FILENAME_CASE = re.compile(
    r"([A-Za-z][A-Za-z.]*\.?)[._\s-]+(\d+)[._\s-]+(?:of[._\s-]+)?((?:19|20)\d{2})"
)
BOT_MARKERS = ("cf-browser-verification", "challenge-platform", "captcha",
               "just a moment", "attention required", "ddos-guard")


class SupremeCourtScraper(BaseScraper):
    source_key = "supreme_court"

    # ------------------------------------------------------------------
    def preflight(self) -> None:
        """Fail loudly and usefully if the site is challenging us."""
        try:
            response = self.client.get(self.config.base_url)
        except FetchError as exc:
            raise ScraperError(
                f"Could not reach {self.config.base_url}: {exc}\n"
                "If this is a 403, the site's bot protection is refusing this "
                "machine. Run --probe from a normal connection, or use "
                "--ingest-dir to load manually downloaded judgment PDFs."
            ) from exc

        lowered = response.text[:6000].lower()
        if any(marker in lowered for marker in BOT_MARKERS):
            raise ScraperError(
                "supremecourt.gov.pk returned a bot-protection challenge rather "
                "than the site. Automated scraping is being refused from this "
                "network. Options: run from a normal connection, request access "
                "from the SCP Registrar/IT section, or use --ingest-dir for "
                "manually downloaded PDFs."
            )
        self.log.info("Reached %s (HTTP %d, %d bytes).", self.config.base_url,
                      response.status_code, len(response.content))

    # ------------------------------------------------------------------
    def discover(self) -> Iterator[Discovered]:
        found_any = False
        for path in LISTING_PATHS:
            url = urljoin(self.config.base_url, path)
            response = self._fetch(url)
            if response is None:
                continue
            entries = list(self._parse_listing(response.text, response.url))
            if entries:
                found_any = True
                self.log.info("%s -> %d judgment links", path, len(entries))
                yield from entries
            if self.settings.limit and self.stats.stored >= self.settings.limit:
                return

        if not found_any:
            self.log.error(
                "No judgment PDF links found on any known listing path. The "
                "page structure has changed or the content is loaded by "
                "JavaScript. Run --probe and inspect data/probe/ before "
                "editing LISTING_PATHS / the parser in this file."
            )

    # ------------------------------------------------------------------
    def _parse_listing(self, html: str, base_url: str) -> Iterator[Discovered]:
        soup = make_soup(html)
        seen: set[str] = set()

        candidates: list[tuple[str, str]] = []
        for anchor in soup.find_all("a", href=True):
            href = urljoin(base_url, anchor["href"].strip())
            if ANY_PDF.search(href):
                block = anchor.find_parent(["tr", "li", "div", "p"])
                context = (block.get_text(" ", strip=True) if block
                           else anchor.get_text(" ", strip=True))
                candidates.append((href, context))

        # Fallback: PDFs referenced in scripts/attributes rather than <a>.
        for match in JUDGMENT_PDF.finditer(html):
            candidates.append((match.group(0), ""))

        for href, context in candidates:
            if href in seen:
                continue
            seen.add(href)
            filename = Path(href.split("?")[0]).name
            case_number = self._case_from_filename(filename) or \
                extract_case_number(context)
            yield Discovered(
                url=href,
                hints={"context": clean_text(context)[:2000],
                       "filename": filename,
                       "case_number": case_number,
                       "listing_url": base_url},
                document_type=DocumentType.JUDGMENT.value,
                year=extract_year(filename) or extract_year(context),
            )

    @staticmethod
    def _case_from_filename(filename: str) -> str | None:
        match = FILENAME_CASE.search(filename.replace("%20", "_"))
        if not match:
            return None
        prefix = match.group(1).rstrip(".")
        return f"{prefix}.{match.group(2)}/{match.group(3)}"

    # ------------------------------------------------------------------
    def parse_document(self, item: Discovered, response) -> LegalDocument | None:
        context = item.hint("context") or ""
        case_number = item.hint("case_number")
        title = self._title_from(context, item.hint("filename"), case_number)

        document = self.new_document(
            source_url=item.hint("listing_url") or item.url,
            document_url=item.url,
            document_file_url=item.url,
            title=title,
            case_number=case_number,
            document_type=DocumentType.JUDGMENT.value,
            court="Supreme Court of Pakistan",
            jurisdiction="Pakistan",
            language="en",
            raw={k: v for k, v in item.hints.items() if v},
        )
        document.date = self._date_from(context)
        document.judgment_date = document.date

        if response is not None and response.is_pdf:
            # The listing link was the PDF itself; reuse the fetched bytes.
            self.ingest_pdf(document, item.url, name_hint=title)
        else:
            self.ingest_pdf(document, item.url, name_hint=title)

        if document.full_text:
            head = document.full_text[:4000]
            document.judges = extract_judges(head)
            if document.judges:
                document.notes.append("judges parsed from the PDF header text")
            document.parties = split_parties(title) or document.parties
            document.cited_cases = extract_citations(document.full_text)
            if not document.case_number:
                document.case_number = extract_case_number(head)
        return document

    # ------------------------------------------------------------------
    @staticmethod
    def _title_from(context: str, filename: str | None,
                    case_number: str | None) -> str | None:
        if context:
            first = context.split("\n")[0].strip()
            if 10 < len(first) < 300:
                return first
        if filename:
            stem = Path(filename).stem.replace("_", " ").replace("%20", " ")
            return " ".join(stem.split()) or None
        return case_number

    @staticmethod
    def _date_from(context: str) -> str | None:
        for pattern in (r"\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b",
                        r"\b\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4}\b",
                        r"\b[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}\b"):
            match = re.search(pattern, context)
            if match:
                normalised = normalise_date(match.group(0))
                if normalised:
                    return normalised
        return None

    # ==================================================================
    # operator tools
    # ==================================================================
    def probe(self, out_dir: Path) -> dict:
        """Save what each known endpoint actually returns, for inspection."""
        out_dir.mkdir(parents=True, exist_ok=True)
        report: dict[str, dict] = {}
        for path in (*LISTING_PATHS, "/cause-list-search/", "/online-case-status/"):
            url = urljoin(self.config.base_url, path)
            entry: dict = {"url": url}
            try:
                response = self.client.get(url)
                entry.update(status=response.status_code,
                             bytes=len(response.content),
                             content_type=response.content_type)
                lowered = response.text[:6000].lower()
                entry["bot_challenge"] = any(m in lowered for m in BOT_MARKERS)
                entry["pdf_links_found"] = len(set(ANY_PDF.findall(response.text)))
                name = path.strip("/").replace("/", "_") or "root"
                target = out_dir / f"supreme_court_{name}.html"
                target.write_text(response.text, encoding="utf-8")
                entry["saved_to"] = str(target)
            except Exception as exc:                        # noqa: BLE001
                entry["error"] = str(exc)
            report[path] = entry
            self.log.info("probe %s -> %s", path, entry)
        return report

    def ingest_directory(self, directory: Path) -> int:
        """Load judgment PDFs you downloaded by hand.

        Provenance stays honest: document_file_url is left empty and a note
        records that the file was supplied manually rather than crawled.
        """
        directory = Path(directory)
        pdfs = sorted(directory.rglob("*.pdf"))
        self.log.info("Ingesting %d PDFs from %s", len(pdfs), directory)
        stored = 0
        for pdf in pdfs:
            case_number = self._case_from_filename(pdf.name)
            document = self.new_document(
                source_url=f"file://{pdf.resolve()}",
                document_url=None,
                title=pdf.stem.replace("_", " "),
                case_number=case_number,
                document_type=DocumentType.JUDGMENT.value,
                court="Supreme Court of Pakistan",
                jurisdiction="Pakistan",
                language="en",
            )
            document.notes.append(
                "manually downloaded file; not retrieved by the crawler. "
                "Record the original URL yourself before citing it."
            )
            from extractors.pdf_extractor import extract_pdf
            extraction = extract_pdf(pdf, ocr=self.settings.ocr_enabled,
                                     ocr_language=self.settings.ocr_language)
            document.full_text = extraction.text
            document.file_path = str(pdf)
            document.page_count = extraction.page_count
            document.extraction_status = extraction.status
            document.extraction_error = extraction.error
            document.mime_type = "application/pdf"
            if extraction.text:
                document.judges = extract_judges(extraction.text[:4000])
                document.cited_cases = extract_citations(extraction.text)
            document.compute_content_hash()
            if not self.settings.dry_run:
                self.storage.write(document)
                self.state.register_hash(document.content_hash, document.id,
                                         self.source_key, document.source_url)
                self.state.mark_seen(document.source_url, self.source_key,
                                     document_id=document.id,
                                     content_hash=document.content_hash)
            stored += 1
            self.stats.stored += 1
            self.stats.pdfs += 1
        return stored
