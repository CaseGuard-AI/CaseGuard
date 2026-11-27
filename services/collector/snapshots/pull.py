"""Fetch a published snapshot into ``data/partitions/<partition>/`` (data-storage spec §7).

1. Resolve ``--date`` (default: the newest folder) and download the manifest at its tag.
2. Download ``records.jsonl.gz`` and ``state.db``, and ``files.tar`` only with ``--with-files``
   (it is most of the size, and only needed to re-extract, OCR or audit an original).
3. Check every downloaded file's size and SHA-256, and recount the records.
4. Refuse to replace a partition that already has records or state, unless ``--yes``.
5. Unpack: ``documents/<source>.jsonl``, ``state/state.db``, ``raw/`` + ``text/``, and
   ``snapshot.json`` (the manifest, so you can tell later where the partition came from).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from snapshots import FILES_TAR, MANIFEST_FILE, RECORDS_FILE, STATE_FILE, SnapshotRefused
from snapshots.hub import SnapshotHub
from snapshots.manifest import Manifest, verify_snapshot
from snapshots.pack import has_content, unpack


@dataclass
class Pulled:
    manifest: Manifest
    partition_dir: Path
    with_files: bool


def _wanted(manifest: Manifest, with_files: bool) -> list[str]:
    names = [n for n in (RECORDS_FILE, STATE_FILE) if n in manifest.files]
    if with_files and FILES_TAR in manifest.files:
        names.append(FILES_TAR)
    return names


def pull(
    partition: str,
    partition_dir: Path,
    *,
    hub: SnapshotHub | None = None,
    date: str | None = None,
    source_dir: Path | None = None,
    with_files: bool = False,
    yes: bool = False,
) -> Pulled:
    """Download (or take ``source_dir``), verify and unpack one snapshot of ``partition``."""
    if source_dir is not None:
        snapshot_dir = source_dir
        manifest = Manifest.read(snapshot_dir / MANIFEST_FILE)
    else:
        if hub is None:
            raise SnapshotRefused("no hub and no --from folder")
        folder = hub.resolve(partition, date)
        manifest, _ = hub.manifest(partition, folder)
        snapshot_dir = hub.download(
            partition, folder, [MANIFEST_FILE, *_wanted(manifest, with_files)]
        )
    if manifest.partition != partition:
        raise SnapshotRefused(f"that snapshot is of {manifest.partition}, not {partition}")
    skip = [n for n in manifest.files if n not in _wanted(manifest, with_files)]
    manifest = verify_snapshot(snapshot_dir, skip=skip)

    if has_content(partition_dir, with_files=with_files) and not yes:
        raise SnapshotRefused(
            f"{partition_dir} already has records or crawl state. Pass --yes to replace them "
            "with the snapshot (anything crawled since is lost unless you push it first)"
        )
    unpack(snapshot_dir, partition_dir, with_files=with_files)
    return Pulled(
        manifest=manifest,
        partition_dir=partition_dir,
        with_files=with_files and FILES_TAR in manifest.files,
    )
