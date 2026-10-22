"""Sindh High Court -- caselaw.shc.gov.pk

VERIFIED end to end. This is the richest free case-law source in Pakistan and
the portal exposes it as ordinary server-rendered HTML tables.

How the site actually works
--------------------------
Discovery is two hops:

1. **Judge index** at `/caselaw/public/rpt-afr` (Report-002). An HTML table of
   sitting judges, each with two links:
       /caselaw/public/reported-judgements-detail-all/<judge_id>/-1        all
       /caselaw/public/reported-judgements-detail-all/<judge_id>/AFR/AFR   reported only
   The same judge_id scheme backs the other reports (`rpt-benchwise`,
   `rpt-cat-judgement`, `rpt-sbdb-cons`, `rpt-jo`, `reported-judgements`).

2. **Per-judge table**. Columns differ slightly between the two variants, so
   this parser maps cells by **header name**, never by position:
       S.No. | Citation | Case No. | Case Type | Case Year | Parties |
       Order_Date | A.F.R | Head Notes/Tag Line | Bench | Apex Court | Apex Status
   (the `-1` variant additionally carries `Bench Type` and `Order/Judgment`)

   The Case No. cell links to the judgment file:
       /caselaw/download-file.php?doc=<base64>&citation=<...>
   and its text packs four fields at once:
       "Suit 333/2004 (S.B.) Sindh High Court, Karachi"
        matter      number    bench   court, seat

Scale and politeness
--------------------
The judge index reports roughly 70,000 judgments across sitting judges. Do not
try to take that in one run. `--limit` is the control, and PDF download is the
expensive part -- `--no-pdfs` gives you the full metadata corpus quickly and
lets you fetch files selectively afterwards.

Scope is set by PKLEGAL_SHC_SCOPE:
    afr  (default)  only judgments the court approved for reporting -- smaller,
                    higher quality, and the ones that carry citations
    all             every uploaded judgment/order

One judgment appears under every judge on the bench. Dedup is automatic: the
document URL (the `doc=` token) is identical, so the second sighting is skipped
by the crawl state.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterator
from urllib.parse import urljoin

from extractors.html_extractor import clean_text, make_soup
from extractors.metadata_extractor import (
    extract_case_status,
    extract_citations,
    extract_cited_laws,
    extract_judges,
    split_parties,
)
from models.legal_document import DocumentType, LegalDocument
from scrapers.base_scraper import BaseScraper, Discovered
from utils.dates import extract_year, normalise_date

JUDGE_INDEX = "/caselaw/public/rpt-afr"
# Fallback listing, used when the judge index cannot be read.
TOP_TREND = "/caselaw/public/top-trend-judgements"

JUDGE_DETAIL = re.compile(r"/reported-judgements-detail-all/(\d+)/(-1|AFR)")
DOWNLOAD_LINK = re.compile(r"/caselaw/download-file\.php\?", re.I)

# "Suit 333/2004 (S.B.) Sindh High Court, Karachi"
CASE_CELL = re.compile(
    r"^(?P<matter>.*?)\s*(?P<number>\d+/\d{4})\s*"
    r"(?:\((?P<bench_type>[SDF]\.?B\.?)\))?\s*"
    r"(?P<court>.*)$",
    re.S,
)
APEX_CASE = re.compile(r"\b([A-Z][A-Za-z.]*\.\s?\d+-?[A-Z]?/\d{4})")
ATTACHED = re.compile(r"attached cases?:\s*(.+)$", re.I)

# Header text (lower-cased, punctuation stripped) -> our field name.
COLUMN_MAP = {
    "sno": "serial",
    "citation": "citation",
    "caseno": "case_cell",
    "casetype": "case_type",
    "caseyear": "case_year",
    "parties": "parties",
    "benchtype": "bench_type_col",
    "orderjudgment": "order_or_judgment",
    "orderjudgement": "order_or_judgment",
    "orderdate": "order_date",
    "afr": "afr",
    "headnotestagline": "head_note",
    "bench": "bench",
    "apexcourt": "apex_court",
    "apexstatus": "apex_status",
}


def _normalise_header(text: str) -> str:
    return re.sub(r"[^a-z]", "", (text or "").lower())


class SindhHighCourtScraper(BaseScraper):
    source_key = "shc_caselaw"

    ENTRY_HEAD = re.compile(r"^\s*(\d+)\)\s*(\d+/\d{4})\s+(\S.*)$")

    @property
    def scope(self) -> str:
        value = os.getenv("PKLEGAL_SHC_SCOPE", "afr").strip().lower()
        return value if value in {"afr", "all"} else "afr"

    # ------------------------------------------------------------------
    def preflight(self) -> None:
        self.log.info(
            "Scope: %s (set PKLEGAL_SHC_SCOPE=all for every uploaded judgment, "
            "not only those approved for reporting).",
            self.scope,
        )
        if self.settings.download_pdfs and not self.settings.limit:
            self.log.warning(
                "PDF download is on with no --limit. This portal holds tens of "
                "thousands of judgments; consider a --no-pdfs metadata pass "
                "first, or set --limit."
            )

    # ------------------------------------------------------------------
    def discover(self) -> Iterator[Discovered]:
        judges = self._judge_pages()
        if not judges:
            self.log.warning("Judge index unreadable; falling back to %s", TOP_TREND)
            yield from self._discover_top_trend()
            return

        max_judges = self.settings.max_pages or len(judges)
        self.log.info(
            "Judge index: %d judges, visiting %d", len(judges), min(max_judges, len(judges))
        )

        for name, url in judges[:max_judges]:
            response = self._fetch(url)
            if response is None:
                continue
            rows = list(self._parse_table(response.text, response.url, name))
            self.log.info("%s -> %d rows", name[:50], len(rows))
            yield from rows
            if self.settings.limit and self.stats.stored >= self.settings.limit:
                return

    # ------------------------------------------------------------------
    def _judge_pages(self) -> list[tuple[str, str]]:
        """[(judge name, detail-table URL)] read from the report index."""
        response = self._fetch(urljoin(self.config.base_url, JUDGE_INDEX))
        if response is None:
            return []
        soup = make_soup(response.text)
        wanted = "AFR" if self.scope == "afr" else "-1"
        judges: list[tuple[str, str]] = []
        seen: set[str] = set()

        for row in soup.find_all("tr"):
            cells = row.find_all(["td", "th"])
            if len(cells) < 2:
                continue
            name = cells[1].get_text(" ", strip=True)
            for anchor in row.find_all("a", href=True):
                match = JUDGE_DETAIL.search(anchor["href"])
                if not match or match.group(2) != wanted:
                    continue
                url = (
                    self.config.base_url.rstrip("/")
                    + "/caselaw/public/reported-judgements-detail-all/"
                    + match.group(1)
                    + ("/AFR/AFR" if wanted == "AFR" else "/-1")
                )
                if url in seen:
                    continue
                seen.add(url)
                judges.append((name or f"judge {match.group(1)}", url))
        return judges

    # ------------------------------------------------------------------
    def _parse_table(self, html: str, base_url: str, judge_name: str) -> Iterator[Discovered]:
        soup = make_soup(html)
        for table in soup.find_all("table"):
            headers = self._headers(table)
            if "case_cell" not in headers.values():
                continue  # not the judgments table
            for row in table.find_all("tr"):
                cells = row.find_all("td")
                if not cells:
                    continue  # header row
                item = self._row_to_item(cells, headers, base_url, judge_name)
                if item is not None:
                    yield item

    @staticmethod
    def _headers(table) -> dict[int, str]:
        """Column index -> field name, taken from the header text.

        Position-based parsing would silently mis-assign fields, because the
        two table variants differ by two columns.
        """
        header_row = table.find("tr")
        if header_row is None:
            return {}
        mapping: dict[int, str] = {}
        for index, cell in enumerate(header_row.find_all(["th", "td"])):
            key = _normalise_header(cell.get_text(" ", strip=True))
            if key in COLUMN_MAP:
                mapping[index] = COLUMN_MAP[key]
        return mapping

    # ------------------------------------------------------------------
    def _row_to_item(
        self, cells, headers: dict[int, str], base_url: str, judge_name: str
    ) -> Discovered | None:
        values: dict[str, str] = {}
        download_url: str | None = None

        for index, cell in enumerate(cells):
            field = headers.get(index)
            if field is None:
                continue
            values[field] = cell.get_text(" ", strip=True)
            if field == "case_cell":
                for anchor in cell.find_all("a", href=True):
                    if DOWNLOAD_LINK.search(anchor["href"]):
                        download_url = urljoin(base_url, anchor["href"])
                        break

        case_cell = values.get("case_cell")
        if not case_cell:
            return None
        parsed = CASE_CELL.match(" ".join(case_cell.split()))
        if not parsed:
            return None

        court_text = parsed.group("court") or ""
        attached = ATTACHED.search(court_text)
        if attached:
            court_text = court_text[: attached.start()].strip(" ;,")

        hints = {
            "case_number": parsed.group("number"),
            "matter_type": (parsed.group("matter") or "").strip(" .-") or None,
            "bench_type": parsed.group("bench_type"),
            "court_text": court_text.strip(" .,;"),
            "attached_cases": attached.group(1).strip() if attached else None,
            "download_url": download_url,
            "listing_judge": judge_name,
        }
        hints.update({k: v for k, v in values.items() if v and v.strip().lower() != "nil"})

        return Discovered(
            url=download_url or f"{base_url}#case={parsed.group('number').replace('/', '-')}",
            hints=hints,
            document_type=DocumentType.JUDGMENT.value,
            year=(
                extract_year(values.get("case_year", "")) or extract_year(parsed.group("number"))
            ),
            inline=True,
        )

    # ------------------------------------------------------------------
    def parse_document(self, item: Discovered, response) -> LegalDocument | None:
        parties_text = item.hint("parties") or ""
        case_number = item.hint("case_number")
        if not (parties_text or case_number):
            return None

        court_text = item.hint("court_text") or "Sindh High Court"
        court = court_text.split(",")[0].strip() or "Sindh High Court"
        seat = court_text.split(",", 1)[1].strip() if "," in court_text else None
        order_or_judgment = (item.hint("order_or_judgment") or "").lower()

        document = self.new_document(
            source_url=item.url,
            document_url=item.hint("download_url") or item.url,
            document_file_url=item.hint("download_url"),
            title=parties_text or f"{item.hint('matter_type') or ''} {case_number}".strip(),
            case_number=case_number,
            document_type=(
                DocumentType.ORDER.value
                if order_or_judgment.startswith("order")
                else DocumentType.JUDGMENT.value
            ),
            court=court,
            bench=item.hint("bench"),
            province="Sindh",
            jurisdiction="Pakistan",
            matter_type=item.hint("matter_type"),
            category=item.hint("case_type"),
            language="en",
            raw={k: v for k, v in item.hints.items() if v},
        )
        if seat:
            document.raw["seat"] = seat

        order_date = normalise_date(item.hint("order_date"))
        document.date = order_date
        document.judgment_date = order_date

        document.judges = extract_judges(item.hint("bench"))
        document.parties = split_parties(parties_text)

        citation_text = item.hint("citation")
        if citation_text and citation_text.strip().lower() != "nil":
            citations = [c.strip() for c in citation_text.split(",") if c.strip()]
            document.citation = citations[0] if citations else None
            if len(citations) > 1:
                document.raw["all_citations"] = citations

        if item.hint("head_note"):
            document.summary = item.hint("head_note")

        connected: list[str] = []
        if item.hint("attached_cases"):
            connected += [c.strip() for c in item.hint("attached_cases").split(",") if c.strip()]
        if item.hint("apex_court"):
            connected += APEX_CASE.findall(item.hint("apex_court"))
        document.connected_cases = list(dict.fromkeys(connected))
        if item.hint("apex_status"):
            document.case_status = extract_case_status(item.hint("apex_status"))

        download_url = item.hint("download_url")
        if download_url and self.settings.download_pdfs:
            self.ingest_pdf(
                document,
                download_url,
                name_hint=f"{item.hint('matter_type') or 'case'}_{case_number}",
            )

        if not document.full_text:
            parts = [parties_text, item.hint("head_note"), item.hint("bench")]
            self.attach_html_text(document, "\n".join(p for p in parts if p))
            document.notes.append(
                "full_text is the portal's table row (parties, head-note, "
                "bench), not the judgment itself"
                + ("" if download_url else "; no judgment file was linked")
            )

        document.cited_cases = extract_citations(document.summary or "")
        document.cited_laws = extract_cited_laws(document.summary or "")
        return document

    # ==================================================================
    # fallback: the curated "top searched" listing (plain text, no table)
    # ==================================================================
    def _discover_top_trend(self) -> Iterator[Discovered]:
        url = urljoin(self.config.base_url, TOP_TREND)
        response = self._fetch(url)
        if response is None:
            return
        soup = make_soup(response.text)
        for tag in soup(["script", "style", "nav", "header", "footer"]):
            tag.decompose()
        lines = [ln for ln in clean_text(soup.get_text("\n")).splitlines() if ln.strip()]

        block: list[str] = []
        for line in lines:
            if self.ENTRY_HEAD.match(line):
                if block:
                    item = self._top_trend_item(block, response.url)
                    if item:
                        yield item
                block = [line]
            elif block:
                block.append(line)
        if block:
            item = self._top_trend_item(block, response.url)
            if item:
                yield item

    def _top_trend_item(self, block: list[str], base_url: str) -> Discovered | None:
        head = self.ENTRY_HEAD.match(block[0])
        if not head:
            return None
        number, rest = head.group(2), head.group(3)
        hints: dict = {"case_number": number, "parties": rest, "court_text": "Sindh High Court"}
        for line in block[1:]:
            if line.lower().startswith("sindh high court"):
                hints["court_text"] = line.strip()
            elif ":" in line:
                label, _, value = line.partition(":")
                key = re.sub(r"\s+", "_", label.strip().lower())
                if value.strip() and len(key) < 30:
                    hints[key] = value.strip()
            elif "Justice" in line:
                hints["bench"] = line.strip()
        return Discovered(
            url=f"{base_url}#case={number.replace('/', '-')}",
            hints=hints,
            document_type=DocumentType.JUDGMENT.value,
            year=extract_year(number),
            inline=True,
        )
