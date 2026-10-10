"""The Pakistan Code -- Ministry of Law & Justice consolidated federal statutes.

VERIFIED against the live site (see README "Source verification log").

How the site actually works
--------------------------
* Discovery: the alphabetical index is server-rendered HTML at
      /english/LGu0xAD?alp=<A-Z>&page=<n>&action=<inactive|active|null|notactive>
  The same template also backs /english/LGu0xBD.php (chronological) and
  /english/LGu0xVD.php (category-wise).
* One index page lists four groups in sequence: federal (primary) legislation,
  subordinate legislation, ordinances, and amendments. A single statute can
  therefore appear twice on one page -- dedup by URL handles it.
* Each entry is an <a> whose href is an opaque token path ending in "-sg-jjj...",
  e.g.  /english/UY2FqaJw1-apaUY2Fqa-apaUY2Fra54%3D-sg-jjjjjjjjjjjjj
  followed by a pipe-delimited metadata line:
      "General Laws | XVIII of 1999 | Promulgation Date: September 24 1999. |
       Archive 0 | Under Review"
* The detail page carries no statute body in HTML -- the text lives only in a
  PDF at /pdffiles/administrator<hash>.pdf, embedded through ViewerJS.
  So: HTML gives metadata, PDF gives full_text.

Parser robustness note
----------------------
The site's CSS class names were not verifiable from the rendered output, so
this parser deliberately keys off URL patterns and visible text structure
rather than class selectors. That survives a restyle; it would only break if
the URL scheme itself changed.
"""

from __future__ import annotations

import re
import string
from collections.abc import Iterator
from urllib.parse import urljoin

from extractors.html_extractor import make_soup
from extractors.metadata_extractor import (
    extract_document_number,
    guess_document_type,
)
from models.legal_document import DocumentType, LegalDocument
from scrapers.base_scraper import BaseScraper, Discovered
from utils.dates import extract_year, normalise_date

INDEX_ALPHABETICAL = "/english/LGu0xAD"
INDEX_CHRONOLOGICAL = "/english/LGu0xBD.php"
INDEX_CATEGORY = "/english/LGu0xVD.php"

# Detail pages: opaque token, always ending "-sg-" + a run of 'j'.
DETAIL_HREF = re.compile(r"/english/[A-Za-z0-9%._+-]{8,}-sg-j+\s*$")
PDF_HREF = re.compile(r"/pdffiles/[^\"'?#]+\.pdf", re.I)

# Sections the index renders, in order. `action` selects which group is
# highlighted; all groups are present in the markup either way.
LIST_ACTIONS = ("inactive", "active", "null", "notactive")

_NO_RECORDS = re.compile(r"no\s+records?\s+found", re.I)


