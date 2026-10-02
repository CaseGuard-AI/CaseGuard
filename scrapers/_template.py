"""Copy this file to add a court. Nothing else in the project needs changing
beyond one line in config.SOURCES and one in scrapers/registry.py.

Before writing any code, answer these six questions about the site and put the
answers in the module docstring, the way pakistan_code.py does:

 1. How are documents discovered?     index page / search form / sitemap / API
 2. How does pagination work?         query param? POST? infinite scroll?
 3. How is a document downloaded?     inline HTML / PDF link / viewer iframe
 4. Where does metadata live?         listing row / detail page / PDF header
 5. Is JavaScript required?           if yes, is there an XHR you can call
                                      directly instead of driving a browser?
 6. What do robots.txt and the site's
    terms say?                        if disallowed, stop and ask for permission

If you cannot answer one of them from the live site, say so in the docstring
and mark the source "needs_probe" in config.py rather than guessing.
"""

from __future__ import annotations

from typing import Iterator

from models.legal_document import DocumentType, LegalDocument
from scrapers.base_scraper import BaseScraper, Discovered


class TemplateScraper(BaseScraper):
    source_key = "CHANGE_ME"

    def preflight(self) -> None:
        """Optional: check the site is reachable and not challenging us."""

    def discover(self) -> Iterator[Discovered]:
        """Yield one Discovered per candidate document.

        Honour self.settings.max_pages and self.settings.limit, and use
        self._fetch(url) rather than the client directly so failures are
        tracked instead of raised.
        """
        raise NotImplementedError

    def parse_document(self, item: Discovered, response) -> LegalDocument | None:
        """Build the normalised record.

        Rules:
          * populate a field only if the source actually stated it
          * anything inferred goes in document.notes
          * use self.ingest_pdf(...) for PDFs, self.attach_html_text(...) for HTML
        """
        document = self.new_document(
            source_url=response.url,
            document_url=response.url,
            document_type=DocumentType.JUDGMENT.value,
        )
        raise NotImplementedError
