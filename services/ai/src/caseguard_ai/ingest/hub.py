"""Publish and fetch corpus dumps on the private Hugging Face dataset (#154, data-storage spec §1).

Layout in ``HF_CORPUS_REPO`` (``caseguard/corpus``):

    dumps/LATEST                      the only file ever overwritten: the newest folder's name
    dumps/<YYYY-MM-DD>[-N]/manifest.json
    dumps/<YYYY-MM-DD>[-N]/corpus.dump

Every dump is tagged ``dump/<folder>``, and a dump behind evaluation results also
``dump/eval-frozen-<n>``. **A published folder is never changed:** a second dump on the same day
goes to ``<date>-2``, then ``-3``. The folder, its files and ``LATEST`` go up in one commit, so
``LATEST`` always names a complete dump, and the commit is refused if someone else published
meanwhile.

The token comes from ``HF_TOKEN`` (or ``hf auth login``) and is never printed.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from caseguard_ai.config import HubSettings
from caseguard_ai.ingest.dump import DUMP_FILE, MANIFEST_FILE, verify_dump
from caseguard_ai.ingest.errors import DumpRefused

REPO_TYPE = "dataset"
LATEST = "dumps/LATEST"
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
_FOLDER = re.compile(r"\d{4}-\d{2}-\d{2}(-\d+)?")
_FROZEN = re.compile(r"eval-frozen-\d+")


def check_freeze_name(name: str) -> str:
    if not _FROZEN.fullmatch(name):
        raise DumpRefused(f"--freeze takes eval-frozen-<n> (e.g. eval-frozen-1), not {name!r}")
    return name


class CorpusHub:
    """The dump side of the corpus repo. ``api`` is a ``huggingface_hub.HfApi`` (a fake in tests)."""

    def __init__(self, api: Any, repo_id: str) -> None:
        self.api = api
        self.repo_id = repo_id

    @classmethod
    def from_settings(cls, settings: HubSettings | None = None) -> CorpusHub:
        from huggingface_hub import HfApi

        settings = settings or HubSettings()
        token = settings.hf_token.get_secret_value() or None  # None: the `hf auth login` token
        return cls(HfApi(token=token), settings.hf_corpus_repo)

    # ── publish ───────────────────────────────────────────────────────────────────────────────

    def _tags(self) -> set[str]:
        refs = self.api.list_repo_refs(self.repo_id, repo_type=REPO_TYPE)
        return {tag.name for tag in refs.tags}

    def _head(self) -> str | None:
        refs = self.api.list_repo_refs(self.repo_id, repo_type=REPO_TYPE)
        return next((b.target_commit for b in refs.branches if b.name == "main"), None)

    def _taken(self, folder: str, tags: set[str]) -> bool:
        return f"dump/{folder}" in tags or self.api.file_exists(
            self.repo_id, f"dumps/{folder}/{MANIFEST_FILE}", repo_type=REPO_TYPE
        )

    def next_folder(self, day: str, tags: set[str]) -> str:
        if not _DAY.fullmatch(day):
            raise DumpRefused(f"bad date {day!r}")
        if not self._taken(day, tags):
            return day
        n = 2
        while self._taken(f"{day}-{n}", tags):
            n += 1
        return f"{day}-{n}"

    def publish(self, dump_dir: Path, *, day: str, freeze: str | None = None) -> str:
        """Upload a built dump to a new ``dumps/<day>[-N]/``, move ``LATEST``, tag it."""
        from huggingface_hub import CommitOperationAdd

        verify_dump(dump_dir)  # never publish a file that doesn't match its manifest
        tags = self._tags()
        if freeze is not None:
            check_freeze_name(freeze)
            if f"dump/{freeze}" in tags:
                raise DumpRefused(f"dump/{freeze} already exists: pick the next number")
        folder = self.next_folder(day, tags)
        info = self.api.create_commit(
            self.repo_id,
            operations=[
                CommitOperationAdd(f"dumps/{folder}/{MANIFEST_FILE}", dump_dir / MANIFEST_FILE),
                CommitOperationAdd(f"dumps/{folder}/{DUMP_FILE}", dump_dir / DUMP_FILE),
                CommitOperationAdd(LATEST, f"{folder}\n".encode()),
            ],
            commit_message=f"Corpus dump {folder}",
            repo_type=REPO_TYPE,
            parent_commit=self._head(),  # refused if someone else pushed in between
        )
        self.api.create_tag(
            self.repo_id, tag=f"dump/{folder}", revision=info.oid, repo_type=REPO_TYPE
        )
        if freeze is not None:
            self.api.create_tag(
                self.repo_id, tag=f"dump/{freeze}", revision=info.oid, repo_type=REPO_TYPE
            )
        return folder

    # ── fetch ─────────────────────────────────────────────────────────────────────────────────

    def _latest_at(self, revision: str) -> str:
        path = self.api.hf_hub_download(
            self.repo_id, LATEST, repo_type=REPO_TYPE, revision=revision
        )
        folder = Path(path).read_text(encoding="utf-8").strip()
        if not _FOLDER.fullmatch(folder):
            raise DumpRefused(f"{LATEST} at {revision} holds {folder!r}, not a dump folder")
        return folder

    def resolve(self, which: str) -> tuple[str, str]:
        """``latest`` | ``<date>[-N]`` | ``eval-frozen-<n>`` -> (folder, immutable tag)."""
        if which == "latest":
            folder = self._latest_at("main")
        elif _FOLDER.fullmatch(which):
            folder = which
        elif _FROZEN.fullmatch(which):
            # The frozen tag points at the commit that published its dump, where LATEST named it.
            folder = self._latest_at(f"dump/{which}")
        else:
            raise DumpRefused("--dump takes latest, a date (2026-11-10[-N]) or eval-frozen-<n>")
        return folder, f"dump/{folder}"

    def download(self, which: str) -> tuple[str, Path]:
        """Download a dump into the Hugging Face cache (``HF_HOME``); returns (folder, its dir)."""
        folder, revision = self.resolve(which)
        paths = [
            Path(
                self.api.hf_hub_download(
                    self.repo_id,
                    f"dumps/{folder}/{name}",
                    repo_type=REPO_TYPE,
                    revision=revision,
                )
            )
            for name in (MANIFEST_FILE, DUMP_FILE)
        ]
        if paths[0].parent != paths[1].parent:
            raise DumpRefused("the downloaded dump files landed in different folders")
        return folder, paths[0].parent
