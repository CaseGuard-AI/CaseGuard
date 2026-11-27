"""Corpus snapshots: pack, check, publish and fetch one partition (#152, data-storage spec §3).

    uv run python -m snapshots push --snapshot <partition> [--no-upload] [--yes]
    uv run python -m snapshots pull --snapshot <partition> [--date D] [--with-files] [--yes]
    uv run python -m snapshots status
    pnpm data:push -- --snapshot pk-code-seed     (the same, through scripts/data.mjs)

A snapshot is a **full copy** of one partition, never a diff, in the private Hugging Face dataset
``HF_CORPUS_REPO`` (``caseguard/corpus``):

    snapshots/<partition>/<YYYY-MM-DD>[-N]/manifest.json      provenance, counts, checksums
    snapshots/<partition>/<YYYY-MM-DD>[-N]/records.jsonl.gz   every record, with full_text
    snapshots/<partition>/<YYYY-MM-DD>[-N]/state.db           crawl state, to resume
    snapshots/<partition>/<YYYY-MM-DD>[-N]/files.tar          raw/ + text/, uncompressed (if any)

Each is tagged ``snap/<partition>/<folder>``. A published folder never changes: a second push on
the same day goes to ``<date>-2``.
"""

from __future__ import annotations

import re

FORMAT = "caseguard-corpus-snapshot"
FORMAT_VERSION = 1

MANIFEST_FILE = "manifest.json"
RECORDS_FILE = "records.jsonl.gz"
STATE_FILE = "state.db"
FILES_TAR = "files.tar"
PAYLOAD = (RECORDS_FILE, STATE_FILE, FILES_TAR)

REPO_TYPE = "dataset"
SNAPSHOTS_DIR = "snapshots"
DUMPS_DIR = "dumps"

PARTITION_NAME = re.compile(r"[a-z0-9][a-z0-9-]*")
DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
FOLDER = re.compile(r"(\d{4}-\d{2}-\d{2})(?:-(\d+))?")


class SnapshotRefused(Exception):
    """A snapshot was not packed, published or unpacked, for the reason given."""


def check_partition_name(name: str) -> str:
    if not PARTITION_NAME.fullmatch(name):
        raise SnapshotRefused(f"bad partition name {name!r} (lowercase letters, digits and -)")
    return name


def folder_key(folder: str) -> tuple[str, int]:
    """Sort key: ``2026-11-10`` < ``2026-11-10-2`` < ``2026-11-11``."""
    match = FOLDER.fullmatch(folder)
    if match is None:
        raise SnapshotRefused(f"{folder!r} is not a snapshot folder (YYYY-MM-DD[-N])")
    return match.group(1), int(match.group(2) or 1)


def is_bootstrap(partition: str) -> bool:
    """Bootstrap (third-party ``hf_*``) data lives in its own partitions, named so."""
    return partition.startswith(("bootstrap", "hf-"))
