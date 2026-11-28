"""The chunk-and-embed job (#18), against a migrated test database, with the hash embedder."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, create_engine, text

from caseguard_ai.config import _sqlalchemy_url
from caseguard_ai.ingest.chunker import CHUNKER_VERSION
from caseguard_ai.ingest.embed import ModelMismatch, run
from caseguard_ai.ingest.embedder import HashEmbedder
from caseguard_ai.ingest.load import load
from tests.test_load import judgment, record

AI_URL = os.environ.get("AI_TEST_DATABASE_URL")
SERVICE_DIR = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.skipif(not AI_URL, reason="needs AI_TEST_DATABASE_URL (set in CI)")

PPC = (
    "WHEREAS it is expedient; It is hereby enacted as follows:__\n"
    "301. Culpable homicide by causing death of person other than person intended.\n"
    "302. Punishment of qatl-i-amd. Whoever commits qatl-i-amd shall be punished with death.\n"
    "303. Qatl committed under the influence of extreme provocation. Whoever commits qatl.\n"
)


class OtherModel(HashEmbedder):
    model_id = "someone/else"


@pytest.fixture
def engine() -> Iterator[Engine]:
    url = _sqlalchemy_url(AI_URL or "")
    cfg = Config(str(SERVICE_DIR / "alembic.ini"))
    cfg.attributes["url"] = url
    command.upgrade(cfg, "head")
    eng = create_engine(url)
    with eng.begin() as conn:
        conn.execute(text("TRUNCATE corpus.documents, corpus.corpus_meta CASCADE"))
    load(eng, [record(full_text=PPC, content_hash="h-ppc"), judgment(1)], "p@1")
    load(
        eng,
        [
            judgment(
                2,
                full_text="A (Appellant) VS The State. Bail granted. Bench: X.",
                raw={"headnote_only": True},
            )
        ],
        "shc-meta@1",
    )
    yield eng
    with eng.begin() as conn:
        conn.execute(text("TRUNCATE corpus.documents, corpus.corpus_meta CASCADE"))
    eng.dispose()


def _chunks(engine: Engine) -> list[dict[str, Any]]:
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT c.id, d.collector_id, c.locator, c.headnote_only, c.chunker_version,"
                " c.embedding IS NOT NULL AS embedded, length(c.tsv::text) > 0 AS indexed"
                " FROM corpus.chunks c JOIN corpus.documents d ON d.id = c.document_id"
                " ORDER BY d.collector_id, c.ordinal"
            )
        )
        return [dict(r._mapping) for r in rows]


def _meta(engine: Engine) -> dict[str, Any]:
    with engine.connect() as conn:
        return dict(conn.execute(text("SELECT * FROM corpus.corpus_meta")).mappings().one())


def test_every_document_is_chunked_embedded_and_indexed(engine: Engine) -> None:
    report = run(engine, HashEmbedder())
    chunks = _chunks(engine)
    assert report.documents_chunked == 3
    assert report.chunks_written == report.chunks_embedded == len(chunks)
    assert all(c["embedded"] and c["indexed"] for c in chunks)
    statute = [c["locator"] for c in chunks if c["collector_id"] == record()["id"]]
    assert statute == ["s. 301", "s. 302", "s. 303"]
    headnote = [c for c in chunks if c["collector_id"] == judgment(2)["id"]]
    assert [(c["locator"], c["headnote_only"]) for c in headnote] == [("head-note", True)]


def test_the_corpus_records_what_it_was_built_with(engine: Engine) -> None:
    run(engine, HashEmbedder())
    meta = _meta(engine)
    assert (meta["embedding_model"], meta["embedding_revision"]) == ("caseguard/hash-bow", "1")
    assert (meta["embedding_dims"], meta["embedding_normalized"]) == (1024, True)
    assert meta["chunker_version"] == CHUNKER_VERSION
    assert meta["chunker_settings"]["target_tokens"] == 500
    assert meta["input_snapshots"] == ["p@1", "shc-meta@1"]
    assert meta["built_at"] is not None


def test_a_re_run_changes_nothing(engine: Engine) -> None:
    run(engine, HashEmbedder())
    before = _chunks(engine)
    again = run(engine, HashEmbedder())
    assert (again.documents_chunked, again.chunks_embedded) == (0, 0)
    assert _chunks(engine) == before


def test_only_a_changed_document_is_re_chunked(engine: Engine) -> None:
    run(engine, HashEmbedder())
    untouched = [c["id"] for c in _chunks(engine) if c["collector_id"] != judgment(1)["id"]]
    load(engine, [judgment(1, full_text="Judgment 1, corrected. " * 5, content_hash="h-1b")], "p@2")
    report = run(engine, HashEmbedder())
    assert report.documents_chunked == 1
    after = _chunks(engine)
    assert [c["id"] for c in after if c["collector_id"] != judgment(1)["id"]] == untouched
    assert all(c["embedded"] for c in after)


def test_a_stopped_run_is_finished_by_the_next(engine: Engine) -> None:
    run(engine, HashEmbedder())
    with engine.begin() as conn:
        conn.execute(text("UPDATE corpus.chunks SET embedding = NULL WHERE locator = 's. 302'"))
    report = run(engine, HashEmbedder())
    assert (report.documents_chunked, report.chunks_embedded) == (0, 1)
    assert all(c["embedded"] for c in _chunks(engine))


def test_a_new_chunker_version_re_chunks_everything(engine: Engine) -> None:
    run(engine, HashEmbedder())
    with engine.begin() as conn:
        conn.execute(text("UPDATE corpus.chunks SET chunker_version = '0'"))
    assert run(engine, HashEmbedder()).documents_chunked == 3
    assert {c["chunker_version"] for c in _chunks(engine)} == {CHUNKER_VERSION}


def _vectors(engine: Engine) -> dict[str, str]:
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT text, embedding::text AS v FROM corpus.chunks"))
        return {r.text: r.v for r in rows}


def test_re_chunking_keeps_the_vectors_of_unchanged_chunks(engine: Engine) -> None:
    # #263: a chunker change re-chunks all 56k documents; only chunks whose text changed may
    # go back to the model, or a fix to three statutes re-embeds the whole corpus.
    run(engine, HashEmbedder())
    before = _vectors(engine)
    with engine.begin() as conn:
        conn.execute(text("UPDATE corpus.chunks SET chunker_version = '0'"))
        # One chunk as an older chunker cut it: its text differs from what this one produces.
        conn.execute(text("UPDATE corpus.chunks SET text = 'stale' WHERE locator = 's. 302'"))
    report = run(engine, HashEmbedder())
    assert report.documents_chunked == 3
    assert report.chunks_embedded == 1  # only s. 302, whose text came out different
    assert report.embeddings_kept == len(before) - 1
    assert _vectors(engine) == before


def test_another_model_is_refused_unless_rebuilding(engine: Engine) -> None:
    run(engine, HashEmbedder())
    before = _chunks(engine)
    with pytest.raises(ModelMismatch, match="--rebuild"):
        run(engine, OtherModel())
    assert _chunks(engine) == before  # nothing was touched
    assert _meta(engine)["embedding_model"] == "caseguard/hash-bow"
    report = run(engine, OtherModel(), rebuild=True)
    assert report.chunks_embedded == len(before)
    assert _meta(engine)["embedding_model"] == "someone/else"


def test_the_nearest_chunk_by_cosine_is_the_matching_section(engine: Engine) -> None:
    run(engine, HashEmbedder())
    (query,) = HashEmbedder().embed(["punishment of qatl-i-amd"])
    with engine.connect() as conn:
        locator = conn.execute(
            text(
                "SELECT locator FROM corpus.chunks ORDER BY embedding <=> CAST(:q AS vector) LIMIT 1"
            ),
            {"q": str(query)},
        ).scalar_one()
        sparse = (
            conn.execute(
                text(
                    "SELECT locator FROM corpus.chunks"
                    " WHERE tsv @@ websearch_to_tsquery('english', 'extreme provocation')"
                )
            )
            .scalars()
            .all()
        )
    assert locator == "s. 302"
    assert sparse == ["s. 303"]
