"""Federal Shariat Court -- federalshariatcourt.gov.pk

VERIFIED as reachable: the site responded normally to automated requests and
judgment PDFs are served directly from
    https://www.federalshariatcourt.gov.pk/Judgments/<name>.pdf
with the Shariat Petition number embedded in the filename, e.g.
    "Shariat Petition No. 29 - I - of 1993.pdf", "S.P.NO.36-L-1992.pdf",
    "S.P.2.L.1979 FSC JUDGEMENT.pdf"
Note the inconsistent naming (spaces, dots and dashes as separators) -- the
case-number parser below tolerates all three.

Two discovery routes, both plain HTML tables:

* **Leading judgements** (`/en/leading-judgements/`, also reachable as `?p=209`)
      S.No. | Title | Reference with Date of Decision | Download Judgment
  ~70 landmark decisions back to 1980, several with PLD citations in the
  reference column (e.g. "PLD-2023 FSC-301", "Date of Decision: 19.05.2023").
  This is the highest-value slice and the natural place to start.

* **Case Flow Management judgement list** (`/judgement.php`)
      Case Title | Subject | Bench | Judgment Date | Section(s) | Citation(s) |
      Year of Judgment | Download
  The court's bulk listing, reported to hold 25,000+ judgments/orders from
  roughly 2004 onward.

PARTIALLY VERIFIED: the pagination/filter parameters of `/judgement.php` were
not inspected, so this scraper reads whatever that page returns on a plain GET
and does not attempt to page through it. If you need the full back catalogue,
open the page in a browser, watch the request it makes when you change year or
click through pages, and add the parameter to `JUDGEMENT_LIST_PARAMS`. Until
then, treat FSC coverage as "leading cases plus whatever the default listing
returns" and say so in your methodology.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterator
from urllib.parse import unquote, urljoin

from extractors.html_extractor import clean_text, make_soup
from extractors.metadata_extractor import (
    extract_citations, extract_judges, split_parties,
)
from models.legal_document import DocumentType, LegalDocument
from scrapers.base_scraper import BaseScraper, Discovered
from utils.dates import extract_year, normalise_date

LEADING_JUDGEMENTS = ("/en/leading-judgements/", "/?p=209")
JUDGEMENT_LIST = "/judgement.php"
# Add the real paging/filter parameters here once you have watched the request.
JUDGEMENT_LIST_PARAMS: dict[str, str] = {}

PDF_LINK = re.compile(r"\.pdf(\?|$)", re.I)
# "Shariat Petition No. 29 - I - of 1993" / "S.P.NO.36-L-1992" / "S.P.2.L.1979"
CASE_IN_NAME = re.compile(
    r"(?:Shariat\s*Petition|Sh\.?\s*Pet|S\.?\s*P)\.?\s*(?:No\.?)?\s*"
    r"(\d+)\s*[.\-/\s]*\s*([ILK])?\s*[.\-/\s]*\s*(?:of)?\s*[.\-/\s]*"
    r"((?:19|20)\d{2})",
    re.I,
)
# "PLD-2023 FSC-301" or "PLD 2023 FSC 301"
FSC_CITATION = re.compile(r"\bPLD[-\s]*((?:19|20)\d{2})\s*FSC[-\s]*(\d+)\b", re.I)
DECISION_DATE = re.compile(r"Date\s+of\s+Decision\s*[:\-]?\s*([\d.\-/]+)", re.I)

COLUMN_MAP = {
    "sno": "serial", "srno": "serial",
    "title": "title",
    "casetitle": "title",
    "caseno": "case_number",
    "subject": "subject",
    "bench": "bench",
    "judgmentdate": "judgment_date",
    "judgementdate": "judgment_date",
    "referencewithdateofdecision": "reference",
    "sections": "sections", "section": "sections",
    "citations": "citation", "citation": "citation",
    "yearofjudgment": "year", "yearofjudgement": "year",
    "downloadjudgment": "download", "downloadjudgement": "download",
    "download": "download",
}


def _normalise_header(text: str) -> str:
    return re.sub(r"[^a-z]", "", (text or "").lower())


class FederalShariatCourtScraper(BaseScraper):
    source_key = "federal_shariat_court"

    # ------------------------------------------------------------------
    def preflight(self) -> None:
        self.log.info(
            "Leading-judgements coverage is verified; the bulk /judgement.php "
            "listing is read with a plain GET only -- see the module docstring "
            "before claiming full FSC coverage."
        )

    # ------------------------------------------------------------------
    def discover(self) -> Iterator[Discovered]:
        found = 0
        for path in LEADING_JUDGEMENTS:
            url = urljoin(self.config.base_url, path)
            response = self._fetch(url)
            if response is None:
                continue
            items = list(self._parse_tables(response.text, response.url,
                                            listing="leading"))
            if items:
                self.log.info("%s -> %d judgments", path, len(items))
                found += len(items)
                yield from items
                break                      # the two paths are the same page

        url = urljoin(self.config.base_url, JUDGEMENT_LIST)
        response = self._fetch(url, params=JUDGEMENT_LIST_PARAMS or None)
        if response is not None:
            items = list(self._parse_tables(response.text, response.url,
                                            listing="cfms"))
            self.log.info("%s -> %d judgments", JUDGEMENT_LIST, len(items))
            found += len(items)
            yield from items

        if not found:
            self.log.error(
                "No judgment links found on any FSC listing. Run --probe and "
                "inspect the saved HTML before editing this parser."
            )

    # ------------------------------------------------------------------
    def _parse_tables(self, html: str, base_url: str,
                      listing: str) -> Iterator[Discovered]:
        soup = make_soup(html)
        seen: set[str] = set()

        for table in soup.find_all("table"):
            headers = self._headers(table)
            for row in table.find_all("tr"):
                cells = row.find_all("td")
                if not cells:
                    continue
                values: dict[str, str] = {}
                pdf_url: str | None = None
                for index, cell in enumerate(cells):
                    field = headers.get(index)
                    if field:
                        values[field] = cell.get_text(" ", strip=True)
                    for anchor in cell.find_all("a", href=True):
                        if PDF_LINK.search(anchor["href"]):
                            pdf_url = urljoin(base_url, anchor["href"].strip())
                if pdf_url is None or pdf_url in seen:
                    continue
                seen.add(pdf_url)
                values["listing"] = listing
                values["listing_url"] = base_url
                values["filename"] = unquote(Path(pdf_url.split("?")[0]).name)
                yield self._make_item(pdf_url, values)

        # Judgment PDFs linked outside a table (the site mixes both).
        for anchor in soup.find_all("a", href=True):
            href = anchor["href"].strip()
            if not PDF_LINK.search(href):
                continue
            pdf_url = urljoin(base_url, href)
            if pdf_url in seen:
                continue
            seen.add(pdf_url)
            block = anchor.find_parent(["tr", "li", "div", "p"])
            context = clean_text(block.get_text("\n")) if block else ""
            yield self._make_item(pdf_url, {
                "title": anchor.get_text(" ", strip=True) or None,
                "context": context[:1500],
                "listing": listing,
                "listing_url": base_url,
                "filename": unquote(Path(pdf_url.split("?")[0]).name),
            })

    @staticmethod
    def _headers(table) -> dict[int, str]:
        header_row = table.find("tr")
        if header_row is None:
            return {}
        mapping: dict[int, str] = {}
        for index, cell in enumerate(header_row.find_all(["th", "td"])):
            key = _normalise_header(cell.get_text(" ", strip=True))
            if key in COLUMN_MAP:
                mapping[index] = COLUMN_MAP[key]
        return mapping

    def _make_item(self, pdf_url: str, values: dict) -> Discovered:
        blob = " ".join(str(v) for v in values.values() if v)
        reference = values.get("reference") or values.get("context") or ""
        # Year precedence matters: --start-year/--end-year filter on when a
        # case was DECIDED, but an FSC filename carries the year the petition
        # was FILED, which can be decades earlier (the Riba judgment is a 1991
        # petition decided in 2022). So read the decision date first and only
        # fall back to the filename.
        decision = self._decision_date(reference)
        citation_year = None
        citation_match = FSC_CITATION.search(reference)
        if citation_match:
            citation_year = int(citation_match.group(1))

        return Discovered(
            url=pdf_url,
            hints={k: v for k, v in values.items() if v},
            document_type=DocumentType.JUDGMENT.value,
            year=(extract_year(values.get("year", ""))
                  or extract_year(values.get("judgment_date", ""))
                  or extract_year(decision or "")
                  or citation_year
                  or extract_year(values.get("filename", ""))
                  or extract_year(blob)),
        )

    # ------------------------------------------------------------------
    def parse_document(self, item: Discovered, response) -> LegalDocument | None:
        title = item.hint("title") or self._title_from_filename(item.hint("filename"))
        reference = item.hint("reference") or item.hint("context") or ""

        document = self.new_document(
            source_url=item.hint("listing_url") or item.url,
            document_url=item.url,
            document_file_url=item.url,
            title=title,
            case_number=(item.hint("case_number")
                         or self._case_number(item.hint("filename") or "")
                         or self._case_number(f"{title} {reference}")),
            document_type=DocumentType.JUDGMENT.value,
            court="Federal Shariat Court",
            bench=item.hint("bench"),
            jurisdiction="Pakistan",
            matter_type=item.hint("subject"),
            language="en",
            raw={k: v for k, v in item.hints.items() if v},
        )

        date = (normalise_date(item.hint("judgment_date"))
                or self._decision_date(reference))
        document.date = date
        document.judgment_date = date

        citation = item.hint("citation") or self._fsc_citation(reference)
        if citation:
            document.citation = citation

        if item.hint("bench"):
            document.judges = extract_judges(item.hint("bench"))
        if item.hint("sections"):
            document.raw["sections"] = item.hint("sections")
        if item.hint("subject"):
            document.summary = item.hint("subject")
        # keep the filing year too -- it is genuinely different information
        petition_year = extract_year(document.case_number or "")
        if petition_year:
            document.raw["petition_year"] = petition_year

        self.ingest_pdf(document, item.url, name_hint=title)

        if document.full_text:
            head = document.full_text[:4000]
            if not document.judges:
                document.judges = extract_judges(head)
                if document.judges:
                    document.notes.append("judges parsed from the PDF header text")
            document.cited_cases = extract_citations(document.full_text)
        if title:
            document.parties = split_parties(title) or document.parties
        return document

    # ------------------------------------------------------------------
    @staticmethod
    def _title_from_filename(filename: str | None) -> str | None:
        if not filename:
            return None
        stem = Path(filename).stem.replace("_", " ")
        return " ".join(stem.split()) or None

    @staticmethod
    def _case_number(text: str) -> str | None:
        match = CASE_IN_NAME.search(text or "")
        if not match:
            return None
        registry = f"-{match.group(2).upper()}" if match.group(2) else ""
        return f"Shariat Petition No. {match.group(1)}{registry}/{match.group(3)}"

    @staticmethod
    def _fsc_citation(text: str) -> str | None:
        match = FSC_CITATION.search(text or "")
        return f"PLD {match.group(1)} FSC {match.group(2)}" if match else None

    @staticmethod
    def _decision_date(text: str) -> str | None:
        match = DECISION_DATE.search(text or "")
        return normalise_date(match.group(1)) if match else None
