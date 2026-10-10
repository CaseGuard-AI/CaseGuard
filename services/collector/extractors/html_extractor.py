"""HTML -> clean text + link discovery."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urldefrag, urljoin

from bs4 import BeautifulSoup

_BOILERPLATE = (
    "script",
    "style",
    "noscript",
    "nav",
    "header",
    "footer",
    "form",
    "iframe",
    "svg",
    "button",
)
_BLANK_LINES = re.compile(r"\n{3,}")
_SPACES = re.compile(r"[ \t\xa0]+")


@dataclass
class Link:
    url: str
    text: str


def make_soup(html: str) -> BeautifulSoup:
    """lxml when available (much faster), stdlib parser as fallback."""
    try:
        return BeautifulSoup(html, "lxml")
    except Exception:  # pragma: no cover
        return BeautifulSoup(html, "html.parser")


def extract_text(html: str, *, selector: str | None = None, strip_boilerplate: bool = True) -> str:
    soup = make_soup(html)
    if strip_boilerplate:
        for tag in soup(list(_BOILERPLATE)):
            tag.decompose()
    root = soup.select_one(selector) if selector else soup
    if root is None:
        return ""
    # A <br> is a single line break. Use a sentinel so the get_text separator
    # does not turn it into a blank line as well.
    for br in root.find_all("br"):
        br.replace_with("\x01")
    text = root.get_text("\n").replace("\n\x01\n", "\n").replace("\x01", "\n")
    return clean_text(text)


def clean_text(text: str) -> str:
    lines = [_SPACES.sub(" ", line).strip() for line in (text or "").splitlines()]
    # Keep blank lines so paragraph structure survives, then collapse runs of
    # them to a single blank line.
    joined = "\n".join(lines)
    return _BLANK_LINES.sub("\n\n", joined).strip()


def extract_links(
    html: str,
    base_url: str,
    *,
    selector: str | None = None,
    pattern: str | None = None,
    same_host_only: bool = False,
) -> list[Link]:
    soup = make_soup(html)
    scope = soup.select_one(selector) if selector else soup
    if scope is None:
        return []
    regex = re.compile(pattern) if pattern else None
    from urllib.parse import urlparse

    base_host = urlparse(base_url).netloc.lower()

    seen: set[str] = set()
    links: list[Link] = []
    for anchor in scope.find_all("a", href=True):
        href = anchor["href"].strip()
        if not href or href.startswith(("javascript:", "mailto:", "tel:", "#")):
            continue
        absolute = urldefrag(urljoin(base_url, href)).url
        if regex and not regex.search(absolute):
            continue
        if same_host_only and urlparse(absolute).netloc.lower() != base_host:
            continue
        if absolute in seen:
            continue
        seen.add(absolute)
        links.append(Link(absolute, anchor.get_text(" ", strip=True)))
    return links


def extract_tables(html: str) -> list[list[list[str]]]:
    """Every <table> as a list of rows of cell strings."""
    soup = make_soup(html)
    tables: list[list[list[str]]] = []
    for table in soup.find_all("table"):
        rows: list[list[str]] = []
        for tr in table.find_all("tr"):
            cells = [c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]
            if any(cells):
                rows.append(cells)
        if rows:
            tables.append(rows)
    return tables


def find_pdf_links(html: str, base_url: str) -> list[Link]:
    return extract_links(html, base_url, pattern=r"\.pdf(\?|$)")
