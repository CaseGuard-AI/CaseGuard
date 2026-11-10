"""Corpus dumps (#154): build, restore and the Hugging Face layout.

The database tests run against a migrated test database (``AI_TEST_DATABASE_URL``) with the hash
embedder. The hub tests use a fake ``HfApi``, so nothing touches the network.
"""

from __future__ import annotations

import json
import os
import tarfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, create_engine, text

from caseguard_ai.config import _sqlalchemy_url
from caseguard_ai.db.tables import chunks
from caseguard_ai.ingest.dump import (
    DUMP_FILE,
    MANIFEST_FILE,
    DumpRefused,
    Manifest,
    build_dump,
    copy_columns,
    restore_dump,
)
from caseguard_ai.ingest.embed import run
from caseguard_ai.ingest.embedder import HashEmbedder
from caseguard_ai.ingest.hub import LATEST, CorpusHub
from caseguard_ai.ingest.load import load
from caseguard_ai.retrieval.guard import EmbeddingMismatch, check_corpus
from tests.test_embed import PPC, OtherModel
from tests.test_load import judgment, record

AI_URL = os.environ.get("AI_TEST_DATABASE_URL")
SERVICE_DIR = Path(__file__).resolve().parents[1]

needs_db = pytest.mark.skipif(not AI_URL, reason="needs AI_TEST_DATABASE_URL (set in CI)")

_TRUNCATE = "TRUNCATE corpus.documents, corpus.corpus_meta CASCADE"


def yes(_current: Any, _incoming: Manifest) -> bool:
    return True


@pytest.fixture
def engine() -> Iterator[Engine]:
    url = _sqlalchemy_url(AI_URL or "")
    cfg = Config(str(SERVICE_DIR / "alembic.ini"))
    cfg.attributes["url"] = url
    command.upgrade(cfg, "head")
    eng = create_engine(url)
    with eng.begin() as conn:
        conn.execute(text(_TRUNCATE))
    load(eng, [record(full_text=PPC, content_hash="h-ppc"), judgment(1)], "p@2026-11-10")
    run(eng, HashEmbedder())
    yield eng
    with eng.begin() as conn:
        conn.execute(text(_TRUNCATE))
    eng.dispose()


def _rows(engine: Engine) -> dict[str, list[tuple[Any, ...]]]:
    """Every stored corpus row (the embedding as text, so vectors compare exactly)."""
    with engine.connect() as conn:
        return {
            "meta": list(conn.execute(text("SELECT * FROM corpus.corpus_meta")).all()),
            "documents": list(
                conn.execute(text("SELECT * FROM corpus.documents ORDER BY id")).all()
            ),
            "chunks": list(
                conn.execute(
                    text(
                        "SELECT id, document_id, ordinal, locator, text, embedding::text, tsv::text"
                        " FROM corpus.chunks ORDER BY id"
                    )
                ).all()
            ),
        }


