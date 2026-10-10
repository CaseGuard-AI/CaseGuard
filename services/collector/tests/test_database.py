"""Database insertion. Uses SQLite so no Postgres server is needed; the same
code path runs against PKLEGAL_DATABASE_URL in production."""

import pytest

pytest.importorskip("sqlalchemy")

from storage.database import create_schema, upsert_documents   # noqa: E402


def doc(**overrides):
    base = {
        "id": "pakistan_code-abc123",
        "source": "pakistan_code",
        "source_website": "https://pakistancode.gov.pk",
        "source_url": "https://pakistancode.gov.pk/english/x-sg-jjj",
        "document_url": "https://pakistancode.gov.pk/english/x-sg-jjj",
        "document_type": "act",
        "title": "National Archives Act, 1993",
        "document_number": "VI of 1993",
        "date": "1993-12-01",
        "full_text": "An Act to provide for the preservation of archival material.",
        "content_hash": "deadbeef",
        "scraped_at": "2026-09-16T10:00:00+00:00",
        "judges": [],
        "parties": [],
        "raw": {"category": "General Laws"},
    }
    base.update(overrides)
    return base


@pytest.fixture
def url(tmp_path):
    return f"sqlite:///{tmp_path/'test.db'}"


def test_schema_creation(url):
    create_schema(url)


def test_insert_then_update_is_idempotent(url):
    first = upsert_documents(url, [doc()])
    assert first == {"inserted": 1, "updated": 0}
    second = upsert_documents(url, [doc(title="Amended title")])
    assert second == {"inserted": 0, "updated": 1}

    from sqlalchemy.orm import Session
    from storage.database import LegalDocumentRow, make_engine
    with Session(make_engine(url)) as session:
        row = session.get(LegalDocumentRow, "pakistan_code-abc123")
        assert row.title == "Amended title"
        assert row.date.isoformat() == "1993-12-01"
        assert row.raw["category"] == "General Laws"


def test_judges_are_deduplicated_across_documents(url):
    upsert_documents(url, [
        doc(id="a", source_url="https://x/a", document_url="https://x/a",
            judges=["Muhammad Ali Mazhar", "Agha Faisal"]),
        doc(id="b", source_url="https://x/b", document_url="https://x/b",
            judges=["Muhammad Ali Mazhar"]),
    ])
    from sqlalchemy import func, select
    from sqlalchemy.orm import Session
    from storage.database import Judge, make_engine
    with Session(make_engine(url)) as session:
        assert session.scalar(select(func.count()).select_from(Judge)) == 2


def test_bad_date_does_not_crash_the_load(url):
    upsert_documents(url, [doc(date="December .")])
    from sqlalchemy.orm import Session
    from storage.database import LegalDocumentRow, make_engine
    with Session(make_engine(url)) as session:
        assert session.get(LegalDocumentRow, "pakistan_code-abc123").date is None


def test_rows_without_an_id_are_skipped(url):
    assert upsert_documents(url, [{"source": "x"}]) == {"inserted": 0, "updated": 0}
