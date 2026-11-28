"""Pack a partition directory into a snapshot folder, and unpack one back (spec §3).

A partition directory (``data/partitions/<name>/``, see partitions.py) holds ``documents/``,
``raw/``, ``text/``, ``state/state.db`` and ``logs/``. A snapshot holds:

- ``records.jsonl.gz``: the combined ``documents/<source>.jsonl`` files (not the dated per-run
  copies), one line per record id, the newest line winning when a re-crawl wrote it again.
  ``file_path`` is made relative to the partition (``raw/<source>/<year>/<name>.pdf``), so no
  local path (or user name) leaves the machine.
- ``state.db``: a consistent copy, made with the SQLite backup API.
- ``files.tar``: ``raw/`` and ``text/``, uncompressed (PDFs don't compress), forward-slash names.
  Left out when the partition has no files (``shc-meta`` is metadata only).
- ``manifest.json``.

``logs/`` and ``reports/`` are never packed.
"""

from __future__ import annotations

import gzip
import json
import re
import shutil
import sqlite3
import tarfile
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from snapshots import (
    FILES_TAR,
    MANIFEST_FILE,
    RECORDS_FILE,
    STATE_FILE,
    SnapshotRefused,
)
from snapshots.manifest import Manifest, build_manifest, count_records, read_records_gz, read_runs

DOCUMENTS = "documents"
FILE_DIRS = ("raw", "text")
STATE_DB = Path("state") / "state.db"
# The per-run copies JsonlStorage writes next to the combined file: <source>_<date>[_<run>].jsonl
DATED_COPY = re.compile(r"_\d{4}-\d{2}-\d{2}(_[0-9A-Za-z]+)?\.jsonl$")


def combined_files(partition_dir: Path) -> list[Path]:
    folder = partition_dir / DOCUMENTS
    if not folder.is_dir():
        return []
    return sorted(
        p for p in folder.iterdir() if p.suffix == ".jsonl" and not DATED_COPY.search(p.name)
    )


def partition_files(partition_dir: Path) -> list[Path]:
    """Every file under ``raw/`` and ``text/``, in a stable order."""
    found: list[Path] = []
    for name in FILE_DIRS:
        base = partition_dir / name
        if base.is_dir():
            found.extend(sorted(p for p in base.rglob("*") if p.is_file()))
    return found


