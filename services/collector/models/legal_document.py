"""Normalized schema every scraper emits.

Design rule: a field is populated only when the source actually provided it.
Never synthesise a value. `None` / empty list means "the source did not say".
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any


class DocumentType(str, Enum):
    CONSTITUTION = "constitution"
    ACT = "act"
    ORDINANCE = "ordinance"
    RULES = "rules"
    REGULATION = "regulation"
    CODE = "code"
    STATUTE = "statute"
    AMENDMENT = "amendment"
    BILL = "bill"
    SUBORDINATE_LEGISLATION = "subordinate_legislation"
    JUDGMENT = "judgment"
    ORDER = "order"
    CAUSE_LIST = "cause_list"
    CASE_RECORD = "case_record"
    UNKNOWN = "unknown"


class ExtractionStatus(str, Enum):
    OK = "ok"
    EMPTY = "empty"  # parsed fine, produced no text
    SCANNED_NO_OCR = "scanned_no_ocr"
    FAILED = "failed"
    NOT_ATTEMPTED = "not_attempted"


class FileStatus(str, Enum):
    """What happened to a record's linked source file. Stored as raw["file_status"] (#147)."""

    OK = "ok"  # a real PDF was saved
    NOT_DOWNLOADED = "not_downloaded"  # --no-pdfs
    DOWNLOAD_FAILED = "download_failed"  # the request failed
    EMPTY = "empty"  # the server sent an empty body
    NOT_PDF = "not_pdf"  # the server sent something that isn't a PDF
    MISSING_LINK = "missing_link"  # the listing linked no file


@dataclass
class Party:
    name: str
    role: str | None = None  # petitioner / respondent / appellant / accused ...


@dataclass
class LegalDocument:
    # --- provenance (mandatory) -------------------------------------------
    source: str  # short source key, e.g. "pakistan_code"
    source_website: str  # e.g. "https://pakistancode.gov.pk"
    source_url: str  # page the record was discovered/parsed on
    document_type: str = DocumentType.UNKNOWN.value
    jurisdiction: str = "Pakistan"

    # --- identity ---------------------------------------------------------
    id: str = ""
    title: str | None = None
    document_url: str | None = None  # canonical landing page for the doc
    document_file_url: str | None = None  # direct PDF/DOC URL if any
    document_number: str | None = None  # "XVIII of 1999"
    case_number: str | None = None
    citation: str | None = None

    # --- court / legislative context --------------------------------------
    court: str | None = None
    bench: str | None = None
    province: str | None = None
    category: str | None = None  # source's own taxonomy label
    matter_type: str | None = None
    case_status: str | None = None

    # --- dates (ISO-8601 strings, or None) --------------------------------
    date: str | None = None  # primary date for the doc
    publication_date: str | None = None
    promulgation_date: str | None = None
    judgment_date: str | None = None
    institution_date: str | None = None
    disposal_date: str | None = None
    hearing_dates: list[str] = field(default_factory=list)

    # --- people -----------------------------------------------------------
    judges: list[str] = field(default_factory=list)
    advocates: list[str] = field(default_factory=list)
    parties: list[dict[str, Any]] = field(default_factory=list)

    # --- relations --------------------------------------------------------
    connected_cases: list[str] = field(default_factory=list)
    cited_laws: list[str] = field(default_factory=list)
    cited_cases: list[str] = field(default_factory=list)

    # --- content ----------------------------------------------------------
    full_text: str | None = None
    summary: str | None = None  # head-note / tag-line if supplied
    language: str | None = None
    file_path: str | None = None  # local path of the saved original
    mime_type: str | None = None

    # --- ingestion bookkeeping -------------------------------------------
    content_hash: str | None = None
    scraped_at: str = ""
    extraction_status: str = ExtractionStatus.NOT_ATTEMPTED.value
    extraction_error: str | None = None
    page_count: int | None = None
    raw: dict[str, Any] = field(default_factory=dict)  # untouched source fields
    notes: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.scraped_at:
            self.scraped_at = datetime.now(UTC).isoformat()
        if not self.id:
            self.id = self.make_id()

    # ------------------------------------------------------------------
    def make_id(self) -> str:
        """Stable id derived from source + canonical URL.

        Same document re-scraped later keeps the same id, so downstream
        stores can upsert rather than duplicate.
        """
        basis = f"{self.source}|{self.document_url or self.source_url}"
        digest = hashlib.sha256(basis.encode("utf-8")).hexdigest()[:24]
        return f"{self.source}-{digest}"

    def compute_content_hash(self) -> str | None:
        """SHA-256 over the text, used for change detection and dedup."""
        if not self.full_text:
            return None
        normalised = " ".join(self.full_text.split()).lower()
        self.content_hash = hashlib.sha256(normalised.encode("utf-8")).hexdigest()
        return self.content_hash

    def add_party(self, name: str | None, role: str | None = None) -> None:
        if name and name.strip():
            self.parties.append({"name": name.strip(), "role": role})

    def to_dict(self, drop_empty: bool = True) -> dict[str, Any]:
        data = asdict(self)
        if not drop_empty:
            return data
        return {
            k: v
            for k, v in data.items()
            if v not in (None, "", [], {}) or k in ("source", "source_url", "id")
        }

    # --- validation -------------------------------------------------------
    def validate(self) -> list[str]:
        """Return a list of problems. Empty list == valid."""
        problems: list[str] = []
        if not self.source:
            problems.append("missing source")
        if not self.source_url:
            problems.append("missing source_url")
        if not self.title and not self.case_number:
            problems.append("no title and no case_number")
        if not self.full_text or len(self.full_text.strip()) < 40:
            problems.append("full_text missing or too short")
        if self.date and not _looks_iso(self.date):
            problems.append(f"date not normalised: {self.date!r}")
        return problems

    @property
    def is_valid(self) -> bool:
        return not self.validate()


def _looks_iso(value: str) -> bool:
    try:
        datetime.fromisoformat(value)
        return True
    except (TypeError, ValueError):
        return False


def new_run_id() -> str:
    return uuid.uuid4().hex[:12]
