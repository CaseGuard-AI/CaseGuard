"""The workflow every source shares.

A concrete scraper implements exactly two things:

    discover()                      -> yields Discovered(url, hints)
    parse_document(item, response)  -> LegalDocument | None

Everything else -- politeness, retries, skip-if-seen, conditional GETs,
PDF download + text extraction, content hashing, duplicate detection,
validation, storage, failure tracking -- happens here, once.

That split is what keeps a new court to ~150 lines of parsing instead of a
copy of the whole pipeline.
"""

from __future__ import annotations

import abc
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from config import Settings, SourceConfig
from extractors.pdf_extractor import extract_pdf
from models.legal_document import ExtractionStatus, FileStatus, LegalDocument
from storage.file_storage import FileStorage
from storage.jsonl_storage import JsonlStorage
from storage.state_store import StateStore
from utils.dates import extract_year, in_year_range
from utils.hashing import sha256_bytes
from utils.http_client import FetchError, HttpClient, RobotsDisallowed
from utils.logging_config import JsonlEventLogger, get_logger


@dataclass
class Discovered:
    """A candidate document found during crawling."""

    url: str
    hints: dict[str, Any] = field(default_factory=dict)
    document_type: str | None = None
    year: int | None = None

    #: True when the listing page already carried everything we need, so the
    #: pipeline should not issue a second request for a detail page.
    inline: bool = False

    def hint(self, key: str, default=None):
        return self.hints.get(key, default)


@dataclass
class ScrapeStats:
    discovered: int = 0
    fetched: int = 0
    skipped_seen: int = 0
    skipped_unchanged: int = 0
    changed: int = 0
    parsed: int = 0
    stored: int = 0
    duplicates: int = 0
    invalid: int = 0
    failed: int = 0
    pdfs: int = 0
    html_docs: int = 0
    pdf_extract_failed: int = 0
    scanned_pdfs: int = 0
    missing_metadata: int = 0

    def as_dict(self) -> dict[str, int]:
        return dict(self.__dict__)


class ScraperError(Exception):
    pass


