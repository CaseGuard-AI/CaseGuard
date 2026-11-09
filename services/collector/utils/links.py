"""Resolving links the way a browser does.

The court sites moved to relative links (#147). A relative href must be resolved against
the document's ``<base href>`` when it has one (SHC uses ``<base href="/caselaw/">``), and
otherwise against the page URL. Links inside HTML comments are dead and must be ignored.
"""

from __future__ import annotations

from urllib.parse import urljoin

from bs4 import BeautifulSoup, Comment


def document_base(soup: BeautifulSoup, page_url: str) -> str:
    """The URL relative links resolve against: ``<base href>`` (itself resolved), else the page."""
    base = soup.find("base", href=True)
    if base is not None:
        href = str(base["href"]).strip()
        if href:
            return urljoin(page_url, href)
    return page_url


def resolve(soup: BeautifulSoup, page_url: str, href: str) -> str:
    return urljoin(document_base(soup, page_url), href.strip())


def strip_comments(soup: BeautifulSoup) -> BeautifulSoup:
    """Remove HTML comments in place, so commented-out links can't be picked up by text scans."""
    for comment in soup.find_all(string=lambda node: isinstance(node, Comment)):
        comment.extract()
    return soup
