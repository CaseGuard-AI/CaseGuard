"""Build and restore corpus dumps (#154, data-storage spec §4).

    uv run python -m caseguard_ai.ingest.dump [--out DIR] [--no-upload] [--freeze eval-frozen-N] [--yes]
    pnpm data:dump

A corpus dump is the loaded, embedded ``corpus`` schema, so nobody else has to re-embed for hours.
It is two files:

- ``corpus.dump``: an uncompressed tar with one gzip-compressed binary ``COPY`` per table
  (``corpus_meta``, ``documents``, ``chunks``). The generated full-text column ``chunks.tsv`` is
  left out; Postgres rebuilds it on restore.
- ``manifest.json``: the Alembic revision, the ``corpus_meta`` row (embedding model and revision,
  dims, chunker settings, FTS config, input snapshots), the copied columns, row counts, and the
  SHA-256 of ``corpus.dump``.

It is **data-only, and only ``corpus``**. ``app`` and ``ai`` are never read, apart from the Alembic
revision in ``ai.alembic_version``. It uses ``COPY`` through psycopg rather than ``pg_dump``, so it
needs no client binary matching the server, and it runs as ``caseguard_ai``, which keeps the
ADR-0002 roles intact.

A restore **replaces** the local corpus, never merges: it checks the checksum, refuses another
Alembic revision or a different table layout, shows what is loaded now, asks, and then truncates
and copies in one transaction. ``pnpm data:pull --dump`` (``ingest/pull.py``) drives it.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import subprocess  # noqa: S404  # fixed git commands for provenance only
import sys
import tarfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import Connection, Engine, Table, create_engine, func, select, text

from caseguard_ai.config import DatabaseSettings
from caseguard_ai.db.tables import chunks, corpus_meta, documents
from caseguard_ai.ingest.errors import DumpRefused

__all__ = ["DumpRefused", "Manifest", "build_dump", "restore_dump", "verify_dump"]

FORMAT = "caseguard-corpus-dump"
FORMAT_VERSION = 1
DUMP_FILE = "corpus.dump"
MANIFEST_FILE = "manifest.json"
# Parents first on restore: chunks reference documents.
TABLES: tuple[Table, ...] = (corpus_meta, documents, chunks)
DEFAULT_OUT = Path(__file__).resolve().parents[3] / ".dumps"  # services/ai/.dumps, git-ignored
_READ_SIZE = 1 << 20


def copy_columns(table: Table) -> list[str]:
    """Every stored column, without generated ones (``tsv``), which Postgres recomputes."""
    return [c.name for c in table.columns if c.computed is None]


def _copy_sql(table: Table, direction: str) -> str:
    cols = ", ".join(f'"{c}"' for c in copy_columns(table))
    return f"COPY {table.schema}.{table.name} ({cols}) {direction} (FORMAT binary)"


def _member(table: Table) -> str:
    return f"{table.name}.copy.gz"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while block := fh.read(_READ_SIZE):
            digest.update(block)
    return digest.hexdigest()


# ── what is loaded ────────────────────────────────────────────────────────────────────────────


def alembic_revision(conn: Connection) -> str | None:
    try:
        return conn.execute(text("SELECT version_num FROM ai.alembic_version")).scalar()
    except Exception:  # no version table: the database was never migrated
        return None


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime | date):
        return value.isoformat()
    return value


def corpus_summary(conn: Connection) -> dict[str, Any] | None:
    """The settings and size of the corpus loaded now, or None when it is empty."""
    meta = conn.execute(select(corpus_meta)).mappings().first()
    counts = {
        t.name: conn.execute(select(func.count()).select_from(t)).scalar_one() for t in TABLES
    }
    if meta is None and counts["documents"] == 0:
        return None
    return {
        "corpus_meta": {k: _jsonable(v) for k, v in meta.items()} if meta else None,
        "counts": counts,
    }


def describe(summary: dict[str, Any] | None) -> str:
    """One line for people: built when, from which snapshots, with what, how big."""
    if summary is None:
        return "empty"
    meta = summary.get("corpus_meta") or {}
    counts = summary["counts"]
    snapshots = ", ".join(meta.get("input_snapshots") or []) or "no snapshots recorded"
    return (
        f"{counts['documents']} documents, {counts['chunks']} chunks; "
        f"{meta.get('embedding_model')}@{str(meta.get('embedding_revision'))[:12]}; "
        f"built {meta.get('built_at') or 'never (embedding unfinished)'}; from {snapshots}"
    )


def _git(*args: str) -> str | None:
    try:
        done = subprocess.run(  # noqa: S603
            ["git", *args],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
            cwd=Path(__file__).resolve().parent,
        )
    except (OSError, subprocess.SubprocessError):
        return None  # no git (e.g. inside the image): provenance is then unknown
    return done.stdout.strip()


def _provenance() -> dict[str, Any]:
    commit = _git("rev-parse", "HEAD")
    status = _git("status", "--porcelain") if commit else None
    return {
        "publisher": _git("config", "user.name"),
        "git": {"commit": commit, "dirty": bool(status) if status is not None else None},
    }


# ── build ─────────────────────────────────────────────────────────────────────────────────────


@dataclass
class Manifest:
    data: dict[str, Any] = field(default_factory=dict)

    @property
    def counts(self) -> dict[str, int]:
        return dict(self.data["counts"])

    @property
    def revision(self) -> str:
        return str(self.data["alembic_revision"])

    def write(self, path: Path) -> None:
        path.write_text(json.dumps(self.data, indent=2, sort_keys=True) + "\n", newline="\n")

    @classmethod
    def read(cls, path: Path) -> Manifest:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DumpRefused(f"cannot read {path}: {exc}") from exc
        if data.get("format") != FORMAT or data.get("format_version") != FORMAT_VERSION:
            raise DumpRefused(
                f"{path} is not a {FORMAT} v{FORMAT_VERSION} manifest. "
                "Dumps made by hand with pg_dump can't be restored with this command."
            )
        return cls(data)


def _check_buildable(conn: Connection) -> None:
    meta = conn.execute(select(corpus_meta)).mappings().first()
    if conn.execute(select(func.count()).select_from(documents)).scalar_one() == 0:
        raise DumpRefused("the corpus is empty: run pnpm data:load and pnpm data:embed first")
    if meta is None or meta["embedding_model"] is None:
        raise DumpRefused("the corpus has never been embedded: run pnpm data:embed first")
    if meta["built_at"] is None:
        raise DumpRefused(
            "the last pnpm data:embed run didn't finish: run it again until it completes"
        )
    missing = conn.execute(
        select(func.count()).select_from(chunks).where(chunks.c.embedding.is_(None))
    ).scalar_one()
    if missing:
        raise DumpRefused(f"{missing} chunks have no embedding yet: run pnpm data:embed")


def build_dump(engine: Engine, out_dir: Path) -> Manifest:
    """Write ``corpus.dump`` and ``manifest.json`` into ``out_dir`` from one consistent snapshot."""
    out_dir.mkdir(parents=True, exist_ok=True)
    dump_path = out_dir / DUMP_FILE
    staged: list[Path] = []
    counts: dict[str, int] = {}
    # REPEATABLE READ: every table is copied from the same moment, even if a load runs meanwhile.
    with (
        engine.connect().execution_options(isolation_level="REPEATABLE READ") as conn,
        conn.begin(),
    ):
        _check_buildable(conn)
        revision = alembic_revision(conn)
        if revision is None:
            raise DumpRefused("no ai.alembic_version: run pnpm db:migrate:ai")
        summary = corpus_summary(conn)
        assert summary is not None  # noqa: S101  # _check_buildable saw documents
        cursor = conn.connection.driver_connection.cursor()  # type: ignore[union-attr]
        try:
            for table in TABLES:
                part = out_dir / (_member(table) + ".part")
                staged.append(part)
                with (
                    gzip.open(part, "wb", compresslevel=6) as out,
                    cursor.copy(_copy_sql(table, "TO STDOUT")) as copy,
                ):
                    for block in copy:
                        out.write(block)
                counts[table.name] = summary["counts"][table.name]
        finally:
            cursor.close()
    try:
        with tarfile.open(dump_path, "w", format=tarfile.PAX_FORMAT) as tar:
            for table, part in zip(TABLES, staged, strict=True):
                tar.add(part, arcname=_member(table))
    finally:
        for part in staged:
            part.unlink(missing_ok=True)
    manifest = Manifest(
        {
            "format": FORMAT,
            "format_version": FORMAT_VERSION,
            "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
            **_provenance(),
            "alembic_revision": revision,
            "corpus_meta": summary["corpus_meta"],
            "tables": {t.name: copy_columns(t) for t in TABLES},
            "counts": counts,
            "files": {
                DUMP_FILE: {"bytes": dump_path.stat().st_size, "sha256": sha256_file(dump_path)}
            },
        }
    )
    manifest.write(out_dir / MANIFEST_FILE)
    return manifest


# ── restore ───────────────────────────────────────────────────────────────────────────────────


@dataclass
class RestoreReport:
    counts: dict[str, int]
    replaced: dict[str, Any] | None

    def line(self) -> str:
        return (
            f"restored {self.counts['documents']} documents and {self.counts['chunks']} chunks"
            + (f" (replaced: {describe(self.replaced)})" if self.replaced else "")
        )


def verify_dump(dump_dir: Path) -> Manifest:
    """Read the manifest and check ``corpus.dump`` against its size and SHA-256."""
    manifest = Manifest.read(dump_dir / MANIFEST_FILE)
    dump_path = dump_dir / DUMP_FILE
    expected = manifest.data["files"][DUMP_FILE]
    if not dump_path.is_file():
        raise DumpRefused(f"{dump_path} is missing")
    if (
        dump_path.stat().st_size != expected["bytes"]
        or sha256_file(dump_path) != expected["sha256"]
    ):
        raise DumpRefused(f"{dump_path} doesn't match its manifest checksum: download it again")
    return manifest


def _check_restorable(conn: Connection, manifest: Manifest) -> None:
    local = alembic_revision(conn)
    if local != manifest.revision:
        raise DumpRefused(
            f"the dump was made at Alembic revision {manifest.revision}, but this database is at "
            f"{local or 'none'}. Run pnpm db:migrate:ai (or check out the matching code) first."
        )
    for table in TABLES:
        if manifest.data["tables"].get(table.name) != copy_columns(table):
            raise DumpRefused(f"the dump's {table.name} columns differ from this code's")


def _blocks(tar: tarfile.TarFile, name: str) -> Iterator[bytes]:
    member = tar.extractfile(name)
    if member is None:
        raise DumpRefused(f"{name} is missing from {DUMP_FILE}")
    with gzip.GzipFile(fileobj=member) as gz:
        while block := gz.read(_READ_SIZE):
            yield block


def restore_dump(
    engine: Engine,
    dump_dir: Path,
    *,
    confirm: Callable[[dict[str, Any] | None, Manifest], bool],
) -> RestoreReport | None:
    """Replace the local corpus with the dump in ``dump_dir``. None when ``confirm`` says no."""
    manifest = verify_dump(dump_dir)
    with engine.connect() as conn:
        _check_restorable(conn, manifest)
        current = corpus_summary(conn)
    if not confirm(current, manifest):
        return None
    with engine.begin() as conn, tarfile.open(dump_dir / DUMP_FILE, "r") as tar:
        # One transaction: a failure part-way leaves the old corpus exactly as it was.
        conn.execute(text("TRUNCATE corpus.chunks, corpus.documents, corpus.corpus_meta"))
        cursor = conn.connection.driver_connection.cursor()  # type: ignore[union-attr]
        try:
            for table in TABLES:
                with cursor.copy(_copy_sql(table, "FROM STDIN")) as copy:
                    for block in _blocks(tar, _member(table)):
                        copy.write(block)
        finally:
            cursor.close()
        counts = {
            t.name: conn.execute(select(func.count()).select_from(t)).scalar_one() for t in TABLES
        }
        if counts != manifest.counts:
            raise DumpRefused(f"restored {counts}, but the manifest says {manifest.counts}")
    return RestoreReport(counts=counts, replaced=current)


# ── CLI: pnpm data:dump ───────────────────────────────────────────────────────────────────────


def ask(question: str) -> bool:
    try:
        # A BOM can lead piped stdin on Windows (PowerShell), so strip it with the whitespace.
        answer = input(f"{question} [y/N] ").strip().lstrip("﻿").strip().lower()
        return answer in {"y", "yes"}
    except EOFError:
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build a corpus dump and publish it (#154)")
    parser.add_argument(
        "--out", type=Path, help=f"where to write it (default {DEFAULT_OUT}/<today>)"
    )
    parser.add_argument("--no-upload", action="store_true", help="build locally, publish nothing")
    parser.add_argument(
        "--freeze", metavar="eval-frozen-N", help="also tag it as the dump behind an evaluation"
    )
    parser.add_argument("--yes", action="store_true", help="publish without asking")
    args = parser.parse_args([a for a in (sys.argv[1:] if argv is None else argv) if a != "--"])
    if args.freeze:
        from caseguard_ai.ingest.hub import check_freeze_name

        try:
            check_freeze_name(args.freeze)
        except DumpRefused as exc:
            print(f"refusing: {exc}", file=sys.stderr)
            return 2
    out_dir: Path = args.out or DEFAULT_OUT / date.today().isoformat()
    engine = create_engine(DatabaseSettings().sqlalchemy_url)
    try:
        manifest = build_dump(engine, out_dir)
    except DumpRefused as exc:
        print(f"refusing: {exc}", file=sys.stderr)
        return 2
    finally:
        engine.dispose()
    size = manifest.data["files"][DUMP_FILE]["bytes"] / 1e6
    print(f"built {out_dir / DUMP_FILE} ({size:.0f} MB): {describe(manifest.data)}")
    if manifest.data["git"].get("dirty"):
        print("note: the working tree has uncommitted changes", file=sys.stderr)
    if args.no_upload:
        return 0

    from huggingface_hub.errors import HfHubHTTPError

    from caseguard_ai.ingest.hub import CorpusHub

    hub = CorpusHub.from_settings()
    if not args.yes and not ask(
        f"Publish it to {hub.repo_id}? A published dump can never be changed or deleted."
    ):
        print("not published; the files stay in", out_dir)
        return 0
    try:
        name = hub.publish(out_dir, day=date.today().isoformat(), freeze=args.freeze)
    except DumpRefused as exc:
        print(f"refusing: {exc}", file=sys.stderr)
        return 2
    except HfHubHTTPError as exc:  # no write access, repo missing, someone published meanwhile
        print(f"Hugging Face refused the upload: {exc}", file=sys.stderr)
        return 1
    print(
        f"published dumps/{name}/ (tag dump/{name}"
        + (f", dump/{args.freeze}" if args.freeze else "")
        + ")"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
