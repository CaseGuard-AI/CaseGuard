"""Lahore High Court -- SHIPS DISABLED. Read this before enabling it.

Two independent reasons this scraper does not run by default:

1. robots.txt on both lhc.gov.pk and data.lhc.gov.pk disallows automated
   access. An automated fetch of /reported_judgments and of
   /dynamic/approved_judgments_result_new.php was refused on robots grounds.
2. The LHC site carries an explicit copyright notice stating that the content,
   images and graphics on the site are the Court's reserved copyright and may
   not be downloaded without prior permission.

So this is not a technical obstacle to route around -- it is the site owner
saying no. The correct move for an FYP is to write to the LHC IT section /
Registrar, explain the academic purpose, and ask for permission or a data
extract. Universities get these requests granted more often than you'd expect,
and a permission letter is a genuinely strong thing to put in your report.

What was observed about the site (recorded so you don't have to rediscover it):
  * Judgment listings live under data.lhc.gov.pk/reported_judgments/... with
    sub-collections: judgments_approved_for_reporting,
    judgments_approved_for_reporting_by_former_judges, green_bench_orders,
    school_security_orders. Urdu mirrors sit under /urdu/.
  * A backing AJAX endpoint exists at
        /dynamic/approved_judgments_result_new.php?year=<yyyy>
    which returns a result fragment with a "Total Judgments (N)" header.
  * The main site also publishes Rules & Orders volumes at lhc.gov.pk under
    /rules_and_orders.
These are recorded as CANDIDATE endpoints. They were never successfully
fetched, so the parser below is written generically and is marked unverified.

Enabling (only once you hold written permission):
    export PKLEGAL_PERMISSION_LAHORE_HIGH_COURT=1
    python main.py --source lahore_high_court --i-have-permission --limit 5
Even then, keep the delay high (config sets 6s) and the volume low.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from urllib.parse import urljoin

from extractors.html_extractor import clean_text, make_soup
from extractors.metadata_extractor import (
    extract_case_number,
    extract_judges,
    split_parties,
)
from models.legal_document import DocumentType, LegalDocument
from scrapers.base_scraper import BaseScraper, Discovered
from utils.dates import extract_year, normalise_date

COLLECTIONS = (
    "/reported_judgments/judgments_approved_for_reporting",
    "/reported_judgments/judgments_approved_for_reporting_by_former_judges",
    "/reported_judgments/green_bench_orders",
)
AJAX_RESULTS = "/dynamic/approved_judgments_result_new.php"
PDF_LINK = re.compile(r"\.pdf(\?|$)", re.I)


class LahoreHighCourtScraper(BaseScraper):
    """UNVERIFIED parser. Every selector here is generic on purpose."""

    source_key = "lahore_high_court"

    def preflight(self) -> None:
        self.log.warning(
            "LHC scraping is permission-gated and its parser is UNVERIFIED. "
            "Check every record it produces by hand before it enters the corpus."
        )

    # ------------------------------------------------------------------
    def discover(self) -> Iterator[Discovered]:
        years = self._years()
        for year in years:
            url = urljoin(self.config.base_url, AJAX_RESULTS)
            response = self._fetch(url, params={"year": year})
            if response is not None:
                yield from self._parse_results(response.text, response.url, year)
            if self.settings.limit and self.stats.stored >= self.settings.limit:
                return

        for path in COLLECTIONS:
            url = urljoin(self.config.base_url, path)
            response = self._fetch(url)
            if response is None:
                continue
            yield from self._parse_results(response.text, response.url, None)

    def _years(self) -> list[int]:
        import datetime

        end = self.settings.end_year or datetime.date.today().year
        start = self.settings.start_year or end
        return list(range(start, end + 1))

    # ------------------------------------------------------------------
    def _parse_results(self, html: str, base_url: str, year: int | None) -> Iterator[Discovered]:
        soup = make_soup(html)
        seen: set[str] = set()
        for anchor in soup.find_all("a", href=True):
            href = urljoin(base_url, anchor["href"].strip())
            if not PDF_LINK.search(href) or href in seen:
                continue
            seen.add(href)
            block = anchor.find_parent(["tr", "li", "div", "p"])
            context = clean_text(
                block.get_text("\n") if block else anchor.get_text(" ", strip=True)
            )
            yield Discovered(
                url=href,
                hints={
                    "context": context[:2000],
                    "listing_url": base_url,
                    "link_text": anchor.get_text(" ", strip=True),
                },
                document_type=DocumentType.JUDGMENT.value,
                year=year or extract_year(context),
            )

    # ------------------------------------------------------------------
    def parse_document(self, item: Discovered, response) -> LegalDocument | None:
        context = item.hint("context") or ""
        title = item.hint("link_text") or context.split("\n")[0][:250] or None
        document = self.new_document(
            source_url=item.hint("listing_url") or item.url,
            document_url=item.url,
            title=title,
            case_number=extract_case_number(context),
            document_type=DocumentType.JUDGMENT.value,
            court="Lahore High Court",
            province="Punjab",
            jurisdiction="Pakistan",
            language="en",
            raw={k: v for k, v in item.hints.items() if v},
        )
        for line in context.splitlines():
            normalised = normalise_date(line.split(":")[-1].strip())
            if normalised:
                document.date = document.judgment_date = normalised
                break
        document.parties = split_parties(title or "")
        self.ingest_pdf(document, item.url, name_hint=title)
        if document.full_text:
            document.judges = extract_judges(document.full_text[:4000])
        document.notes.append(
            "collected under explicit permission; parser unverified -- verify fields by hand"
        )
        return document
