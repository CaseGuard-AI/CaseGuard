"""The corpus and ai schemas (#15): migrations, constraints, pgvector/FTS and ADR-0002 grants.

Runs as caseguard_ai against a bootstrapped database (infra/db/sql/bootstrap.sql), which CI
provides. Never point AI_TEST_DATABASE_URL at a database you care about: it migrates down.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.exc import DBAPIError

from caseguard_ai.config import _sqlalchemy_url

AI_URL = os.environ.get("AI_TEST_DATABASE_URL")
APP_URL = os.environ.get("APP_TEST_DATABASE_URL")
SERVICE_DIR = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.skipif(not AI_URL, reason="needs AI_TEST_DATABASE_URL (set in CI)")

TABLES = {
    "corpus.documents",
    "corpus.chunks",
    "corpus.corpus_meta",
    "ai.answer_traces",
    "ai.citations",
    "ai.verifications",
    "ai.case_chunks",
}


def _config() -> Config:
    cfg = Config(str(SERVICE_DIR / "alembic.ini"))
    cfg.attributes["url"] = _sqlalchemy_url(AI_URL or "")
    return cfg


def _tables(engine: Engine) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT table_schema || '.' || table_name FROM information_schema.tables "
                "WHERE table_schema IN ('corpus', 'ai') AND table_name <> 'alembic_version'"
            )
        )
        return {r[0] for r in rows}


@pytest.fixture(scope="module")
def engine() -> Iterator[Engine]:
    eng = create_engine(_sqlalchemy_url(AI_URL or ""))
    command.upgrade(_config(), "head")
    yield eng
    eng.dispose()


@pytest.fixture
def conn(engine: Engine) -> Iterator[Connection]:
    """A connection whose writes are rolled back after each test."""
    with engine.connect() as c:
        tx = c.begin()
        yield c
        tx.rollback()


def _document(conn: Connection, **overrides: object) -> uuid.UUID:
    values = {
        "collector_id": f"pakistan_code-{uuid.uuid4().hex[:24]}",
        "source_key": "pakistan_code",
        "kind": "statute",
        "title": "Pakistan Penal Code, 1860",
        "official_url": "https://pakistancode.gov.pk/english/UY2F-sg-jjj",
        "full_text": "302. Punishment of qatl-i-amd. Whoever commits qatl-i-amd shall be punished.",
        "content_hash": uuid.uuid4().hex,
        **overrides,
    }
    cols = ", ".join(values)
    params = ", ".join(f":{k}" for k in values)
    row = conn.execute(
        # Column names come from this function, never from input.
        text(f"INSERT INTO corpus.documents ({cols}) VALUES ({params}) RETURNING id"),  # noqa: S608
        values,
    )
    doc_id: uuid.UUID = row.scalar_one()
    return doc_id


# ── migrations ─────────────────────────────────────────────────────────────────────────────


def test_round_trip_down_and_up(engine: Engine) -> None:
    command.downgrade(_config(), "base")
    assert _tables(engine) == set()
    command.upgrade(_config(), "head")
    assert _tables(engine) == TABLES


def test_the_version_lives_in_ai_and_is_head(engine: Engine) -> None:
    head = ScriptDirectory.from_config(_config()).get_current_head()
    with engine.connect() as c:
        assert c.execute(text("SELECT version_num FROM ai.alembic_version")).scalar_one() == head


def test_tables_match_the_code(engine: Engine) -> None:
    # Fails if db/tables.py and the migrations drift apart.
    command.check(_config())


# ── constraints ────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("sql", "params"),
    [
        ("UPDATE corpus.documents SET kind = 'blog' WHERE id = :doc", {}),
        ("UPDATE corpus.documents SET source_tier = 3 WHERE id = :doc", {}),
        ("INSERT INTO corpus.corpus_meta (id) VALUES (2)", {}),
        ("UPDATE corpus.documents SET official_url = NULL WHERE id = :doc", {}),
    ],
)
def test_corpus_rejects_bad_rows(conn: Connection, sql: str, params: dict[str, object]) -> None:
    doc = _document(conn)
    with pytest.raises(DBAPIError):
        conn.execute(text(sql), {"doc": doc, **params})


def _citation(conn: Connection, source: uuid.UUID) -> uuid.UUID:
    request = uuid.uuid4()
    conn.execute(
        text("INSERT INTO ai.answer_traces (request_id, answerable) VALUES (:r, true)"),
        {"r": request},
    )
    citation_id: uuid.UUID = conn.execute(
        text(
            "INSERT INTO ai.citations (request_id, source_id, claim) "
            "VALUES (:r, :s, 'claim') RETURNING id"
        ),
        {"r": request, "s": source},
    ).scalar_one()
    return citation_id


@pytest.mark.parametrize(
    ("status", "flags", "ok"),
    [
        ("needs_review", ["headnote_only", "third_party_source"], True),
        ("verified", [], True),
        ("blue", [], False),
        ("verified", ["made_up_flag"], False),
    ],
)
def test_the_trust_store_allows_only_known_statuses_and_flags(
    conn: Connection, status: str, flags: list[str], ok: bool
) -> None:
    citation = _citation(conn, _document(conn))
    insert = text(
        "INSERT INTO ai.verifications (citation_id, status, flags, verifier_version) "
        "VALUES (:c, :s, :f, 'test')"
    )
    if ok:
        conn.execute(insert, {"c": citation, "s": status, "f": flags})
    else:
        with pytest.raises(DBAPIError):
            conn.execute(insert, {"c": citation, "s": status, "f": flags})


def test_one_verification_per_citation(conn: Connection) -> None:
    citation = _citation(conn, _document(conn))
    insert = text(
        "INSERT INTO ai.verifications (citation_id, status, verifier_version) "
        "VALUES (:c, 'unverified', 'test')"
    )
    conn.execute(insert, {"c": citation})
    with pytest.raises(DBAPIError):
        conn.execute(insert, {"c": citation})


def test_vectors_and_full_text_search_work(conn: Connection) -> None:
    doc = _document(conn)
    one_hot = "[" + ",".join("1" if i == 0 else "0" for i in range(1024)) + "]"
    conn.execute(
        text(
            "INSERT INTO corpus.chunks (document_id, ordinal, locator, text, token_count, "
            "chunker_version, embedding) VALUES (:d, 0, 's. 302', "
            "'Whoever commits qatl-i-amd shall be punished with death', 9, '1', CAST(:e AS vector))"
        ),
        {"d": doc, "e": one_hot},
    )
    distance, locator = conn.execute(
        text(
            "SELECT embedding <=> CAST(:e AS vector), locator FROM corpus.chunks "
            "WHERE tsv @@ websearch_to_tsquery('english', 'punished death')"
        ),
        {"e": one_hot},
    ).one()
    assert distance == pytest.approx(0.0)
    assert locator == "s. 302"


def test_corpus_can_be_truncated_while_citations_exist(conn: Connection) -> None:
    # A dump restore replaces corpus (#154). Citations in ai must not block it.
    _citation(conn, _document(conn))
    conn.execute(text("TRUNCATE corpus.chunks, corpus.documents"))
    assert conn.execute(text("SELECT count(*) FROM ai.citations")).scalar_one() == 1


# ── ADR-0002 grants ────────────────────────────────────────────────────────────────────────


@pytest.mark.skipif(not APP_URL, reason="needs APP_TEST_DATABASE_URL (set in CI)")
def test_apps_api_can_read_corpus_but_never_write_it_or_see_ai(engine: Engine) -> None:
    app = create_engine(_sqlalchemy_url(APP_URL or ""))
    try:
        with app.connect() as c:
            c.execute(text("SELECT count(*) FROM corpus.documents")).scalar_one()
        for sql in (
            "INSERT INTO corpus.corpus_meta (id) VALUES (1)",
            "SELECT count(*) FROM ai.verifications",
            "SELECT count(*) FROM ai.case_chunks",
        ):
            with app.connect() as c, pytest.raises(DBAPIError):
                c.execute(text(sql))
    finally:
        app.dispose()
