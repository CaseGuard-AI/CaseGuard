"""The snapshot side of the private Hugging Face corpus repo (#152, data-storage spec §1, §3).

Mirrors services/ai's ``ingest/hub.py`` (the dump side): one commit per snapshot, refused if
someone else pushed in between, then a tag. **A published folder is never changed:** a second
snapshot of a partition on the same day goes to ``<date>-2``, then ``-3``.

``HF_TOKEN`` and ``HF_CORPUS_REPO`` come from the environment or the repo-root ``.env`` (empty
token: the ``hf auth login`` one). The token is never printed.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from snapshots import (
    DAY,
    DUMPS_DIR,
    FOLDER,
    MANIFEST_FILE,
    REPO_TYPE,
    SNAPSHOTS_DIR,
    SnapshotRefused,
    check_partition_name,
    folder_key,
)
from snapshots.manifest import Manifest, verify_snapshot

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_REPO = "caseguard/corpus"
LATEST_DUMP = f"{DUMPS_DIR}/LATEST"


def tag_for(partition: str, folder: str) -> str:
    return f"snap/{partition}/{folder}"


def hub_settings() -> tuple[str | None, str]:
    """(token or None, repo id), from the environment, else the repo-root ``.env``."""
    from dotenv import dotenv_values

    env = {k: v for k, v in dotenv_values(REPO_ROOT / ".env").items() if v is not None}
    token = os.environ.get("HF_TOKEN") or env.get("HF_TOKEN") or None
    repo = os.environ.get("HF_CORPUS_REPO") or env.get("HF_CORPUS_REPO") or DEFAULT_REPO
    return token, repo


@dataclass
class Inventory:
    """What the repo holds now: snapshot and dump folders with their sizes."""

    snapshots: dict[str, dict[str, int]] = field(default_factory=dict)  # partition -> folder -> B
    with_manifest: set[tuple[str, str]] = field(default_factory=set)  # (partition, folder)
    tagged: set[tuple[str, str]] = field(default_factory=set)  # (partition, folder)
    dumps: dict[str, int] = field(default_factory=dict)  # folder -> bytes
    total_bytes: int = 0
    latest_dump: str | None = None


class SnapshotHub:
    """``api`` is a ``huggingface_hub.HfApi`` (a fake in tests)."""

    def __init__(self, api: Any, repo_id: str) -> None:
        self.api = api
        self.repo_id = repo_id

    @classmethod
    def from_env(cls) -> SnapshotHub:
        from huggingface_hub import HfApi

        token, repo = hub_settings()
        return cls(HfApi(token=token), repo)

    # ── publish ───────────────────────────────────────────────────────────────────────────────

    def _refs(self) -> Any:
        return self.api.list_repo_refs(self.repo_id, repo_type=REPO_TYPE)

    def _tags(self) -> set[str]:
        return {tag.name for tag in self._refs().tags}

    def _head(self) -> str | None:
        return next((b.target_commit for b in self._refs().branches if b.name == "main"), None)

    def _contents(self, partition: str) -> dict[str, set[str]]:
        """Every folder under ``snapshots/<partition>/`` with the files in it."""
        from huggingface_hub.errors import EntryNotFoundError

        base = f"{SNAPSHOTS_DIR}/{partition}/"
        found: dict[str, set[str]] = {}
        try:
            for entry in self.api.list_repo_tree(
                self.repo_id, path_in_repo=base.rstrip("/"), recursive=True, repo_type=REPO_TYPE
            ):
                rest = str(entry.path)[len(base) :].split("/")
                if len(rest) >= 2 and FOLDER.fullmatch(rest[0]):
                    found.setdefault(rest[0], set()).add("/".join(rest[1:]))
        except EntryNotFoundError:
            return {}
        return found

    def _taken(self, partition: str, folder: str, tags: set[str], present: set[str]) -> bool:
        # Any file at all counts: a folder uploaded by hand is never added to either.
        return tag_for(partition, folder) in tags or folder in present

    def next_folder(self, partition: str, day: str) -> str:
        """``<day>``, or ``<day>-N`` for the first N not yet published."""
        check_partition_name(partition)
        if not DAY.fullmatch(day):
            raise SnapshotRefused(f"bad date {day!r} (YYYY-MM-DD)")
        tags, present = self._tags(), set(self._contents(partition))
        if not self._taken(partition, day, tags, present):
            return day
        n = 2
        while self._taken(partition, f"{day}-{n}", tags, present):
            n += 1
        return f"{day}-{n}"

    def untagged(self, partition: str) -> list[str]:
        """Folders with a manifest but no tag: a publish whose ``create_tag`` failed."""
        tags = self._tags()
        return sorted(
            (
                f
                for f, names in self._contents(partition).items()
                if MANIFEST_FILE in names and tag_for(partition, f) not in tags
            ),
            key=folder_key,
        )

    def repair_tags(self, partition: str) -> list[str]:
        """Tag every untagged snapshot folder at ``main``.

        Safe because a published folder never changes: its files at ``main`` are the files of
        the commit that published it.
        """
        missing = self.untagged(partition)
        if missing:
            head = self._head()
            for folder in missing:
                self.api.create_tag(
                    self.repo_id, tag=tag_for(partition, folder), revision=head, repo_type=REPO_TYPE
                )
        return missing

    def publish(self, snapshot_dir: Path) -> str:
        """Upload a packed, checked snapshot to its folder in one commit, and tag it.

        An earlier publish whose tag failed is repaired first, so it becomes pullable.
        """
        from huggingface_hub import CommitOperationAdd

        manifest = verify_snapshot(snapshot_dir)  # never upload a file that fails its checksum
        partition, folder = check_partition_name(manifest.partition), manifest.folder
        folder_key(folder)
        self.repair_tags(partition)
        if self._taken(partition, folder, self._tags(), set(self._contents(partition))):
            raise SnapshotRefused(
                f"snapshots/{partition}/{folder} was published meanwhile: run data:push again"
            )
        base = f"{SNAPSHOTS_DIR}/{partition}/{folder}"
        names = [MANIFEST_FILE, *sorted(manifest.files)]
        info = self.api.create_commit(
            self.repo_id,
            operations=[CommitOperationAdd(f"{base}/{n}", snapshot_dir / n) for n in names],
            commit_message=f"Snapshot {partition}@{folder}",
            repo_type=REPO_TYPE,
            parent_commit=self._head(),  # refused if someone else pushed in between
        )
        self.api.create_tag(
            self.repo_id, tag=tag_for(partition, folder), revision=info.oid, repo_type=REPO_TYPE
        )
        return folder

    # ── fetch ─────────────────────────────────────────────────────────────────────────────────

    def folders(self, partition: str) -> list[str]:
        """The partition's published snapshots, oldest first: folders with a manifest and a tag.

        Folders without a manifest (tars uploaded by hand before #152) are not snapshots, and a
        folder without its ``snap/<p>/<folder>`` tag (a failed publish) can't be downloaded at
        its tag; both are skipped. The next ``data:push`` repairs a missing tag.
        """
        check_partition_name(partition)
        tags = self._tags()
        published = [
            f
            for f, names in self._contents(partition).items()
            if MANIFEST_FILE in names and tag_for(partition, f) in tags
        ]
        return sorted(published, key=folder_key)

    def resolve(self, partition: str, date: str | None) -> str:
        """None/``latest`` -> the newest folder; ``<day>`` or ``<day>-N`` -> that folder."""
        published = self.folders(partition)
        if not published:
            raise SnapshotRefused(f"no snapshots of {partition} in {self.repo_id} yet")
        if date in (None, "latest"):
            return published[-1]
        assert date is not None  # noqa: S101  # narrowed above
        if date in published:
            return date
        if not FOLDER.fullmatch(date):
            raise SnapshotRefused("--date takes latest or a folder: 2026-11-10, 2026-11-10-2")
        raise SnapshotRefused(
            f"no snapshot {partition}@{date}; published: {', '.join(published[-10:])}"
        )

    def download(self, partition: str, folder: str, names: list[str]) -> Path:
        """Download files of one snapshot (at its tag) into the HF cache; returns their folder."""
        revision = tag_for(partition, folder)
        paths = [
            Path(
                self.api.hf_hub_download(
                    self.repo_id,
                    f"{SNAPSHOTS_DIR}/{partition}/{folder}/{name}",
                    repo_type=REPO_TYPE,
                    revision=revision,
                )
            )
            for name in names
        ]
        if len({p.parent for p in paths}) > 1:
            raise SnapshotRefused("the downloaded snapshot files landed in different folders")
        return paths[0].parent

    def manifest(self, partition: str, folder: str) -> tuple[Manifest, Path]:
        where = self.download(partition, folder, [MANIFEST_FILE])
        return Manifest.read(where / MANIFEST_FILE), where

    # ── status ────────────────────────────────────────────────────────────────────────────────

    def inventory(self) -> Inventory:
        inv = Inventory()
        for tag in self._tags():
            bits = tag.split("/")
            if len(bits) == 3 and bits[0] == "snap":
                inv.tagged.add((bits[1], bits[2]))
        for entry in self.api.list_repo_tree(self.repo_id, recursive=True, repo_type=REPO_TYPE):
            size = getattr(entry, "size", None)
            if size is None:  # a folder
                continue
            inv.total_bytes += int(size)
            parts = Path(entry.path).parts
            if len(parts) >= 4 and parts[0] == SNAPSHOTS_DIR and FOLDER.fullmatch(parts[2]):
                folders = inv.snapshots.setdefault(parts[1], {})
                folders[parts[2]] = folders.get(parts[2], 0) + int(size)
                if len(parts) == 4 and parts[3] == MANIFEST_FILE:
                    inv.with_manifest.add((parts[1], parts[2]))
            elif len(parts) >= 3 and parts[0] == DUMPS_DIR and FOLDER.fullmatch(parts[1]):
                inv.dumps[parts[1]] = inv.dumps.get(parts[1], 0) + int(size)
        if inv.dumps:
            try:
                path = self.api.hf_hub_download(self.repo_id, LATEST_DUMP, repo_type=REPO_TYPE)
                inv.latest_dump = Path(path).read_text(encoding="utf-8").strip() or None
            except Exception:  # noqa: BLE001  # LATEST is informative only
                inv.latest_dump = None
        return inv
