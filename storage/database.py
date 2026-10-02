"""Optional PostgreSQL layer.

Not required for the MVP -- the pipeline is happy writing JSONL. This module
exists so that when the corpus is stable you can run

    python main.py --load-db --source pakistan_code

and get the same records into Postgres without touching any scraper.

Deliberately modest: one main table plus the few relations the RAG layer will
actually query on. JSONB columns absorb source-specific fields so adding a new
court never needs a migration.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

try:
    from sqlalchemy import (
        Column, Date, DateTime, ForeignKey, Integer, String, Table, Text,
        UniqueConstraint, create_engine, select,
    )
    from sqlalchemy.dialects.postgresql import JSONB
    from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship
    from sqlalchemy.types import JSON
    SQLALCHEMY_AVAILABLE = True
except ImportError:                                     # pragma: no cover
    SQLALCHEMY_AVAILABLE = False


if SQLALCHEMY_AVAILABLE:
    # JSONB on Postgres, plain JSON on SQLite so tests run without a server.
    JSONType = JSON().with_variant(JSONB(), "postgresql")

    class Base(DeclarativeBase):
        pass

    document_judges = Table(
        "document_judges", Base.metadata,
        Column("document_id", String(80), ForeignKey("legal_documents.id",
                                                     ondelete="CASCADE"), primary_key=True),
        Column("judge_id", Integer, ForeignKey("judges.id", ondelete="CASCADE"),
               primary_key=True),
    )

    class Source(Base):
        __tablename__ = "sources"
        id: Mapped[int] = mapped_column(Integer, primary_key=True)
        key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
        name: Mapped[str] = mapped_column(String(255), nullable=False)
        base_url: Mapped[str] = mapped_column(String(512), nullable=False)
        access_notes: Mapped[str | None] = mapped_column(Text)

    class Court(Base):
        __tablename__ = "courts"
        id: Mapped[int] = mapped_column(Integer, primary_key=True)
        name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
        province: Mapped[str | None] = mapped_column(String(64))
        level: Mapped[str | None] = mapped_column(String(32))   # apex/high/federal/district

    class Judge(Base):
        __tablename__ = "judges"
        id: Mapped[int] = mapped_column(Integer, primary_key=True)
        name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
        documents: Mapped[list["LegalDocumentRow"]] = relationship(
            secondary=document_judges, back_populates="judge_rows"
        )

    class LegalDocumentRow(Base):
        """One row per ingested document: statute, judgment or order."""
        __tablename__ = "legal_documents"
        __table_args__ = (UniqueConstraint("source", "document_url",
                                           name="uq_source_document_url"),)

        id: Mapped[str] = mapped_column(String(80), primary_key=True)
        source: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
        source_website: Mapped[str | None] = mapped_column(String(255))
        source_url: Mapped[str] = mapped_column(Text, nullable=False)
        document_url: Mapped[str | None] = mapped_column(Text)
        document_file_url: Mapped[str | None] = mapped_column(Text)

        document_type: Mapped[str] = mapped_column(String(48), index=True)
        title: Mapped[str | None] = mapped_column(Text)
        document_number: Mapped[str | None] = mapped_column(String(128))
        case_number: Mapped[str | None] = mapped_column(String(128), index=True)
        citation: Mapped[str | None] = mapped_column(String(255), index=True)

        court: Mapped[str | None] = mapped_column(String(255), index=True)
        bench: Mapped[str | None] = mapped_column(Text)
        jurisdiction: Mapped[str | None] = mapped_column(String(64))
        province: Mapped[str | None] = mapped_column(String(64))
        category: Mapped[str | None] = mapped_column(String(128))
        matter_type: Mapped[str | None] = mapped_column(String(128))
        case_status: Mapped[str | None] = mapped_column(String(128))

        date: Mapped[Any | None] = mapped_column(Date, index=True)
        publication_date: Mapped[Any | None] = mapped_column(Date)
        judgment_date: Mapped[Any | None] = mapped_column(Date)

        full_text: Mapped[str | None] = mapped_column(Text)
        summary: Mapped[str | None] = mapped_column(Text)
        language: Mapped[str | None] = mapped_column(String(16))
        file_path: Mapped[str | None] = mapped_column(Text)
        page_count: Mapped[int | None] = mapped_column(Integer)

        content_hash: Mapped[str | None] = mapped_column(String(64), index=True)
        extraction_status: Mapped[str | None] = mapped_column(String(32))
        extraction_error: Mapped[str | None] = mapped_column(Text)
        scraped_at: Mapped[Any | None] = mapped_column(DateTime(timezone=True))

        # everything source-specific, kept verbatim for provenance
        parties: Mapped[Any | None] = mapped_column(JSONType)
        advocates: Mapped[Any | None] = mapped_column(JSONType)
        connected_cases: Mapped[Any | None] = mapped_column(JSONType)
        cited_laws: Mapped[Any | None] = mapped_column(JSONType)
        cited_cases: Mapped[Any | None] = mapped_column(JSONType)
        hearing_dates: Mapped[Any | None] = mapped_column(JSONType)
        raw: Mapped[Any | None] = mapped_column(JSONType)
        notes: Mapped[Any | None] = mapped_column(JSONType)

        judge_rows: Mapped[list[Judge]] = relationship(
            secondary=document_judges, back_populates="documents"
        )


# ----------------------------------------------------------------------
def _parse_date(value: Any):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)).date()
    except (TypeError, ValueError):
        return None


def _parse_dt(value: Any):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def make_engine(database_url: str, echo: bool = False):
    if not SQLALCHEMY_AVAILABLE:
        raise RuntimeError("SQLAlchemy is not installed; pip install -r requirements.txt")
    return create_engine(database_url, echo=echo, future=True)


def create_schema(database_url: str) -> None:
    engine = make_engine(database_url)
    Base.metadata.create_all(engine)


def upsert_documents(database_url: str, documents: Iterable[dict]) -> dict[str, int]:
    """Idempotent load: re-running never duplicates rows (id is stable)."""
    engine = make_engine(database_url)
    Base.metadata.create_all(engine)
    inserted = updated = 0

    with Session(engine) as session:
        judge_cache: dict[str, Judge] = {}
        for payload in documents:
            doc_id = payload.get("id")
            if not doc_id:
                continue
            row = session.get(LegalDocumentRow, doc_id)
            if row is None:
                row = LegalDocumentRow(id=doc_id)
                session.add(row)
                inserted += 1
            else:
                updated += 1

            for field in ("source", "source_website", "source_url", "document_url",
                          "document_file_url", "document_type", "title",
                          "document_number", "case_number", "citation", "court",
                          "bench", "jurisdiction", "province", "category",
                          "matter_type", "case_status", "full_text", "summary",
                          "language", "file_path", "page_count", "content_hash",
                          "extraction_status", "extraction_error"):
                if field in payload:
                    setattr(row, field, payload[field])

            row.date = _parse_date(payload.get("date"))
            row.publication_date = _parse_date(payload.get("publication_date"))
            row.judgment_date = _parse_date(payload.get("judgment_date"))
            row.scraped_at = _parse_dt(payload.get("scraped_at"))

            for field in ("parties", "advocates", "connected_cases", "cited_laws",
                          "cited_cases", "hearing_dates", "raw", "notes"):
                setattr(row, field, payload.get(field))

            row.judge_rows = []
            for name in payload.get("judges") or []:
                judge = judge_cache.get(name)
                if judge is None:
                    judge = session.scalar(select(Judge).where(Judge.name == name))
                    if judge is None:
                        judge = Judge(name=name)
                        session.add(judge)
                    judge_cache[name] = judge
                row.judge_rows.append(judge)

        session.commit()
    return {"inserted": inserted, "updated": updated}


def load_jsonl(database_url: str, jsonl_path: str | Path) -> dict[str, int]:
    from storage.jsonl_storage import JsonlStorage
    return upsert_documents(database_url, JsonlStorage.read(jsonl_path))