def _lines(paths: list[Path]) -> Iterator[tuple[int, str, dict[str, Any]]]:
    index = 0
    for path in paths:
        with path.open(encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, 1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise SnapshotRefused(f"{path}:{line_no} is not valid JSON: {exc}") from exc
                yield index, line.rstrip("\r\n"), record
                index += 1


def relative_file_path(value: Any, partition_dir: Path) -> Any:
    """``C:\\...\\partitions\\p\\raw\\x.pdf`` -> ``raw/x.pdf``; other values unchanged."""
    if not isinstance(value, str) or not value:
        return value
    path = Path(value)
    if path.is_absolute():
        try:
            return path.resolve().relative_to(partition_dir.resolve()).as_posix()
        except ValueError:
            pass
    # Crawled elsewhere (another machine, a moved folder): cut at .../partitions/<name>/.
    parts = PureWindowsPath(value).parts  # splits on both / and \
    for i in range(len(parts) - 3, -1, -1):
        if parts[i] == "partitions" and parts[i + 2] in FILE_DIRS:
            return PurePosixPath(*parts[i + 2 :]).as_posix()
    return value


@dataclass
class Packed:
    manifest: Manifest
    duplicates: int  # older lines for an id that a later line replaced


def _write_records(partition_dir: Path, out: Path) -> tuple[int, dict[str, Any]]:
    sources = combined_files(partition_dir)
    if not sources:
        raise SnapshotRefused(f"no records in {partition_dir / DOCUMENTS}: crawl it first")
    last: dict[str, int] = {}
    for index, _line, record in _lines(sources):
        if record.get("id"):
            last[str(record["id"])] = index
    duplicates = 0
    gz_raw = out.open("wb")
    try:
        # mtime=0 and no file name: the same records always give the same bytes.
        with gzip.GzipFile(filename="", mode="wb", fileobj=gz_raw, mtime=0) as gz:
            for index, line, record in _lines(sources):
                if record.get("id") and last[str(record["id"])] != index:
                    duplicates += 1
                    continue
                fixed = relative_file_path(record.get("file_path"), partition_dir)
                if fixed != record.get("file_path"):
                    record["file_path"] = fixed
                    line = json.dumps(record, ensure_ascii=False)
                gz.write((line + "\n").encode("utf-8"))
    finally:
        gz_raw.close()
    counts = count_records(read_records_gz(out))
    if not counts["records"]:
        raise SnapshotRefused(f"no records in {partition_dir / DOCUMENTS}: crawl it first")
    return duplicates, counts


def copy_state(src: Path, dst: Path) -> None:
    """A consistent copy even if a crawl has the database open (SQLite backup API)."""
    source = sqlite3.connect(f"{src.resolve().as_uri()}?mode=ro", uri=True)
    target = sqlite3.connect(dst)
    try:
        source.backup(target)
        # One self-contained file: no -wal/-shm beside it when someone opens the copy.
        target.execute("PRAGMA journal_mode=DELETE")
    finally:
        target.close()
        source.close()


def _write_files_tar(partition_dir: Path, out: Path) -> int:
    files = partition_files(partition_dir)
    if not files:
        return 0
    with tarfile.open(out, "w", format=tarfile.PAX_FORMAT) as tar:
        for path in files:
            tar.add(path, arcname=path.relative_to(partition_dir).as_posix(), recursive=False)
    return len(files)


def pack(
    partition_dir: Path,
    out_dir: Path,
    *,
    partition: str,
    folder: str,
    prov: dict[str, Any] | None = None,
) -> Packed:
    """Write a snapshot of ``partition_dir`` into the new, empty ``out_dir``."""
    if not partition_dir.is_dir():
        raise SnapshotRefused(f"{partition_dir} doesn't exist: crawl the partition first")
    state_db = partition_dir / STATE_DB
    if not state_db.is_file():
        raise SnapshotRefused(f"{state_db} is missing: crawl the partition first")
    if out_dir.exists() and any(out_dir.iterdir()):
        raise SnapshotRefused(f"{out_dir} is not empty: pick another --out or delete it")
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        duplicates, counts = _write_records(partition_dir, out_dir / RECORDS_FILE)
        copy_state(state_db, out_dir / STATE_FILE)
        counts["files"] = _write_files_tar(partition_dir, out_dir / FILES_TAR)
        manifest = build_manifest(
            out_dir,
            partition=partition,
            folder=folder,
            counts=counts,
            runs=read_runs(out_dir / STATE_FILE),
            prov=prov,
        )
    except BaseException:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise
    return Packed(manifest=manifest, duplicates=duplicates)


# ── unpack ────────────────────────────────────────────────────────────────────────────────────


def has_content(partition_dir: Path, *, with_files: bool) -> bool:
    names = [DOCUMENTS, "state", *(FILE_DIRS if with_files else ())]
    return any((partition_dir / n).is_dir() and any((partition_dir / n).iterdir()) for n in names)


def _check_tar(tar: tarfile.TarFile) -> None:
    for member in tar.getmembers():
        parts = PurePosixPath(member.name).parts
        if not parts or parts[0] not in FILE_DIRS or not (member.isfile() or member.isdir()):
            raise SnapshotRefused(f"{FILES_TAR} holds an unexpected entry {member.name!r}")


def _build(snapshot_dir: Path, staged: Path, *, with_files: bool, manifest: Manifest) -> None:
    """Write the new partition layout into the empty folder ``staged``; raises on bad input."""
    documents = staged / DOCUMENTS
    documents.mkdir(parents=True)
    handles: dict[str, Any] = {}
    try:
        with gzip.open(snapshot_dir / RECORDS_FILE, "rt", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                source = str(json.loads(line).get("source") or "unknown")
                if not re.fullmatch(r"[A-Za-z0-9_.-]+", source) or source.startswith("."):
                    raise SnapshotRefused(f"a record has a bad source name {source!r}")
                if source not in handles:
                    handles[source] = (documents / f"{source}.jsonl").open(
                        "w", encoding="utf-8", newline="\n"
                    )
                handles[source].write(line if line.endswith("\n") else line + "\n")
    finally:
        for handle in handles.values():
            handle.close()

    (staged / "state").mkdir()
    shutil.copyfile(snapshot_dir / STATE_FILE, staged / STATE_DB)

    if with_files and FILES_TAR in manifest.files:
        with tarfile.open(snapshot_dir / FILES_TAR, "r") as tar:
            _check_tar(tar)
            tar.extractall(staged, filter="data")  # no absolute paths, no ../, no links
        for name in FILE_DIRS:
            (staged / name).mkdir(exist_ok=True)
    manifest.write(staged / "snapshot.json")  # which snapshot this partition came from


def _remove(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def _swap(staged: Path, partition_dir: Path, names: list[str]) -> None:
    """Move ``names`` from ``staged`` into ``partition_dir``, keeping the old ones until done."""
    backup = staged.with_name(staged.name + ".old")
    backup.mkdir()
    moved: list[str] = []
    try:
        for name in names:
            current = partition_dir / name
            if current.exists():
                current.rename(backup / name)
            moved.append(name)
            (staged / name).rename(current)
    except BaseException:
        for name in reversed(moved):  # put the old partition back as it was
            _remove(partition_dir / name)
            if (backup / name).exists():
                (backup / name).rename(partition_dir / name)
        raise
    finally:
        shutil.rmtree(backup, ignore_errors=True)


def unpack(snapshot_dir: Path, partition_dir: Path, *, with_files: bool) -> Manifest:
    """Lay a verified snapshot out as a partition directory, replacing what was there.

    Everything is written into a temporary folder next to the partition first, so a refusal
    (a bad source name, an unexpected tar entry) leaves the partition exactly as it was. Then
    ``documents/`` and ``state/`` (with any old ``state.db-wal``/``-shm``, which SQLite would
    otherwise replay onto the new database) are swapped in whole, and ``raw/`` + ``text/`` with
    ``--with-files``. ``logs/`` and ``reports/`` are left alone.
    """
    manifest = Manifest.read(snapshot_dir / MANIFEST_FILE)
    partition_dir.mkdir(parents=True, exist_ok=True)
    staged = Path(
        tempfile.mkdtemp(prefix=f".{partition_dir.name}.unpack-", dir=partition_dir.parent)
    )
    try:
        _build(snapshot_dir, staged, with_files=with_files, manifest=manifest)
        names = [DOCUMENTS, "state", "snapshot.json"]
        if with_files and FILES_TAR in manifest.files:
            names.extend(FILE_DIRS)
        _swap(staged, partition_dir, names)
    finally:
        shutil.rmtree(staged, ignore_errors=True)
    return manifest