def _empty(engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(text(_TRUNCATE))


@needs_db
def test_round_trip_restores_identical_rows(engine: Engine, tmp_path: Path) -> None:
    before = _rows(engine)
    manifest = build_dump(engine, tmp_path)
    assert manifest.counts == {
        "corpus_meta": 1,
        "documents": 2,
        "chunks": len(before["chunks"]),
    }
    assert manifest.data["corpus_meta"]["embedding_model"] == HashEmbedder.model_id
    assert manifest.data["corpus_meta"]["input_snapshots"] == ["p@2026-11-10"]
    assert manifest.data["alembic_revision"]
    assert "tsv" not in manifest.data["tables"]["chunks"]

    _empty(engine)
    report = restore_dump(engine, tmp_path, confirm=yes)
    assert report is not None and report.counts == manifest.counts
    after = _rows(engine)
    assert after == before  # including the regenerated tsv
    with engine.connect() as conn:
        check_corpus(conn, HashEmbedder())  # retrieval accepts it


@needs_db
def test_restore_replaces_an_existing_corpus_and_reports_it(engine: Engine, tmp_path: Path) -> None:
    build_dump(engine, tmp_path)
    before = _rows(engine)
    load(engine, [judgment(7)], "other@1")  # the local corpus has moved on
    seen: list[Any] = []

    def confirm(current: Any, incoming: Manifest) -> bool:
        seen.append(current)
        return True

    report = restore_dump(engine, tmp_path, confirm=confirm)
    assert report is not None
    assert seen[0]["counts"]["documents"] == 3
    assert _rows(engine) == before


@needs_db
def test_declined_confirm_changes_nothing(engine: Engine, tmp_path: Path) -> None:
    build_dump(engine, tmp_path)
    _empty(engine)
    assert restore_dump(engine, tmp_path, confirm=lambda *_: False) is None
    assert _rows(engine)["documents"] == []


@needs_db
def test_restore_into_an_empty_database(engine: Engine, tmp_path: Path) -> None:
    build_dump(engine, tmp_path)
    _empty(engine)
    seen: list[Any] = []
    restore_dump(engine, tmp_path, confirm=lambda current, _m: seen.append(current) or True)
    assert seen == [None]


@needs_db
def test_revision_mismatch_is_refused_and_leaves_the_corpus(engine: Engine, tmp_path: Path) -> None:
    build_dump(engine, tmp_path)
    data = json.loads((tmp_path / MANIFEST_FILE).read_text())
    data["alembic_revision"] = "9999"
    (tmp_path / MANIFEST_FILE).write_text(json.dumps(data))
    before = _rows(engine)
    with pytest.raises(DumpRefused, match="revision 9999"):
        restore_dump(engine, tmp_path, confirm=yes)
    assert _rows(engine) == before


@needs_db
def test_tampered_dump_is_refused(engine: Engine, tmp_path: Path) -> None:
    build_dump(engine, tmp_path)
    with (tmp_path / DUMP_FILE).open("ab") as fh:
        fh.write(b"x")
    with pytest.raises(DumpRefused, match="checksum"):
        restore_dump(engine, tmp_path, confirm=yes)


@needs_db
def test_a_restored_corpus_refuses_another_query_model(engine: Engine, tmp_path: Path) -> None:
    build_dump(engine, tmp_path)
    _empty(engine)
    restore_dump(engine, tmp_path, confirm=yes)
    with engine.connect() as conn, pytest.raises(EmbeddingMismatch):
        check_corpus(conn, OtherModel())


@needs_db
def test_an_unfinished_embed_is_not_dumped(engine: Engine, tmp_path: Path) -> None:
    with engine.begin() as conn:
        conn.execute(text("UPDATE corpus.chunks SET embedding = NULL WHERE ordinal = 0"))
    with pytest.raises(DumpRefused, match="no embedding"):
        build_dump(engine, tmp_path)
    with engine.begin() as conn:
        conn.execute(text("UPDATE corpus.corpus_meta SET built_at = NULL"))
    with pytest.raises(DumpRefused, match="didn't finish"):
        build_dump(engine, tmp_path)
    _empty(engine)
    with pytest.raises(DumpRefused, match="empty"):
        build_dump(engine, tmp_path)


@needs_db
def test_the_dump_holds_only_the_corpus_tables(engine: Engine, tmp_path: Path) -> None:
    build_dump(engine, tmp_path)
    with tarfile.open(tmp_path / DUMP_FILE) as tar:
        assert sorted(tar.getnames()) == [
            "chunks.copy.gz",
            "corpus_meta.copy.gz",
            "documents.copy.gz",
        ]
    assert sorted(p.name for p in tmp_path.iterdir()) == [DUMP_FILE, MANIFEST_FILE]


def test_generated_columns_are_never_copied() -> None:
    assert "tsv" not in copy_columns(chunks)
    assert "embedding" in copy_columns(chunks)


def test_a_hand_made_pg_dump_is_refused_with_a_reason(tmp_path: Path) -> None:
    (tmp_path / MANIFEST_FILE).write_text("{}")
    with pytest.raises(DumpRefused, match="pg_dump"):
        Manifest.read(tmp_path / MANIFEST_FILE)


# ── the Hugging Face layout, with a fake HfApi ────────────────────────────────────────────────


@dataclass
class FakeHf:
    """An in-memory dataset repo: files per commit, tags pointing at commits."""

    commits: list[dict[str, bytes]] = field(default_factory=lambda: [{}])
    tags: dict[str, int] = field(default_factory=dict)
    root: Path = Path(".")

    def _at(self, revision: str | None) -> dict[str, bytes]:
        if revision in (None, "main"):
            return self.commits[-1]
        if revision in self.tags:
            return self.commits[self.tags[revision]]
        raise KeyError(revision)

    def list_repo_refs(self, repo_id: str, **_: Any) -> Any:
        return SimpleNamespace(
            tags=[SimpleNamespace(name=t) for t in self.tags],
            branches=[SimpleNamespace(name="main", target_commit=str(len(self.commits) - 1))],
        )

    def file_exists(self, repo_id: str, filename: str, **_: Any) -> bool:
        return filename in self.commits[-1]

    def create_commit(self, repo_id: str, *, operations: Any, parent_commit: Any, **_: Any) -> Any:
        assert parent_commit == str(len(self.commits) - 1)
        files = dict(self.commits[-1])
        for op in operations:
            assert op.path_in_repo not in files or op.path_in_repo == LATEST, "overwrote a dump"
            src = op.path_or_fileobj
            files[op.path_in_repo] = src if isinstance(src, bytes) else Path(src).read_bytes()
        self.commits.append(files)
        return SimpleNamespace(oid=len(self.commits) - 1)

    def create_tag(self, repo_id: str, *, tag: str, revision: int, **_: Any) -> None:
        assert tag not in self.tags
        self.tags[tag] = revision

    def hf_hub_download(self, repo_id: str, filename: str, *, revision: str, **_: Any) -> str:
        out = self.root / revision.replace("/", "_") / filename
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(self._at(revision)[filename])
        return str(out)


def _fake_dump(folder: Path, body: bytes = b"dump") -> Path:
    """A dump folder with a valid manifest checksum (verify_dump runs before publishing)."""
    import hashlib

    folder.mkdir(parents=True)
    (folder / DUMP_FILE).write_bytes(body)
    Manifest(
        {
            "format": "caseguard-corpus-dump",
            "format_version": 1,
            "files": {DUMP_FILE: {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}},
        }
    ).write(folder / MANIFEST_FILE)
    return folder


def test_publish_never_overwrites_and_moves_latest(tmp_path: Path) -> None:
    fake = FakeHf(root=tmp_path / "cache")
    hub = CorpusHub(fake, "caseguard/corpus")
    first = hub.publish(_fake_dump(tmp_path / "a", b"one"), day="2026-11-10")
    second = hub.publish(_fake_dump(tmp_path / "b", b"two"), day="2026-11-10")
    third = hub.publish(_fake_dump(tmp_path / "c", b"three"), day="2026-11-10")
    assert (first, second, third) == ("2026-11-10", "2026-11-10-2", "2026-11-10-3")
    files = fake.commits[-1]
    assert files[LATEST] == b"2026-11-10-3\n"
    assert files["dumps/2026-11-10/corpus.dump"] == b"one"
    assert set(fake.tags) == {"dump/2026-11-10", "dump/2026-11-10-2", "dump/2026-11-10-3"}


def test_freeze_tags_once_and_resolves(tmp_path: Path) -> None:
    fake = FakeHf(root=tmp_path / "cache")
    hub = CorpusHub(fake, "caseguard/corpus")
    hub.publish(_fake_dump(tmp_path / "a", b"frozen"), day="2026-11-10", freeze="eval-frozen-1")
    hub.publish(_fake_dump(tmp_path / "b", b"newer"), day="2026-11-11")
    with pytest.raises(DumpRefused, match="already exists"):
        hub.publish(_fake_dump(tmp_path / "c"), day="2026-11-12", freeze="eval-frozen-1")
    with pytest.raises(DumpRefused, match="eval-frozen-<n>"):
        hub.publish(_fake_dump(tmp_path / "d"), day="2026-11-12", freeze="final")

    assert hub.resolve("latest") == ("2026-11-11", "dump/2026-11-11")
    assert hub.resolve("2026-11-10") == ("2026-11-10", "dump/2026-11-10")
    assert hub.resolve("eval-frozen-1") == ("2026-11-10", "dump/2026-11-10")
    with pytest.raises(DumpRefused):
        hub.resolve("yesterday")

    folder, path = hub.download("eval-frozen-1")
    assert folder == "2026-11-10"
    assert (path / DUMP_FILE).read_bytes() == b"frozen"
    assert (path / MANIFEST_FILE).is_file()


def test_a_dump_that_fails_its_checksum_is_never_published(tmp_path: Path) -> None:
    fake = FakeHf(root=tmp_path / "cache")
    folder = _fake_dump(tmp_path / "a", b"good")
    (folder / DUMP_FILE).write_bytes(b"bad!")
    with pytest.raises(DumpRefused, match="checksum"):
        CorpusHub(fake, "caseguard/corpus").publish(folder, day="2026-11-10")
    assert fake.commits == [{}]
