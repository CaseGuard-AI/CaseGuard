"""The knowledge graph build (#210, FR-GRAPH-1, PRD §9) and citation parsing.

A small synthetic corpus with known citations: the build must produce exactly the expected
edges, each with its provenance, and a re-run must change nothing.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, create_engine, text

from caseguard_ai.config import _sqlalchemy_url
from caseguard_ai.graph.build import build
from caseguard_ai.graph.citations import (
    find_citations,
    find_sections,
    normalise_citation,
    parse_section_label,
)
from caseguard_ai.graph.traverse import walk
from caseguard_ai.ingest.load import load
from tests.test_load import judgment, record

AI_URL = os.environ.get("AI_TEST_DATABASE_URL")
SERVICE_DIR = Path(__file__).resolve().parents[1]

CRPC = (
    "WHEREAS it is expedient; It is hereby enacted as follows:__\n"
    "497. When bail may be taken in case of non-bailable offence. Such person may be released.\n"
)

# ── citation parsing (no database) ─────────────────────────────────────────────────────────


def test_law_report_citations_are_found_once_each() -> None:
    text_ = "Relied on 2019 SCMR 984 and PLD 2023 SC 1; see also 2019  SCMR 984 and 2020 PCr.LJ 5."
    assert find_citations(text_) == ["2019 SCMR 984", "PLD 2023 SC 1", "2020 PCr.LJ 5"]


@pytest.mark.parametrize(
    ("a", "b"),
    [("2020 PCr.LJ 5", "2020 P Cr. L J 5"), ("PLD 2023 SC 1", "pld 2023 sc 1")],
)
def test_citation_spellings_normalise_alike(a: str, b: str) -> None:
    assert normalise_citation(a) == normalise_citation(b)


@pytest.mark.parametrize(
    ("text_", "labels"),
    [
        ("bail under section 497 Cr.P.C. was refused", ["s.497 CrPC"]),
        (
            "convicted u/s 302-B PPC and s. 34 of the Pakistan Penal Code",
            ["s.302B PPC", "s.34 PPC"],
        ),
        ("Order VII, section 9 of the Code of Civil Procedure, 1908", ["s.9 CPC"]),
        ("a petition under Article 199 of the Constitution", ["Art.199 Constitution"]),
        ("section 497 alone names no code", []),
    ],
)
def test_section_references_get_one_canonical_label(text_: str, labels: list[str]) -> None:
    assert [s.label for s in find_sections(text_)] == labels


@pytest.mark.parametrize("value", ["s.497 CrPC", "section 497 Cr.P.C.", "S. 497 crpc"])
def test_a_section_filter_parses_to_the_same_label(value: str) -> None:
    ref = parse_section_label(value)
    assert ref is not None and ref.label == "s.497 CrPC"


# ── the build ──────────────────────────────────────────────────────────────────────────────

pytestmark_db = pytest.mark.skipif(not AI_URL, reason="needs AI_TEST_DATABASE_URL (set in CI)")


def corpus() -> list[dict[str, Any]]:
    """Five judgments and the CrPC with known citations between them."""
    return [
        record(
            id="pakistan_code-crpc",
            title="Code of Criminal Procedure, 1898",
            source_url="https://pakistancode.gov.pk/english/crpc-sg-jjj",
            full_text=CRPC,
            content_hash="h-crpc",
        ),
        # 1 cites 2 in its text, an unreported case in metadata, s.497 CrPC, and is connected
        # to 3 by case number.
        judgment(
            1,
            title="Zephyr (Applicant) VS The State",
            citation="2020 SCMR 100",
            court="Sindh High Court",
            judgment_date="2020-03-01",
            full_text=(
                "2020 SCMR 100. Zephyr quarantine bail. Following PLD 2019 SC 50, bail under "
                "section 497 Cr.P.C. is granted where the case calls for further inquiry."
            ),
            cited_cases=["2018 YLR 77"],
            connected_cases=["Cr.B.A 12/2024"],
            content_hash="h-j1",
        ),
        judgment(
            2,
            title="Older (Appellant) VS The State",
            citation="PLD 2019 SC 50",
            court="Supreme Court of Pakistan",
            judgment_date="2019-01-10",
            full_text="Further inquiry under s. 497 CrPC is a question of the material on record.",
            content_hash="h-j2",
        ),
        judgment(
            3,
            title="Connected (Applicant) VS The State",
            citation="2021 MLD 5",
            case_number="Cr.B.A. 12/2024",
            court="Sindh High Court",
            judgment_date="2021-06-01",
            full_text="An unrelated order in the connected bail application, adjourned to a date.",
            content_hash="h-j3",
        ),
        # 4 explicitly overrules 2, in its metadata (§9.2).
        judgment(
            4,
            title="Larger Bench (Appellant) VS The State",
            citation="2022 SCMR 9",
            court="Supreme Court of Pakistan",
            judgment_date="2022-02-02",
            full_text="The earlier view is no longer good law and stands overruled by this bench.",
            raw={"file_status": "ok", "headnote_only": False, "overrules": ["PLD 2019 SC 50"]},
            content_hash="h-j4",
        ),
        # 5 cites the same section as 1 and nothing else.
        judgment(
            5,
            title="Sibling (Applicant) VS The State",
            citation="2023 YLR 11",
            court="Lahore High Court",
            judgment_date="2023-04-04",
            full_text="Bail was refused, the bar of section 497 Cr.P.C. being attracted on facts.",
            content_hash="h-j5",
        ),
    ]


def migrated_engine() -> Engine:
    url = _sqlalchemy_url(AI_URL or "")
    cfg = Config(str(SERVICE_DIR / "alembic.ini"))
    cfg.attributes["url"] = url
    command.upgrade(cfg, "head")
    return create_engine(url)


RESET = (
    "TRUNCATE corpus.documents, corpus.corpus_meta, corpus.graph_entities, ai.answer_traces CASCADE"
)


@pytest.fixture
def engine() -> Iterator[Engine]:
    eng = migrated_engine()
    with eng.begin() as conn:
        conn.execute(text(RESET))
    load(eng, corpus(), "p@1")
    yield eng
    with eng.begin() as conn:
        conn.execute(text(RESET))
    eng.dispose()


def ids(engine: Engine) -> dict[str, uuid.UUID]:
    """Collector id suffix ("1".."5", "crpc") → document id."""
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT collector_id, id FROM corpus.documents"))
        return {r.collector_id.split("-")[-1].lstrip("0") or "0": r.id for r in rows}


EDGES = text(
    """
    SELECT g.type, s.label AS src, d.label AS dst, d.type AS dst_type, d.ref_id AS dst_ref,
           g.extraction_method, g.confidence, g.human_confirmed, g.verification_status,
           g.provenance_doc_id, g.valid_from
      FROM corpus.graph_edges g
      JOIN corpus.graph_entities s ON s.id = g.src_entity
      JOIN corpus.graph_entities d ON d.id = g.dst_entity
     ORDER BY 1, 2, 3
    """
)


def edges(engine: Engine) -> list[Any]:
    with engine.connect() as conn:
        return list(conn.execute(EDGES))


@pytestmark_db
def test_a_sample_with_known_citations_gives_the_expected_edges(engine: Engine) -> None:
    report = build(engine)
    doc = ids(engine)
    got = {(e.type, e.src, e.dst, e.extraction_method) for e in edges(engine)}
    assert got == {
        ("CITES_JUDGMENT", "2020 SCMR 100", "PLD 2019 SC 50", "regex"),
        ("CITES_JUDGMENT", "2020 SCMR 100", "2018 YLR 77", "metadata"),
        ("CITES_SECTION", "2020 SCMR 100", "s.497 CrPC", "regex"),
        ("CITES_SECTION", "PLD 2019 SC 50", "s.497 CrPC", "regex"),
        ("CITES_SECTION", "2023 YLR 11", "s.497 CrPC", "regex"),
        ("CONNECTED_CASE", "2020 SCMR 100", "2021 MLD 5", "metadata"),
        ("OVERRULES", "2022 SCMR 9", "PLD 2019 SC 50", "metadata"),
    }
    assert report.edges == 7 and report.inserted == 7
    by = {(e.type, e.dst): e for e in edges(engine)}
    # Resolved citations point at the corpus record; an unresolved one is only a label.
    assert by[("CITES_JUDGMENT", "PLD 2019 SC 50")].dst_ref == doc["2"]
    assert by[("CITES_JUDGMENT", "2018 YLR 77")].dst_ref is None
    assert by[("CITES_JUDGMENT", "2018 YLR 77")].dst_type == "judgment"
    assert by[("CONNECTED_CASE", "2021 MLD 5")].dst_ref == doc["3"]
    # The section belongs to the statute in the corpus.
    assert by[("CITES_SECTION", "s.497 CrPC")].dst_type == "section"
    assert by[("CITES_SECTION", "s.497 CrPC")].dst_ref == doc["crpc"]


@pytestmark_db
def test_every_edge_carries_its_provenance(engine: Engine) -> None:
    build(engine)
    doc = ids(engine)
    for e in edges(engine):
        assert e.provenance_doc_id in doc.values()
        assert e.extraction_method in ("metadata", "regex")
        assert e.confidence == (
            1.0 if e.type == "OVERRULES" else 0.9 if e.extraction_method == "metadata" else 0.7
        )
        assert e.human_confirmed is False and e.verification_status == "unverified"
        assert e.valid_from is not None  # the citing judgment's decision date
    (cites,) = [
        e for e in edges(engine) if e.dst == "PLD 2019 SC 50" and e.type == "CITES_JUDGMENT"
    ]
    assert cites.provenance_doc_id == doc["1"]


@pytestmark_db
def test_overrules_comes_only_from_explicit_metadata(engine: Engine) -> None:
    build(engine)
    # Judgment 4's text says "overruled", but only its metadata made the edge.
    with engine.connect() as conn:
        n = conn.execute(text("SELECT count(*) FROM corpus.graph_edges WHERE type = 'OVERRULES'"))
        assert n.scalar_one() == 1


@pytestmark_db
def test_the_build_is_idempotent(engine: Engine) -> None:
    build(engine)
    before = edges(engine)
    with engine.connect() as conn:
        edge_ids = set(conn.execute(text("SELECT id FROM corpus.graph_edges")).scalars())
        entity_count = conn.execute(text("SELECT count(*) FROM corpus.graph_entities")).scalar()
    again = build(engine)
    assert (again.inserted, again.updated, again.removed) == (0, 0, 0)
    assert edges(engine) == before
    with engine.connect() as conn:
        assert set(conn.execute(text("SELECT id FROM corpus.graph_edges")).scalars()) == edge_ids
        assert (
            conn.execute(text("SELECT count(*) FROM corpus.graph_entities")).scalar()
            == entity_count
        )


@pytestmark_db
def test_a_rebuild_drops_what_the_corpus_no_longer_says_but_keeps_human_edges(
    engine: Engine,
) -> None:
    build(engine)
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE corpus.graph_edges SET human_confirmed = true WHERE type = 'OVERRULES'")
        )
        conn.execute(
            text(
                "UPDATE corpus.documents SET raw = raw - 'cited_cases' - 'overrules' "
                "WHERE collector_id LIKE 'shc_caselaw-%'"
            )
        )
    report = build(engine)
    # Only the cited_cases edge goes; the human-confirmed OVERRULES edge stays.
    assert report.removed == 1
    got = {(e.type, e.dst) for e in edges(engine)}
    assert ("CITES_JUDGMENT", "2018 YLR 77") not in got
    assert ("OVERRULES", "PLD 2019 SC 50") in got
    with engine.connect() as conn:
        orphan = conn.execute(
            text("SELECT count(*) FROM corpus.graph_entities WHERE label = '2018 YLR 77'")
        )
        assert orphan.scalar_one() == 0


@pytestmark_db
def test_traversal_stops_at_depth_two_and_goes_through_sections_only(engine: Engine) -> None:
    build(engine)
    doc = ids(engine)
    with engine.connect() as conn:
        (start,) = conn.execute(
            text("SELECT id FROM corpus.graph_entities WHERE key = :k"), {"k": f"doc:{doc['1']}"}
        ).scalars()
        paths = walk(conn, [start], ["CITES_SECTION"], max_depth=2, through=["section"])
        ends = {
            conn.execute(
                text("SELECT label FROM corpus.graph_entities WHERE id = :i"), {"i": p.end}
            ).scalar()
            for p in paths
            if p.depth == 2
        }
        assert ends == {"PLD 2019 SC 50", "2023 YLR 11"}
        assert all(p.depth <= 2 for p in paths)
        with pytest.raises(ValueError):
            walk(conn, [start], ["CITES_SECTION"], max_depth=3)
