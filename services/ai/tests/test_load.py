"""Loading collector JSONL into corpus.documents (#16)."""

from __future__ import annotations

import gzip
import json
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, create_engine, text

from caseguard_ai.config import _sqlalchemy_url
from caseguard_ai.ingest.load import (
    MIN_TEXT_CHARS,
    input_files,
    is_headnote_only,
    kind_of,
    load,
    read_records,
    to_row,
)

AI_URL = os.environ.get("AI_TEST_DATABASE_URL")
SERVICE_DIR = Path(__file__).resolve().parents[1]
BODY = "302. Punishment of qatl-i-amd. Whoever commits qatl-i-amd shall be punished with death."


def record(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "pakistan_code-aaaaaaaaaaaaaaaaaaaaaaaa",
        "source": "pakistan_code",
        "source_url": "https://pakistancode.gov.pk/english/UY2F-sg-jjj",
        "document_type": "act",
        "title": "Pakistan Penal Code, 1860",
        "full_text": BODY,
        "content_hash": "h-ppc",
        "scraped_at": "2026-11-10T00:00:00+00:00",
        "extraction_status": "ok",
        "raw": {"file_status": "ok"},
    }
    base.update(overrides)
    return base


def judgment(n: int, **overrides: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "id": f"shc_caselaw-{n:024d}",
        "source": "shc_caselaw",
        "source_url": f"https://caselaw.shc.gov.pk/caselaw/download-file.php?doc={n}",
        "document_type": "judgment",
        "title": f"A (Appellant) VS The State {n}",
        "case_number": f"{n}/2024",
        "matter_type": "Cr.Bail",
        "judgment_date": "2024-05-02",
        "full_text": f"Judgment {n}. " + BODY,
        "content_hash": f"h-{n}",
        "raw": {"file_status": "ok", "headnote_only": False},
    }
    fields.update(overrides)
    return record(**fields)


# ── mapping (no database) ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("document_type", "source", "kind"),
    [
        ("act", "pakistan_code", "statute"),
        ("ordinance", "pakistan_code", "statute"),
        ("constitution", "pakistan_code", "statute"),
        ("order", "pakistan_code", "statute"),  # a President's Order is legislation
        ("rules", "pakistan_code", "rule"),
        ("judgment", "shc_caselaw", "judgment"),
        ("order", "shc_caselaw", "judgment"),
        ("cause_list", "shc_caselaw", "other"),
        (None, "x", "other"),
    ],
)
def test_kinds(document_type: str | None, source: str, kind: str) -> None:
    assert kind_of(document_type, source) == kind


def test_a_row_keeps_provenance() -> None:
    row, _ = to_row(judgment(1), "shc-criminal@2026-11-10")
    assert row is not None
    assert row["official_url"].startswith("https://caselaw.shc.gov.pk/")
    assert row["kind"] == "judgment"
    assert str(row["decided_on"]) == "2024-05-02"
    assert row["retrieved_at"].isoformat() == "2026-11-10T00:00:00+00:00"
    assert row["snapshot"] == "shc-criminal@2026-11-10"
    assert (row["source_tier"], row["third_party"], row["headnote_only"]) == (1, False, False)


def test_statutes_have_no_decision_date() -> None:
    row, _ = to_row(record(date="1860-10-06"), None)
    assert row is not None and row["decided_on"] is None


def test_third_party_records_are_labelled_tier_2() -> None:
    row, _ = to_row(record(id="hf_pakistan_laws-1", source="hf_pakistan_laws"), None)
    assert row is not None and (row["third_party"], row["source_tier"]) == (True, 2)


def test_headnote_only_comes_from_the_flag_or_the_older_note() -> None:
    assert is_headnote_only({"raw": {"headnote_only": True}}) is True
    assert (
        is_headnote_only({"raw": {"headnote_only": False}, "notes": ["not the judgment itself"]})
        is False
    )
    assert is_headnote_only(
        {"notes": ["full_text is the portal's table row ..., not the judgment itself"]}
    )
    assert is_headnote_only({}) is False


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"full_text": "x" * (MIN_TEXT_CHARS - 1)}, "no usable text"),
        ({"source_url": None, "document_url": None}, "no source URL"),
        ({"id": None}, "no id or source"),
    ],
)
def test_unloadable_records_are_skipped_with_a_reason(
    overrides: dict[str, Any], reason: str
) -> None:
    assert to_row(record(**overrides), None) == (None, reason)