class PakistanCodeScraper(BaseScraper):
    source_key = "pakistan_code"

    # ------------------------------------------------------------------
    def discover(self) -> Iterator[Discovered]:
        max_pages = self.settings.max_pages or 40
        base = self.config.base_url

        for letter in string.ascii_uppercase:
            empty_streak = 0
            for page in range(1, max_pages + 1):
                url = (
                    f"{urljoin(base, INDEX_ALPHABETICAL)}?alp={letter}&page={page}&action=inactive"
                )
                response = self._fetch(url)
                if response is None:
                    break

                entries = list(self._parse_index(response.text, response.url))
                if not entries:
                    empty_streak += 1
                    if empty_streak >= 1 or _NO_RECORDS.search(response.text):
                        self.log.debug("letter %s: no more entries after page %d", letter, page)
                        break
                    continue

                self.log.info("index %s page %d -> %d entries", letter, page, len(entries))
                yield from entries

                if self.settings.limit and self.stats.stored >= self.settings.limit:
                    return

    # ------------------------------------------------------------------
    def _parse_index(self, html: str, base_url: str) -> Iterator[Discovered]:
        soup = make_soup(html)
        seen_on_page: set[str] = set()

        for anchor in soup.find_all("a", href=True):
            href = anchor["href"].strip()
            if not DETAIL_HREF.search(href):
                continue
            url = urljoin(base_url, href)
            if url in seen_on_page:
                continue
            seen_on_page.add(url)

            title = anchor.get_text(" ", strip=True)
            if not title:
                continue

            meta_line = self._metadata_line_near(anchor)
            hints = self._parse_meta_line(meta_line)
            hints["title"] = title
            hints["meta_line"] = meta_line

            year = (
                extract_year(hints.get("document_number") or "")
                or extract_year(hints.get("promulgation_date") or "")
                or extract_year(title)
            )

            yield Discovered(
                url=url,
                hints=hints,
                document_type=guess_document_type(title, hints.get("category")),
                year=year,
            )

    @staticmethod
    def _metadata_line_near(anchor) -> str:
        """The pipe-delimited metadata sits in the same block as the link.

        Walk up to the nearest block-level ancestor and take the text that
        follows the anchor. Falls back to the anchor's following siblings.
        """
        block = anchor.find_parent(["li", "tr", "div", "p", "td"])
        if block is not None:
            text = block.get_text(" ", strip=True)
            anchor_text = anchor.get_text(" ", strip=True)
            if anchor_text and anchor_text in text:
                tail = text.split(anchor_text, 1)[1]
                if "|" in tail:
                    return " ".join(tail.split())
        parts: list[str] = []
        for sibling in anchor.next_siblings:
            chunk = getattr(sibling, "get_text", lambda *a, **k: str(sibling))(" ", strip=True)  # noqa: B023 (lambda is called immediately)
            if chunk:
                parts.append(chunk)
            if len(" ".join(parts)) > 250:
                break
        return " ".join(" ".join(parts).split())

    @staticmethod
    def _parse_meta_line(line: str) -> dict:
        """ "General Laws | XVIII of 1999 | Promulgation Date: September 24 1999.
        | Archive 0 | Under Review"  ->  structured fields."""
        hints: dict[str, str] = {}
        if not line:
            return hints
        fields = [f.strip(" .") for f in line.split("|") if f.strip(" .")]
        for index, field_text in enumerate(fields):
            lowered = field_text.lower()
            if ":" in field_text:
                label, _, value = field_text.partition(":")
                label = label.strip().lower().replace(" ", "_")
                value = value.strip(" .")
                if value and value.lower() not in {"december", "n/a", "na"}:
                    hints[label] = value
                continue
            if index == 0 and "law" in lowered:
                hints["category"] = field_text
            elif re.search(r"\bof\s+(1[89]|20)\d{2}\b", field_text, re.I):
                hints["document_number"] = re.sub(
                    r"^(?:Act|Ordinance|Order)\s*No\.?\s*", "", field_text, flags=re.I
                ).strip()
            elif "review" in lowered:
                hints["review_status"] = field_text
            elif lowered.startswith("archive"):
                hints["archive"] = field_text
        return hints

    # ------------------------------------------------------------------
    def parse_document(self, item: Discovered, response) -> LegalDocument | None:
        soup = make_soup(response.text)
        title = item.hint("title") or self._page_title(soup)
        if not title:
            self.log.warning("no title for %s", item.url)
            return None

        document = self.new_document(
            source_url=response.url,
            document_url=response.url,
            title=title,
            document_type=item.document_type or DocumentType.ACT.value,
            jurisdiction="Pakistan",
            province=None,  # federal statutes
            category=item.hint("category"),
            language="en",
            raw={k: v for k, v in item.hints.items() if v},
        )

        document.document_number = item.hint("document_number") or extract_document_number(title)
        promulgation = normalise_date(item.hint("promulgation_date"))
        document.promulgation_date = promulgation
        document.date = promulgation
        document.publication_date = normalise_date(item.hint("updated_date"))
        if item.hint("review_status"):
            document.case_status = item.hint("review_status")

        if not document.date:
            year = item.year or extract_year(title)
            if year:
                document.raw["year"] = year
                document.notes.append(
                    "no full promulgation date published; year taken from the statute number/title"
                )

        pdf_url = self._find_pdf(soup, response.url)
        if pdf_url:
            self.ingest_pdf(document, pdf_url, name_hint=title)
        else:
            # Some entries are index stubs with no PDF attached yet.
            body = self._page_body_text(soup)
            if body:
                self.attach_html_text(document, body, name_hint=title)
            else:
                document.notes.append("no PDF link and no body text on detail page")

        return document

    # ------------------------------------------------------------------
    @staticmethod
    def _find_pdf(soup, base_url: str) -> str | None:
        for anchor in soup.find_all("a", href=True):
            if PDF_HREF.search(anchor["href"]):
                return urljoin(base_url, anchor["href"].strip())
        # ViewerJS embeds the path in the fragment: /ViewerJS/#../pdffiles/x.pdf
        for attribute in ("src", "data", "href"):
            for tag in soup.find_all(attrs={attribute: True}):
                match = PDF_HREF.search(str(tag.get(attribute)))
                if match:
                    return urljoin(base_url, match.group(0))
        match = PDF_HREF.search(str(soup))
        return urljoin(base_url, match.group(0)) if match else None

    @staticmethod
    def _page_title(soup) -> str | None:
        for tag in ("h1", "h2", "h3"):
            node = soup.find(tag)
            if node:
                text = node.get_text(" ", strip=True)
                if text and len(text) > 5:
                    return text
        if soup.title and soup.title.string:
            candidate = soup.title.string.strip()
            if candidate.lower() not in {"pakistan code", ""}:
                return candidate
        return None

    @staticmethod
    def _page_body_text(soup) -> str:
        from extractors.html_extractor import clean_text

        node = soup.find(id="pdf") or soup.find("main") or soup.find("article")
        if node is None:
            return ""
        return clean_text(node.get_text("\n"))
