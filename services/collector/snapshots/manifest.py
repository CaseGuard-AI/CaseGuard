"""The snapshot manifest: identity, provenance, counts and checksums (data-storage spec §3).

The counts double as the corpus-statistics table for the report.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import sqlite3
import subprocess  # noqa: S404  # fixed git commands for provenance only
from collections import Counter
from collections.abc import Iterable, Iterator
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from snapshots import (
    FORMAT,
    FORMAT_VERSION,
    MANIFEST_FILE,
    PAYLOAD,
    RECORDS_FILE,
    SnapshotRefused,
)

COLLECTOR_DIR = Path(__file__).resolve().parents[1]
_READ_SIZE = 1 << 20


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while block := fh.read(_READ_SIZE):
            digest.update(block)
    return digest.hexdigest()


def file_entry(path: Path) -> dict[str, Any]:
    return {"bytes": path.stat().st_size, "sha256": sha256_file(path)}


# ── counts ────────────────────────────────────────────────────────────────────────────────────


def is_headnote_only(record: dict[str, Any]) -> bool:
    """The collector's explicit flag (#147), or, for older records, its note (as data:load)."""
    raw = record.get("raw") or {}
    if isinstance(raw.get("headnote_only"), bool):
        return bool(raw["headnote_only"])
    return any("not the judgment itself" in str(n) for n in record.get("notes") or [])


def is_third_party(record: dict[str, Any]) -> bool:
    raw = record.get("raw") or {}
    return str(record.get("source", "")).startswith("hf_") or (
        raw.get("provenance") == "third_party_dataset"
    )