def test_a_directory_is_read_without_the_dated_copies(tmp_path: Path) -> None:
    docs = tmp_path / "documents"
    docs.mkdir()
    (docs / "shc_caselaw.jsonl").write_text(json.dumps(judgment(1)) + "\n", encoding="utf-8")
    (docs / "shc_caselaw_2026-11-10_0bb804b6a35a.jsonl").write_text("{}\n", encoding="utf-8")
    with gzip.open(tmp_path / "records.jsonl.gz", "wt", encoding="utf-8") as fh:
        fh.write(json.dumps(record()) + "\n")
    files = input_files([tmp_path, tmp_path / "records.jsonl.gz"])
    assert [f.name for f in files] == ["shc_caselaw.jsonl", "records.jsonl.gz"]
    assert [r["id"] for r in read_records(files)] == [judgment(1)["id"], record()["id"]]


# ── database ───────────────────────────────────────────────────────────────────────────────

db = pytest.mark.skipif(not AI_URL, reason="needs AI_TEST_DATABASE_URL (set in CI)")


@pytest.fixture
def engine() -> Iterator[Engine]:
    url = _sqlalchemy_url(AI_URL or "")
    cfg = Config(str(SERVICE_DIR / "alembic.ini"))
    cfg.attributes["url"] = url
    command.upgrade(cfg, "head")
    eng = create_engine(url)
    with eng.begin() as conn:
        conn.execute(text("TRUNCATE corpus.documents CASCADE"))
    yield eng
    with eng.begin() as conn:
        conn.execute(text("TRUNCATE corpus.documents CASCADE"))
    eng.dispose()


def _rows(engine: Engine) -> dict[str, dict[str, Any]]:
    with engine.connect() as conn:
        result = conn.execute(
            text(
                "SELECT collector_id, kind, headnote_only, full_text, snapshot FROM corpus.documents"
            )
        )
        return {r.collector_id: dict(r._mapping) for r in result}


@db
def test_load_is_idempotent(engine: Engine) -> None:
    batch = [record(), judgment(1), judgment(2)]
    first = load(engine, batch, "p@1")
    assert (first.inserted, first.updated, first.unchanged) == (3, 0, 0)
    again = load(engine, batch, "p@1")
    assert (again.inserted, again.updated, again.unchanged) == (0, 0, 3)
    assert len(_rows(engine)) == 3


@db
def test_a_changed_record_is_updated(engine: Engine) -> None:
    load(engine, [judgment(1)], "p@1")
    report = load(engine, [judgment(1, title="Corrected title")], "p@2")
    assert report.updated == 1
    assert _rows(engine)[judgment(1)["id"]]["snapshot"] == "p@2"


@db
def test_the_same_text_under_two_ids_is_stored_once(engine: Engine) -> None:
    twin = judgment(2, content_hash="h-1")  # same judgment listed under another judge
    report = load(engine, [judgment(1), twin], None)
    assert (report.inserted, report.duplicates) == (1, 1)
    later = load(engine, [judgment(3, content_hash="h-1")], None)
    assert (later.inserted, later.duplicates) == (0, 1)


@db
def test_a_metadata_pass_never_replaces_a_full_judgment(engine: Engine) -> None:
    load(engine, [judgment(1)], "shc-criminal@1")
    headnote = judgment(
        1,
        full_text="A (Appellant) VS The State. Bail granted. Bench: X.",
        content_hash="h-row",
        raw={"file_status": "not_downloaded", "headnote_only": True},
    )
    report = load(engine, [headnote], "shc-meta@2")
    assert report.kept_full_text == 1
    stored = _rows(engine)[judgment(1)["id"]]
    assert stored["headnote_only"] is False
    assert stored["full_text"].startswith("Judgment 1.")
    # The other way round is an upgrade, and is applied.
    load(
        engine,
        [judgment(9, full_text="row only " * 10, content_hash="h-9r", raw={"headnote_only": True})],
        None,
    )
    assert load(engine, [judgment(9)], None).updated == 1
    assert _rows(engine)[judgment(9)["id"]]["headnote_only"] is False


@db
def test_skipped_records_are_counted_not_written(engine: Engine) -> None:
    report = load(
        engine, [record(full_text="short"), record(id="pakistan_code-b", source_url=None)], None
    )
    assert report.inserted == 0
    assert sum(report.skipped.values()) == 2
    assert _rows(engine) == {}


@db
def test_dry_run_writes_nothing(engine: Engine) -> None:
    assert load(engine, [record()], None, dry_run=True).read == 1
    assert _rows(engine) == {}
