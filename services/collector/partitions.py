"""Partitions: named, bounded slices of the crawl (docs/engineering/data-storage.md §2, #153).

A partition fixes the source, the scope and (optionally) a *selection*, and writes into its own
output directory, ``<output>/partitions/<name>/``, so each one can be snapshotted on its own.

    pk-code-seed   Pakistan Code, only the titles matched by selections/pk-code-seed.txt
    shc-meta       every SHC judgment, metadata only (PKLEGAL_SHC_SCOPE=all, --no-pdfs)
    shc-criminal   files for the criminal judgments listed in selections/shc-criminal.csv
    shc-civil      files for the civil judgments listed in selections/shc-civil.csv

A selection never changes what a scraper *parses*, only which discovered items it processes.
"""

from __future__ import annotations

import csv
import hashlib
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from config import PROJECT_ROOT

SELECTIONS_DIR = PROJECT_ROOT / "selections"


class Item(Protocol):
    url: str

    def hint(self, key: str, default=None): ...


# ----------------------------------------------------------------------
# selections
# ----------------------------------------------------------------------
@dataclass
class Selection:
    """Which discovered items a run processes."""

    path: Path
    sha256: str
    source_snapshot: str | None = None

    def wants(self, item: Item) -> bool:  # pragma: no cover - abstract
        raise NotImplementedError

    def exhausted(self) -> bool:
        """True when nothing more can match, so discovery can stop early."""
        return False

    def missing(self) -> list[str]:
        """Selected entries that discovery never produced (reported at the end of a run)."""
        return []


@dataclass
class TitleSelection(Selection):
    """Items whose title matches one of the patterns (case-insensitive regexes)."""

    patterns: list[re.Pattern[str]] = field(default_factory=list)
    _hits: set[int] = field(default_factory=set, init=False, repr=False)

    def wants(self, item: Item) -> bool:
        title = item.hint("title") or ""
        for index, pattern in enumerate(self.patterns):
            if pattern.search(title):
                self._hits.add(index)
                return True
        return False

    def missing(self) -> list[str]:
        return [p.pattern for i, p in enumerate(self.patterns) if i not in self._hits]


@dataclass
class IdSelection(Selection):
    """Items whose collector document id is listed.

    The id is ``LegalDocument.make_id()`` over the discovered URL, which is the document URL for
    inline sources such as SHC, so it is known before anything is fetched.
    """

    source: str = ""
    ids: set[str] = field(default_factory=set)
    _found: set[str] = field(default_factory=set, init=False, repr=False)

    def id_of(self, item: Item) -> str:
        digest = hashlib.sha256(f"{self.source}|{item.url}".encode()).hexdigest()[:24]
        return f"{self.source}-{digest}"

    def wants(self, item: Item) -> bool:
        doc_id = self.id_of(item)
        if doc_id in self.ids:
            self._found.add(doc_id)
            return True
        return False

    def exhausted(self) -> bool:
        return bool(self.ids) and self._found >= self.ids

    def missing(self) -> list[str]:
        return sorted(self.ids - self._found)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _comment_value(lines: Iterable[str], key: str) -> str | None:
    prefix = f"# {key}:"
    for line in lines:
        if line.startswith(prefix):
            return line[len(prefix) :].strip() or None
    return None


def load_title_selection(path: Path) -> TitleSelection:
    """One regex per line; blank lines and ``#`` comments ignored."""
    lines = path.read_text(encoding="utf-8").splitlines()
    patterns = [
        re.compile(line.strip(), re.I)
        for line in lines
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if not patterns:
        raise ValueError(f"{path}: no title patterns")
    return TitleSelection(path=path, sha256=_sha256(path), patterns=patterns)


def load_id_selection(path: Path, source: str) -> IdSelection:
    """A selection CSV written by tools/make_selection.py (``document_id`` column required)."""
    lines = path.read_text(encoding="utf-8").splitlines()
    comments = [ln for ln in lines if ln.startswith("#")]
    rows = list(csv.DictReader(ln for ln in lines if ln.strip() and not ln.startswith("#")))
    if not rows or "document_id" not in rows[0]:
        raise ValueError(f"{path}: expected a CSV with a document_id column")
    ids = {r["document_id"].strip() for r in rows if r["document_id"].strip()}
    wrong = sorted(i for i in ids if not i.startswith(f"{source}-"))
    if wrong:
        raise ValueError(f"{path}: ids from another source, e.g. {wrong[0]}")
    return IdSelection(
        path=path,
        sha256=_sha256(path),
        source_snapshot=_comment_value(comments, "source_snapshot"),
        source=source,
        ids=ids,
    )


# ----------------------------------------------------------------------
# presets
# ----------------------------------------------------------------------
@dataclass(frozen=True)
class Partition:
    name: str
    source: str
    covers: str
    shc_scope: str | None = None
    download_pdfs: bool = True
    title_selection: str | None = None  # file under selections/
    id_selection: str | None = None  # file under selections/

    def selection_path(self) -> Path | None:
        name = self.title_selection or self.id_selection
        return SELECTIONS_DIR / name if name else None

    def load_selection(self, override: Path | None = None) -> Selection | None:
        path = override or self.selection_path()
        if path is None:
            return None
        if not path.exists():
            hint = (
                " Generate it with tools/make_selection.py from an shc-meta crawl."
                if self.id_selection
                else ""
            )
            raise FileNotFoundError(f"selection file {path} not found.{hint}")
        if self.title_selection:
            return load_title_selection(path)
        return load_id_selection(path, self.source)


PARTITIONS: dict[str, Partition] = {
    "pk-code-seed": Partition(
        name="pk-code-seed",
        source="pakistan_code",
        covers="Seed statutes (PRD §15.3), their amendment acts and the Constitution",
        title_selection="pk-code-seed.txt",
    ),
    "shc-meta": Partition(
        name="shc-meta",
        source="shc_caselaw",
        covers="Metadata of every SHC judgment: the catalogue selections are drawn from",
        shc_scope="all",
        download_pdfs=False,
    ),
    "shc-criminal": Partition(
        name="shc-criminal",
        source="shc_caselaw",
        covers="Files for the criminal judgments in selections/shc-criminal.csv",
        shc_scope="all",
        id_selection="shc-criminal.csv",
    ),
    "shc-civil": Partition(
        name="shc-civil",
        source="shc_caselaw",
        covers="Files for the civil judgments in selections/shc-civil.csv",
        shc_scope="all",
        id_selection="shc-civil.csv",
    ),
}


def get_partition(name: str) -> Partition:
    try:
        return PARTITIONS[name]
    except KeyError:
        raise SystemExit(
            f"Unknown partition {name!r}. Known: {', '.join(PARTITIONS)} (--list-partitions)"
        ) from None