def count_records(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    by: dict[str, Counter[str]] = {
        k: Counter() for k in ("source", "document_type", "matter_type", "extraction_status")
    }
    total = headnote = third = 0
    for record in records:
        total += 1
        for key, counter in by.items():
            counter[str(record.get(key) or "none")] += 1
        headnote += is_headnote_only(record)
        third += is_third_party(record)
    return {
        "records": total,
        **{f"by_{key}": dict(sorted(counter.items())) for key, counter in by.items()},
        "headnote_only": headnote,
        "third_party": third,
    }


def read_records_gz(path: Path) -> Iterator[dict[str, Any]]:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise SnapshotRefused(f"{path}:{line_no} is not valid JSON: {exc}") from exc


# ── provenance ────────────────────────────────────────────────────────────────────────────────


def _git(*args: str) -> str | None:
    try:
        done = subprocess.run(  # noqa: S603
            ["git", *args],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
            cwd=COLLECTOR_DIR,
        )
    except (OSError, subprocess.SubprocessError):
        return None  # no git: provenance is then unknown, and push refuses
    return done.stdout.strip()


def provenance() -> dict[str, Any]:
    """The collector's commit and whether ``services/collector`` has uncommitted changes."""
    commit = _git("rev-parse", "HEAD")
    status = _git("status", "--porcelain", "--", ".") if commit else None
    return {
        "publisher": _git("config", "user.name"),
        "git": {"commit": commit, "dirty": bool(status) if status is not None else None},
    }


def collector_settings(partition: str) -> dict[str, Any] | None:
    """The partition preset (source, scope, PDFs, selection), when it is a known one."""
    from partitions import PARTITIONS

    preset = PARTITIONS.get(partition)
    return asdict(preset) if preset else None


def read_runs(state_db: Path) -> list[dict[str, Any]]:
    """The ``runs`` table of a crawl state database, oldest first."""
    conn = sqlite3.connect(f"{state_db.resolve().as_uri()}?mode=ro", uri=True)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM runs ORDER BY started_at").fetchall()
    except sqlite3.Error:
        return []
    finally:
        conn.close()
    return [dict(r) for r in rows]


def selection_of(runs: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The selection file of the newest run that had one."""
    for run in reversed(runs):
        if run.get("selection_file"):
            return {
                "file": run["selection_file"],
                "sha256": run.get("selection_sha256"),
                "source_snapshot": run.get("source_snapshot"),
            }
    return None


# ── the manifest ──────────────────────────────────────────────────────────────────────────────


@dataclass
class Manifest:
    data: dict[str, Any] = field(default_factory=dict)

    @property
    def partition(self) -> str:
        return str(self.data["partition"])

    @property
    def folder(self) -> str:
        return str(self.data["folder"])

    @property
    def snapshot(self) -> str:
        """``<partition>@<folder>``, what ``data:load --snapshot`` records."""
        return f"{self.partition}@{self.folder}"

    @property
    def files(self) -> dict[str, dict[str, Any]]:
        return dict(self.data["files"])

    @property
    def counts(self) -> dict[str, Any]:
        return dict(self.data["counts"])

    def write(self, path: Path) -> None:
        path.write_text(
            json.dumps(self.data, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8",
            newline="\n",
        )

    @classmethod
    def read(cls, path: Path) -> Manifest:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise SnapshotRefused(f"cannot read {path}: {exc}") from exc
        if data.get("format") != FORMAT or data.get("format_version") != FORMAT_VERSION:
            raise SnapshotRefused(f"{path} is not a {FORMAT} v{FORMAT_VERSION} manifest")
        return cls(data)


def build_manifest(
    snapshot_dir: Path,
    *,
    partition: str,
    folder: str,
    counts: dict[str, Any],
    runs: list[dict[str, Any]],
    prov: dict[str, Any] | None = None,
) -> Manifest:
    """Checksum every payload file in ``snapshot_dir`` and write ``manifest.json`` there."""
    files = {
        name: file_entry(snapshot_dir / name) for name in PAYLOAD if (snapshot_dir / name).is_file()
    }
    manifest = Manifest(
        {
            "format": FORMAT,
            "format_version": FORMAT_VERSION,
            "partition": partition,
            "folder": folder,
            "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
            **(prov if prov is not None else provenance()),
            "collector_settings": collector_settings(partition),
            "run_ids": [r["run_id"] for r in runs],
            "runs": runs,
            "selection": selection_of(runs),
            "counts": counts,
            "files": files,
        }
    )
    manifest.write(snapshot_dir / MANIFEST_FILE)
    return manifest


def verify_file(snapshot_dir: Path, name: str, expected: dict[str, Any]) -> None:
    path = snapshot_dir / name
    if not path.is_file():
        raise SnapshotRefused(f"{path} is missing")
    if path.stat().st_size != expected["bytes"] or sha256_file(path) != expected["sha256"]:
        raise SnapshotRefused(f"{path} doesn't match its manifest checksum")


def verify_snapshot(snapshot_dir: Path, *, skip: Iterable[str] = ()) -> Manifest:
    """Check every listed file's size and SHA-256 (but ``skip``), and recount the records."""
    manifest = Manifest.read(snapshot_dir / MANIFEST_FILE)
    skipped = set(skip)
    for name, expected in manifest.files.items():
        if name not in skipped:
            verify_file(snapshot_dir, name, expected)
    if RECORDS_FILE not in skipped:
        if RECORDS_FILE not in manifest.files:
            raise SnapshotRefused(f"the manifest lists no {RECORDS_FILE}")
        recount = count_records(read_records_gz(snapshot_dir / RECORDS_FILE))
        if recount["records"] != manifest.counts.get("records"):
            raise SnapshotRefused(
                f"{RECORDS_FILE} holds {recount['records']} records, "
                f"but the manifest says {manifest.counts.get('records')}"
            )
        for key, value in recount.items():
            if manifest.counts.get(key) != value:
                raise SnapshotRefused(f"the {key} count doesn't match the manifest")
    return manifest


def describe(manifest: Manifest) -> str:
    counts = manifest.counts
    size = sum(f["bytes"] for f in manifest.files.values()) / 1e6
    sources = ", ".join(f"{k} {v}" for k, v in counts.get("by_source", {}).items())
    return (
        f"{manifest.snapshot}: {counts.get('records')} records ({sources or 'none'}), "
        f"{counts.get('headnote_only', 0)} head-note only, {size:.1f} MB"
    )
