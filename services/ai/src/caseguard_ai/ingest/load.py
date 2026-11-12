"""Load the collector's JSONL records into ``corpus.documents`` (#16).

    uv run python -m caseguard_ai.ingest.load <dir | file.jsonl | file.jsonl.gz>... [--snapshot P@D]
    pnpm data:load -- services/collector/data/partitions/pk-code-seed

A directory is read as the collector's output: its ``documents/<source>.jsonl`` files. The dated
per-run copies are skipped, because they duplicate the combined file.

Runs as caseguard_ai, the only writer of corpus (ADR-0002). Idempotent:
- records are keyed on the collector's id;
- a record whose text is already stored under another id is a duplicate and is skipped;
- records without usable text or a source URL are skipped and counted, never half-loaded (NFR-1).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import sys
from collections import Counter
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, create_engine, select, text
from sqlalchemy.dialects.postgresql import insert

from caseguard_ai.config import DatabaseSettings
from caseguard_ai.db.tables import documents

MIN_TEXT_CHARS = 40  # the collector's own validation threshold
BATCH = 500

_STATUTE = {"constitution", "act", "ordinance", "code", "statute", "amendment", "bill"}
_RULE = {"rules", "regulation", "subordinate_legislation"}
_JUDGMENT = {"judgment", "order"}
# Sources that publish legislation, where "order" means a President's or Governor's Order
# (e.g. "Acceding State (Property) Order, 1961"), not a court order.
LEGISLATION_SOURCES = {"pakistan_code"}
_DATED_COPY = re.compile(r"_\d{4}-\d{2}-\d{2}_[0-9a-f]+\.jsonl(\.gz)?$")
# Fields worth keeping beside the columns, for display, the graph (M2) and the taxonomy.
_KEEP = (
    "document_type",
    "document_number",
    "category",
    "bench",
    "province",
    "jurisdiction",
    "case_status",
    "judges",
    "parties",
    "advocates",
    "connected_cases",
    "cited_laws",
    "cited_cases",
    "notes",
    "mime_type",
    "page_count",
    "promulgation_date",
    "institution_date",
    "disposal_date",
    "hearing_dates",
    "extraction_error",
)


@dataclass
class Report:
    read: int = 0
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    duplicates: int = 0
    kept_full_text: int = 0
    repeated_ids: int = 0
    skipped: Counter[str] = field(default_factory=Counter)

    def line(self) -> str:
        skipped = ", ".join(f"{k} {v}" for k, v in sorted(self.skipped.items())) or "none"
        return (
            f"read {self.read}: inserted {self.inserted}, updated {self.updated}, "
            f"unchanged {self.unchanged}, duplicate text {self.duplicates}, "
            f"kept full text {self.kept_full_text}, same id again {self.repeated_ids}; "
            f"skipped: {skipped}"
        )


# ── reading ────────────────────────────────────────────────────────────────────────────────


def input_files(paths: Iterable[Path]) -> list[Path]:
    files: list[Path] = []
    for path in paths:
        if path.is_dir():
            folder = path / "documents" if (path / "documents").is_dir() else path
            found = sorted(
                p
                for p in folder.iterdir()
                if p.name.endswith((".jsonl", ".jsonl.gz")) and not _DATED_COPY.search(p.name)
            )
            files.extend(found)
        elif path.is_file():
            files.append(path)
        else:
            raise FileNotFoundError(path)
    return files


def read_records(files: Iterable[Path]) -> Iterator[dict[str, Any]]:
    for path in files:
        opener = gzip.open if path.name.endswith(".gz") else open
        with opener(path, "rt", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    yield json.loads(line)


# ── mapping ────────────────────────────────────────────────────────────────────────────────


def kind_of(document_type: str | None, source: str = "") -> str:
    value = (document_type or "").lower()
    if value == "order" and source in LEGISLATION_SOURCES:
        return "statute"
    if value in _STATUTE:
        return "statute"
    if value in _RULE:
        return "rule"
    if value in _JUDGMENT:
        return "judgment"
    return "other"


def _date(value: Any) -> date | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def is_headnote_only(record: dict[str, Any]) -> bool:
    """The collector's explicit flag (#147), or, for older records, its note."""
    raw = record.get("raw") or {}
    if isinstance(raw.get("headnote_only"), bool):
        return bool(raw["headnote_only"])
    return any("not the judgment itself" in str(n) for n in record.get("notes") or [])


def is_third_party(record: dict[str, Any]) -> bool:
    raw = record.get("raw") or {}
    return str(record.get("source", "")).startswith("hf_") or (
        raw.get("provenance") == "third_party_dataset"
    )


def content_hash(record: dict[str, Any]) -> str:
    existing = record.get("content_hash")
    if isinstance(existing, str) and existing:
        return existing
    normalised = " ".join(str(record.get("full_text", "")).lower().split())
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()


def to_row(record: dict[str, Any], snapshot: str | None) -> tuple[dict[str, Any] | None, str]:
    """The corpus.documents row for one record, or (None, reason) when it can't be loaded."""
    if not record.get("id") or not record.get("source"):
        return None, "no id or source"
    official_url = record.get("source_url") or record.get("document_url")
    if not official_url:
        return None, "no source URL"
    full_text = str(record.get("full_text") or "")
    if len(full_text.strip()) < MIN_TEXT_CHARS:
        return None, "no usable text"

    kind = kind_of(record.get("document_type"), str(record.get("source", "")))
    third_party = is_third_party(record)
    raw = dict(record.get("raw") or {})
    raw.update({k: record[k] for k in _KEEP if record.get(k) not in (None, "", [], {})})
    decided_on = (
        _date(record.get("judgment_date")) or _date(record.get("date"))
        if kind == "judgment"
        else None
    )
    row = {
        "collector_id": record["id"],
        "source_key": record["source"],
        "kind": kind,
        "title": record.get("title") or record.get("case_number") or record["id"],
        "citation": record.get("citation"),
        "case_number": record.get("case_number"),
        "court": record.get("court"),
        "matter_type": record.get("matter_type"),
        "decided_on": decided_on,
        "language": record.get("language") or "en",
        "official_url": official_url,
        "document_file_url": record.get("document_file_url"),
        "retrieved_at": _timestamp(record.get("scraped_at")),
        "source_tier": 2 if third_party else 1,
        "third_party": third_party,
        "headnote_only": is_headnote_only(record),
        "snapshot": snapshot,
        "extraction_status": record.get("extraction_status"),
        "full_text": full_text,
        "summary": record.get("summary"),
        "content_hash": content_hash(record),
        "raw": raw,
    }
    return row, ""