class BaseScraper(abc.ABC):
    #: must match a key in config.SOURCES
    source_key: str = ""

    def __init__(
        self,
        settings: Settings,
        client: HttpClient,
        state: StateStore,
        files: FileStorage,
        storage: JsonlStorage,
        events: JsonlEventLogger,
        source_config: SourceConfig,
    ) -> None:
        self.settings = settings
        self.client = client
        self.state = state
        self.files = files
        self.storage = storage
        self.events = events
        self.config = source_config
        self.stats = ScrapeStats()
        self.log = get_logger(self.source_key or self.__class__.__name__)
        self.client.rate_limiter.set_host_delay(
            source_config.base_url, settings.delay_for(self.source_key)
        )

    # ==================================================================
    # to implement per source
    # ==================================================================
    @abc.abstractmethod
    def discover(self) -> Iterator[Discovered]:
        """Yield candidate documents. Must respect settings.max_pages/limit."""

    @abc.abstractmethod
    def parse_document(self, item: Discovered, response) -> LegalDocument | None:
        """Turn one fetched page into a normalised document (or None to skip)."""

    def preflight(self) -> None:
        """Optional per-source readiness check. Raise ScraperError to abort."""
        return None

    # ==================================================================
    # the shared run loop
    # ==================================================================
    def run(self) -> ScrapeStats:
        self._check_permission()
        self.preflight()
        self.log.info("Starting %s (%s)", self.config.name, self.config.base_url)
        if self.config.status != "verified":
            self.log.warning(
                "Source status is %r -- selectors are unverified. Review output "
                "before using it as corpus data.",
                self.config.status,
            )

        limit = self.settings.limit
        for item in self.discover():
            self.stats.discovered += 1
            if limit is not None and self.stats.stored >= limit:
                self.log.info("Reached --limit %d; stopping discovery.", limit)
                break
            if not in_year_range(item.year, self.settings.start_year, self.settings.end_year):
                continue
            try:
                self._process(item)
            except RobotsDisallowed as exc:
                self.stats.failed += 1
                self.log.error("robots.txt blocked %s", item.url)
                self.events.emit(
                    "robots_blocked", source=self.source_key, url=item.url, error=str(exc)
                )
            except Exception as exc:  # noqa: BLE001
                # One bad document must never kill the run.
                self.stats.failed += 1
                self.state.record_failure(item.url, self.source_key, str(exc))
                self.log.exception("Failed on %s: %s", item.url, exc)
                self.events.emit(
                    "document_failed", source=self.source_key, url=item.url, error=str(exc)
                )

        self.log.info("Finished %s: %s", self.source_key, self.stats.as_dict())
        return self.stats

    # ------------------------------------------------------------------
    def _process(self, item: Discovered) -> None:
        force = self.settings.force

        if item.inline:
            # The listing page already carried the record; no detail fetch.
            if not force and not self.state.should_process(item.url):
                self.stats.skipped_seen += 1
                return
            document = self.parse_document(item, None)
            if document is None:
                return
            self.stats.parsed += 1
            document.compute_content_hash()
            outcome = self._store(document, None, item)
            self.events.emit(
                "document",
                source=self.source_key,
                url=item.url,
                outcome=outcome,
                document_id=document.id,
                document_type=document.document_type,
                extraction_status=document.extraction_status,
                has_text=bool(document.full_text),
                validation=document.validate(),
            )
            return

        if not force and not self.state.should_process(item.url):
            etag, last_modified = self.state.validators_for(item.url)
            if not (etag or last_modified):
                self.stats.skipped_seen += 1
                self.log.debug("skip (already seen): %s", item.url)
                return
            response = self._fetch(item.url, etag=etag, last_modified=last_modified)
            if response is None:
                return
            if response.not_modified:
                self.stats.skipped_unchanged += 1
                self.log.debug("skip (304 Not Modified): %s", item.url)
                return
        else:
            response = self._fetch(item.url)
            if response is None:
                return

        self.stats.fetched += 1
        document = self.parse_document(item, response)
        if document is None:
            self.log.debug("parser returned nothing for %s", item.url)
            return
        self.stats.parsed += 1

        document.compute_content_hash()
        outcome = self._store(document, response, item)
        self.events.emit(
            "document",
            source=self.source_key,
            url=item.url,
            outcome=outcome,
            document_id=document.id,
            document_type=document.document_type,
            extraction_status=document.extraction_status,
            has_text=bool(document.full_text),
            validation=document.validate(),
        )

    # ------------------------------------------------------------------
    def _fetch(self, url: str, **kwargs):
        try:
            return self.client.get(url, **kwargs)
        except FetchError as exc:
            self.stats.failed += 1
            self.state.record_failure(url, self.source_key, str(exc))
            self.log.warning("fetch failed: %s", exc)
            self.events.emit(
                "fetch_failed", source=self.source_key, url=url, error=str(exc), status=exc.status
            )
            return None

    # ------------------------------------------------------------------
    def _store(self, document: LegalDocument, response, item: Discovered) -> str:
        # Crawl state is keyed on the URL we actually fetched (item.url), not
        # on document.source_url. Several documents can share one source_url
        # (a listing page), and collapsing them onto a single state row would
        # silently break incremental scraping for every source that discovers
        # documents from an index.
        state_url = item.url
        duplicate = self.state.duplicate_of(document.content_hash)
        if duplicate and duplicate["document_id"] != document.id:
            self.stats.duplicates += 1
            document.notes.append(
                f"duplicate content of {duplicate['document_id']} ({duplicate['url']})"
            )
            self.log.info("duplicate content, not storing: %s", state_url)
            self.state.mark_seen(
                state_url,
                self.source_key,
                document_id=document.id,
                content_hash=document.content_hash,
                status="duplicate",
            )
            return "duplicate"

        problems = document.validate()
        if problems:
            self.stats.invalid += 1
            document.notes.append("validation: " + "; ".join(problems))
            self.log.warning("validation issues on %s: %s", state_url, "; ".join(problems))
        if not document.title or not document.date:
            self.stats.missing_metadata += 1

        # Invalid documents are still written out, flagged. Losing them
        # silently would hide gaps in the corpus; the report counts them.
        if self.settings.dry_run:
            self.log.info(
                "[dry-run] would store %s (%s)", document.title or document.case_number, document.id
            )
            return "dry_run"

        self.storage.write(document)
        self.stats.stored += 1
        self.state.register_hash(document.content_hash, document.id, self.source_key, state_url)
        status_change = self.state.mark_seen(
            state_url,
            self.source_key,
            document_id=document.id,
            content_hash=document.content_hash,
            etag=getattr(response, "etag", None),
            last_modified=getattr(response, "last_modified", None),
            status="invalid" if problems else "ok",
        )
        if status_change == "changed":
            self.stats.changed += 1
            document.notes.append("content changed since previous run")
        self.state.clear_failure(state_url)
        return status_change

    # ==================================================================
    # helpers available to subclasses
    # ==================================================================
    def ingest_pdf(
        self, document: LegalDocument, pdf_url: str, name_hint: str | None = None
    ) -> LegalDocument:
        """Download a PDF, save the original, extract text, record failures.

        A PDF that cannot be read is still attached to the document with
        extraction_status/extraction_error set -- never dropped.
        """
        document.document_file_url = pdf_url
        if not self.settings.download_pdfs:
            document.extraction_status = ExtractionStatus.NOT_ATTEMPTED.value
            document.raw["file_status"] = FileStatus.NOT_DOWNLOADED.value
            document.notes.append("PDF download disabled (--no-pdfs)")
            return document

        year = document.date and extract_year(document.date) or extract_year(document.title or "")
        name = name_hint or document.title or document.case_number or "document"
        target = self.files.raw_path(self.source_key, name, pdf_url, year)

        cached = target.read_bytes() if target.exists() and not self.settings.force else None
        if cached is not None and cached.startswith(b"%PDF-"):
            data = cached
            self.log.debug("PDF already on disk: %s", target.name)
        else:
            response = self._fetch(pdf_url)
            if response is None:
                document.extraction_status = ExtractionStatus.FAILED.value
                document.extraction_error = f"could not download {pdf_url}"
                document.raw["file_status"] = FileStatus.DOWNLOAD_FAILED.value
                self.stats.pdf_extract_failed += 1
                return document
            data = response.content
            # Trust the bytes, not the Content-Type header. About 1 in 10 SHC downloads is an
            # empty body or another format (#147): flag it and never save it as a PDF.
            if not data.startswith(b"%PDF-"):
                status = FileStatus.EMPTY if not data.strip() else FileStatus.NOT_PDF
                document.extraction_status = ExtractionStatus.FAILED.value
                document.extraction_error = (
                    f"URL did not return a PDF (content-type="
                    f"{response.content_type!r}, {len(data)} bytes)"
                )
                document.raw["file_status"] = status.value
                self.stats.pdf_extract_failed += 1
                self.events.emit(
                    "pdf_not_a_pdf", source=self.source_key, url=pdf_url, file_status=status.value
                )
                return document
            target = self.files.save_binary(data, self.source_key, name, pdf_url, year)

        document.raw["file_status"] = FileStatus.OK.value
        self.stats.pdfs += 1
        document.file_path = str(target)
        document.mime_type = "application/pdf"
        document.raw.setdefault("pdf_sha256", sha256_bytes(data))

        extraction = extract_pdf(
            target, ocr=self.settings.ocr_enabled, ocr_language=self.settings.ocr_language
        )
        document.extraction_status = extraction.status
        document.extraction_error = extraction.error
        document.page_count = extraction.page_count
        if extraction.text:
            document.full_text = extraction.text
            self.files.save_text(extraction.text, self.source_key, name, pdf_url, year)
        if extraction.is_scanned:
            self.stats.scanned_pdfs += 1
            self.events.emit(
                "pdf_scanned",
                source=self.source_key,
                url=pdf_url,
                chars_per_page=extraction.chars_per_page,
            )
        if not extraction.ok:
            self.stats.pdf_extract_failed += 1
            self.log.warning(
                "PDF text extraction %s for %s (%s)",
                extraction.status,
                target.name,
                extraction.error,
            )
            self.events.emit(
                "pdf_extract_failed",
                source=self.source_key,
                url=pdf_url,
                status=extraction.status,
                error=extraction.error,
            )
        return document

    def attach_html_text(
        self, document: LegalDocument, text: str, name_hint: str | None = None
    ) -> LegalDocument:
        document.full_text = text
        document.mime_type = "text/html"
        document.extraction_status = (
            ExtractionStatus.OK.value if text.strip() else ExtractionStatus.EMPTY.value
        )
        self.stats.html_docs += 1
        if text.strip():
            self.files.save_text(
                text,
                self.source_key,
                name_hint or document.title or document.id,
                document.source_url,
                extract_year(document.date or ""),
            )
        return document

    def new_document(self, **kwargs) -> LegalDocument:
        kwargs.setdefault("source", self.source_key)
        kwargs.setdefault("source_website", self.config.base_url)
        return LegalDocument(**kwargs)

    # ------------------------------------------------------------------
    def _check_permission(self) -> None:
        import os

        if not self.config.requires_permission:
            return
        env_flag = os.getenv(f"PKLEGAL_PERMISSION_{self.source_key.upper()}", "")
        if not (self.settings.i_have_permission and env_flag.strip() == "1"):
            raise ScraperError(
                f"{self.config.name} is gated.\n{self.config.notes}\n"
                f"To enable: obtain written permission, then set "
                f"PKLEGAL_PERMISSION_{self.source_key.upper()}=1 and pass "
                f"--i-have-permission."
            )
        self.log.warning(
            "Permission flag set for %s -- proceeding. Keep the "
            "written authorisation on file for your FYP report.",
            self.config.name,
        )