# ── writing ────────────────────────────────────────────────────────────────────────────────

# Never let a head-note-only record (e.g. a later metadata-only pass) replace a stored judgment.
_CHANGED = text(
    "NOT (excluded.headnote_only AND NOT corpus.documents.headnote_only) AND"
    " (corpus.documents.content_hash, corpus.documents.title, corpus.documents.official_url,"
    " corpus.documents.headnote_only, corpus.documents.third_party, corpus.documents.snapshot,"
    " corpus.documents.raw) IS DISTINCT FROM (excluded.content_hash, excluded.title,"
    " excluded.official_url, excluded.headnote_only, excluded.third_party, excluded.snapshot,"
    " excluded.raw)"
)


def _one_per_id(rows: list[dict[str, Any]], report: Report) -> list[dict[str, Any]]:
    """One row per collector id. The same id comes twice when two partitions hold one judgment:
    the head-note row from shc-meta and the full judgment from shc-criminal / shc-civil (#153).
    The full judgment wins whichever comes first; otherwise the later record wins. Postgres
    refuses an upsert that touches one row twice, so this must happen before it."""
    by_id: dict[str, dict[str, Any]] = {}
    for row in rows:
        seen = by_id.get(row["collector_id"])
        if seen is None:
            by_id[row["collector_id"]] = row
        elif row["headnote_only"] and not seen["headnote_only"]:
            report.kept_full_text += 1
        else:
            if seen["headnote_only"] and not row["headnote_only"]:
                report.kept_full_text += 1
            else:
                report.repeated_ids += 1
            by_id[row["collector_id"]] = row
    return list(by_id.values())


def _write_batch(engine: Engine, rows: list[dict[str, Any]], report: Report) -> None:
    rows = _one_per_id(rows, report)
    # Same text under two collector ids (e.g. one judgment listed under two judges) is stored once.
    unique: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row["content_hash"] in unique:
            report.duplicates += 1
        else:
            unique[row["content_hash"]] = row
    with engine.begin() as conn:
        owners = dict(
            conn.execute(
                select(documents.c.content_hash, documents.c.collector_id).where(
                    documents.c.content_hash.in_(list(unique))
                )
            ).all()
        )
        full_text_ids = set(
            conn.execute(
                select(documents.c.collector_id).where(
                    documents.c.collector_id.in_([r["collector_id"] for r in unique.values()]),
                    documents.c.headnote_only.is_(False),
                )
            ).scalars()
        )
        batch = []
        for digest, row in unique.items():
            owner = owners.get(digest)
            if owner is not None and owner != row["collector_id"]:
                report.duplicates += 1
            elif row["headnote_only"] and row["collector_id"] in full_text_ids:
                report.kept_full_text += 1
            else:
                batch.append(row)
        if not batch:
            return
        stmt = insert(documents).values(batch)
        excluded = stmt.excluded
        updatable = [
            c.name for c in documents.columns if c.name in batch[0] and c.name != "collector_id"
        ]
        upsert = stmt.on_conflict_do_update(
            index_elements=[documents.c.collector_id],
            set_={**{name: excluded[name] for name in updatable}, "updated_at": text("now()")},
            where=_CHANGED,
        ).returning(documents.c.collector_id, text("(xmax = 0) AS inserted"))
        written = conn.execute(upsert).all()
        inserted = sum(1 for r in written if r.inserted)
        report.inserted += inserted
        report.updated += len(written) - inserted
        report.unchanged += len(batch) - len(written)


def load(
    engine: Engine,
    records: Iterable[dict[str, Any]],
    snapshot: str | None = None,
    dry_run: bool = False,
) -> Report:
    report = Report()
    pending: list[dict[str, Any]] = []
    for record in records:
        report.read += 1
        row, reason = to_row(record, snapshot)
        if row is None:
            report.skipped[reason] += 1
            continue
        pending.append(row)
        if len(pending) >= BATCH:
            if not dry_run:
                _write_batch(engine, pending, report)
            pending = []
    if pending and not dry_run:
        _write_batch(engine, pending, report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Load collector JSONL into corpus.documents")
    parser.add_argument("paths", nargs="+", type=Path, help="collector output dirs or JSONL files")
    parser.add_argument(
        "--snapshot", help='where the records came from, e.g. "pk-code-seed@2026-11-10"'
    )
    parser.add_argument("--dry-run", action="store_true", help="map and count, write nothing")
    args = parser.parse_args([a for a in (sys.argv[1:] if argv is None else argv) if a != "--"])
    files = input_files(args.paths)
    if not files:
        print("no JSONL files found", file=sys.stderr)
        return 2
    engine = create_engine(DatabaseSettings().sqlalchemy_url)
    try:
        report = load(engine, read_records(files), args.snapshot, args.dry_run)
    finally:
        engine.dispose()
    print(("[dry run] " if args.dry_run else "") + report.line())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
