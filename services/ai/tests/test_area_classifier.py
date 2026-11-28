"""The statute→area classifier and its review (#200, docs/engineering/case-taxonomy.md §5, §6)."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Engine, text

from caseguard_ai.taxonomy import classify as classify_module
from caseguard_ai.taxonomy.classify import (
    AREA_KEYWORDS,
    STATUTE_ALIASES,
    SUBCATEGORY_KEYWORDS,
    Classifier,
    tie_break,
)
from caseguard_ai.taxonomy.review import (
    GOLD_COLUMNS,
    Candidate,
    format_score,
    read_sample,
    score,
    stratified,
    write_sample,
)
from caseguard_ai.taxonomy.rules import (
    UNCLASSIFIED,
    find_taxonomy_file,
    load_taxonomy,
    section_key,
)

TAXONOMY = load_taxonomy()
FILLER = " The learned counsel addressed the Court at length on the facts. " * 40  # ~2.6k chars


@pytest.fixture(scope="module")
def classifier() -> Classifier:
    return Classifier(TAXONOMY)


# ── the taxonomy file ──────────────────────────────────────────────────────────────────────


def test_the_taxonomy_file_is_found_from_the_repo_root_and_the_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = find_taxonomy_file()
    for cwd in (repo.parents[3], repo.parents[3] / "services" / "ai"):
        monkeypatch.chdir(cwd)
        assert find_taxonomy_file() == repo
    assert TAXONOMY.version == "v1"


@pytest.mark.parametrize(
    ("value", "key"),
    [("302", (302, "")), ("338-H", (338, "H")), ("489F", (489, "F")), ("377 b", (377, "B"))],
)
def test_section_numbers_parse(value: str, key: tuple[int, str]) -> None:
    assert section_key(value) == key


@pytest.mark.parametrize(
    ("number", "area", "subcategory"),
    [
        ("302", "offences_against_person", None),
        ("338-H", "offences_against_person", None),
        ("302-B", "offences_against_person", None),
        ("365-A", "offences_against_person", "kidnapping_abduction"),
        ("377-B", "offences_against_person", "sexual_offences"),
        ("489-F", "offences_against_property", "dishonoured_cheque"),
        ("489-C", "documents_and_forgery", "counterfeiting"),
        ("477-A", "documents_and_forgery", "forgery"),
        ("148", "public_order_and_state", None),
    ],
)
def test_ppc_ranges_are_inclusive_with_lettered_sections(
    number: str, area: str, subcategory: str | None
) -> None:
    rule = TAXONOMY.section_rule("PPC", number)
    assert rule is not None and (rule.area, rule.subcategory) == (area, subcategory)


@pytest.mark.parametrize("number", ["34", "489", "338-I", "120-B"])
def test_ppc_sections_outside_every_range_have_no_rule(number: str) -> None:
    assert TAXONOMY.section_rule("PPC", number) is None


def test_code_tables_name_only_statutes_and_areas_in_the_taxonomy() -> None:
    statutes = {r.statute for r in TAXONOMY.rules}
    assert set(STATUTE_ALIASES) <= statutes
    assert set(AREA_KEYWORDS) <= set(TAXONOMY.areas)
    for area, subs in SUBCATEGORY_KEYWORDS.items():
        assert set(subs) <= set(TAXONOMY.areas[area].subcategories), area
    Classifier(TAXONOMY)  # checks the PPC sub-category hints against the file


# ── the classifier (§5) ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("judgment", "area", "subcategory"),
    [
        # PPC lists, the usual way offences are charged, and the sub-category hint.
        (
            "FIR No.12 for offences under sections 302, 324, 34 PPC.",
            "offences_against_person",
            "homicide",
        ),
        (
            "charged u/s 489-F P.P.C. for a dishonoured cheque",
            "offences_against_property",
            "dishonoured_cheque",
        ),
        (
            "crime registered under section 365-A PPC",
            "offences_against_person",
            "kidnapping_abduction",
        ),
        ("offence under sections 395/397 PPC", "offences_against_property", "robbery_dacoity"),
        # Statutes outside the codes, by name and short form.
        ("booked under Sections 6/9 (i) 3 (e), 14 & 15CNS Act, 1997", "narcotics", None),
        ("an application under section 25 of the G&W Act", "family", "custody_guardianship"),
        (
            "bail in crime No.186/2014 for the offence under section 9 (c) of CNS Act, 1997.",
            "narcotics",
            None,
        ),
        ("charged under section 7 of the Anti-Terrorism Act, 1997", "terrorism", None),
        (
            "ejectment application under section 15 of the SRPO 1979",
            "rent_and_tenancy",
            "ejectment",
        ),
        ("a reference under the Income Tax Ordinance, 2001", "tax_customs_revenue", "income_tax"),
    ],
)
def test_statutes_decide_the_area(
    classifier: Classifier, judgment: str, area: str, subcategory: str | None
) -> None:
    label = classifier.classify(judgment)
    assert (label.area, label.subcategory) == (area, subcategory), label
    assert label.reason == "clear lead"
    assert label.confidence > 0.5


def test_procedural_law_alone_is_unclassified(classifier: Classifier) -> None:
    label = classifier.classify("Bail under section 497 Cr.P.C. and Order VII rule 11 CPC.")
    assert label.area == UNCLASSIFIED and label.reason == "procedural law only"
    assert {e.area for e in label.evidence} == {"procedure"}  # the evidence is kept


def test_no_statute_is_unclassified_never_a_guess(classifier: Classifier) -> None:
    label = classifier.classify("The khula suit for dissolution of marriage was decreed.")
    assert label.area == UNCLASSIFIED and label.reason == "no statute evidence"


def test_cited_laws_from_the_collector_count(classifier: Classifier) -> None:
    label = classifier.classify(
        "The bail application is allowed.", cited_laws=["Narcotic Substances Act, 1997"]
    )
    assert label.area == "narcotics"
    assert label.evidence[0].where == "cited_laws"


def test_a_section_in_a_cited_precedent_counts_less_than_the_charge(classifier: Classifier) -> None:
    judgment = (
        "The applicant seeks bail in a case under section 9(c) of the CNS Act."
        + FILLER
        + "In the case of Muhammad Ali reported as 2019 SCMR 984 the accused was charged"
        " under sections 302, 324 PPC. Again 2020 YLR 5 dealt with section 395 PPC." + FILLER
    )
    label = classifier.classify(judgment)
    assert label.area == "narcotics"
    wheres = {e.ref: e.where for e in label.evidence}
    assert wheres["s.302 PPC"] == "precedent"
    assert wheres["Control of Narcotic Substances Act 1997"] == "operative"


def test_precedent_mentions_alone_are_too_weak(classifier: Classifier) -> None:
    judgment = FILLER + "Reliance is placed on 2019 SCMR 984 (section 302 PPC)." + FILLER
    label = classifier.classify(judgment)
    assert label.area == UNCLASSIFIED and label.leader == "offences_against_person"


def test_keywords_only_break_a_tie(classifier: Classifier) -> None:
    tie = "The suit under the Specific Relief Act and the Transfer of Property Act."
    assert classifier.classify(tie).area == UNCLASSIFIED
    # One keyword (2.5 v 2.0) is not a clear lead; two (3.0 v 2.0) are.
    one = classifier.classify(tie + " The plaintiff seeks pre-emption of the land.")
    assert one.area == UNCLASSIFIED and one.reason == "no clear lead"
    label = classifier.classify(
        tie + " The plaintiff seeks pre-emption, as the pre-emption suit precedes any partition."
    )
    assert (label.area, label.reason) == ("property_and_land", "keyword tie-break")
    assert label.subcategory == "pre_emption"
    assert label.keywords == ("property_and_land:pre-?emption", "property_and_land:partitions?")


@pytest.mark.parametrize(
    ("hits", "winner"),
    [
        ({"c": 1}, None),  # the runner-up's hit must not crown the leader (#257 review)
        ({"c": 2}, None),  # c leads 2.4 v 2.0, but not by CLEAR_LEAD
        ({"c": 4}, "c"),  # 3.4 v 2.0
        ({"a": 1}, "a"),  # the leader's own hit: 2.5 v 1.5
    ],
)
def test_a_tie_break_needs_the_winners_own_keywords_and_a_clear_lead(
    hits: dict[str, int], winner: str | None
) -> None:
    scores = {"a": 2.0, "b": 1.5, "c": 1.4}
    assert tie_break(scores, hits, grounded={"a", "b", "c"})[0] == winner


def test_a_tie_break_never_crowns_an_area_with_only_precedent_mentions() -> None:
    assert tie_break({"a": 2.0, "b": 2.0}, {"a": 4}, grounded={"b"})[0] is None
    assert tie_break({"a": 2.0, "b": 2.0}, {"a": 4}, grounded={"a", "b"})[0] == "a"


def test_min_score_needs_a_reference_outside_precedent_mentions(
    classifier: Classifier, monkeypatch: pytest.MonkeyPatch
) -> None:
    # With precedent mentions weighted up, three person ranges reach MIN_SCORE (1.5), but all
    # sit beside a citation: still too weak.
    monkeypatch.setitem(classify_module.WEIGHTS, "precedent", 0.5)
    judgment = FILLER + "Reliance is placed on 2019 SCMR 984 (sections 302, 365, 376 PPC)." + FILLER
    label = classifier.classify(judgment)
    assert label.scores == {"offences_against_person": 1.5}
    assert (label.area, label.reason) == (UNCLASSIFIED, "weak evidence (precedent mentions only)")


def test_the_relief_act_is_not_its_own_relief_cue(classifier: Classifier) -> None:
    plain = classifier.classify(FILLER + "Section 12 of the Specific Relief Act applies." + FILLER)
    assert plain.evidence[0].where == "body"
    assert plain.scores == {"contract_and_commercial": 1.0}
    sought = classifier.classify(
        FILLER + "The relief sought under the Specific Relief Act is a decree." + FILLER
    )
    assert sought.evidence[0].where == "operative"


def test_a_head_note_statute_beside_a_cited_case_keeps_the_head_note_weight(
    classifier: Classifier,
) -> None:
    headnote = "Bail under s. 9(c) CNSA refused; 2019 SCMR 984 relied upon."
    label = classifier.classify("listing", headnote=headnote, headnote_only=True)
    assert label.area == "narcotics"
    assert (label.evidence[0].where, label.evidence[0].weight) == ("headnote", 1.5)


def test_keywords_match_plurals(classifier: Classifier) -> None:
    tie = "Under the SRPO and the Transfer of Property Act."
    label = classifier.classify(tie + " The tenants and the landlords disagree.")
    assert (label.area, label.reason) == ("rent_and_tenancy", "keyword tie-break")
    assert any(re.fullmatch(p, "pistols") for p in AREA_KEYWORDS["arms_and_explosives"])


def test_a_charge_list_counts_each_ppc_range_once(classifier: Classifier) -> None:
    # 302 and 324 share one range, 147/148/149 another: 2.0 v 2.0, decided by two keywords.
    judgment = "FIR for offences under sections 302, 324, 147, 148, 149 PPC."
    label = classifier.classify(judgment)
    assert label.area == UNCLASSIFIED and label.reason == "no clear lead"
    label = classifier.classify(judgment + " The accused committed the murder and caused injuries.")
    assert (label.area, label.subcategory) == ("offences_against_person", "homicide")
    assert label.reason == "keyword tie-break"


def test_a_clear_lead_wins_over_a_lesser_area(classifier: Classifier) -> None:
    judgment = "FIR under sections 302 and 376 PPC; also section 7 ATA." + FILLER
    label = classifier.classify(judgment)
    # Two person ranges (homicide, sexual offences) at 2.0 each against one terrorism one.
    assert label.area == "offences_against_person"
    assert label.scores == {"offences_against_person": 4.0, "terrorism": 2.0}


def test_head_note_only_records_use_the_head_note(classifier: Classifier) -> None:
    listing = "A (Applicant) VS The State. Hon'ble Mr. Justice B"
    label = classifier.classify(
        listing, headnote="Bail under s. 9(c) CNSA refused.", headnote_only=True
    )
    assert label.area == "narcotics" and label.evidence[0].where == "headnote"
    none = classifier.classify(listing + " section 302 PPC", headnote=None, headnote_only=True)
    assert none.area == UNCLASSIFIED and none.reason == "head-note only, without a head-note"


def test_the_label_is_deterministic_and_carries_the_version(classifier: Classifier) -> None:
    judgment = "offence under sections 302, 34 PPC"
    a, b = classifier.classify(judgment), classifier.classify(judgment)
    assert a == b
    raw = a.as_raw("v1")
    assert raw["taxonomy_version"] == "v1" and raw["area"] == "offences_against_person"
    assert raw["evidence"][0]["ref"] == "s.302 PPC"
    json.dumps(raw)  # storable as jsonb


def test_the_module_function_uses_the_v1_file() -> None:
    assert classify_module.classify("u/s 9(c) CNSA").area == "narcotics"


# ── the review (§6) ────────────────────────────────────────────────────────────────────────


def candidates() -> list[Candidate]:
    out = [Candidate(f"cp-{i:03d}", "Const. P", "Karachi") for i in range(100)]
    out += [Candidate(f"bail-k-{i}", "Cr.Bail", "Karachi") for i in range(10)]
    out += [Candidate(f"bail-s-{i}", "Cr.Bail", "Bench at Sukkur") for i in range(10)]
    out += [Candidate("suit-1", "Suit", "Karachi")]
    return out


def test_the_sample_spreads_over_proceedings_and_benches() -> None:
    picked = stratified(candidates(), 9, seed=1)
    proceedings = [c.proceeding for c in picked]
    assert proceedings.count("Suit") == 1  # a small stratum is not drowned out
    assert proceedings.count("Cr.Bail") == 4 and proceedings.count("Const. P") == 4
    bail_benches = [c.bench for c in picked if c.proceeding == "Cr.Bail"]
    assert bail_benches.count("Karachi") == bail_benches.count("Bench at Sukkur") == 2
    assert stratified(candidates(), 9, seed=1) == picked  # reproducible
    assert len(stratified(candidates(), 500)) == len(candidates())


def test_sample_csv_round_trips_and_scores(tmp_path: Path) -> None:
    rows: list[dict[str, Any]] = [
        {"document_id": "1", "predicted_area": "narcotics"},
        {"document_id": "2", "predicted_area": "narcotics"},
        {"document_id": "3", "predicted_area": UNCLASSIFIED},
        {"document_id": "4", "predicted_area": "family", "predicted_subcategory": "khula"},
        {"document_id": "5", "predicted_area": "family"},
    ]
    path = tmp_path / "review.csv"
    assert write_sample(rows, path) == 5
    filled = read_sample(path)
    assert all(filled[0][c] == "" for c in GOLD_COLUMNS)
    gold = ["narcotics", "terrorism", "family", "family", "", "made_up"]
    for row, g in zip(filled, gold, strict=False):
        row["gold_area"] = g
    filled[3]["gold_subcategory"] = "khula"
    filled.append({"document_id": "6", "predicted_area": "family", "gold_area": "made_up"})

    result = score(filled, list(TAXONOMY.areas))
    assert (result.labelled, result.correct, result.unlabelled) == (4, 2, 1)
    assert result.invalid == ["6: made_up"]
    assert result.areas["narcotics"].precision == 0.5 and result.areas["narcotics"].recall == 1.0
    assert result.areas["family"].recall == 0.5 and result.areas["terrorism"].recall == 0.0
    assert result.unclassified_rate == 0.25
    assert result.subcategory_correct == result.subcategory_checked == 1
    assert not result.meets_bar
    table = format_score(result)
    assert "| narcotics | 1 | 2 | 1 | 50% | 100% |" in table
    assert "**not met**" in table and "Unclassified rate: 25%" in table


# ── the corpus pass (database) ─────────────────────────────────────────────────────────────

AI_URL = os.environ.get("AI_TEST_DATABASE_URL")


def _records(
    first_text: str = "Bail for the offence under section 9(c) of CNS Act, 1997. ",
    first_hash: str = "a1",
) -> list[dict[str, Any]]:
    from tests.test_load import judgment

    return [
        judgment(1, full_text=first_text * 3, content_hash=first_hash),
        judgment(
            2,
            full_text="Bail under section 497 Cr.P.C. was refused on the facts. " * 3,
            content_hash="a2",
        ),
    ]


@pytest.fixture
def engine() -> Iterator[Engine]:
    from caseguard_ai.ingest.load import load
    from tests.test_graph import RESET, migrated_engine

    eng = migrated_engine()
    with eng.begin() as conn:
        conn.execute(text(RESET))
    load(eng, _records(), "p@1")
    yield eng
    with eng.begin() as conn:
        conn.execute(text(RESET))
    eng.dispose()


@pytest.mark.skipif(not AI_URL, reason="needs AI_TEST_DATABASE_URL (set in CI)")
def test_the_corpus_pass_writes_labels_and_keeps_other_raw_keys(engine: Engine) -> None:
    from caseguard_ai.taxonomy.cli import run

    areas, _, written = run(engine, TAXONOMY, batch_size=1, dry_run=True)
    assert written == 0 and areas == {"narcotics": 1, UNCLASSIFIED: 1}
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(area) FROM corpus.documents")).scalar() == 0

    _, _, written = run(engine, TAXONOMY, batch_size=1)
    assert written == 2
    with engine.connect() as conn:
        rows = {
            r.case_number: r
            for r in conn.execute(
                text("SELECT case_number, area, subcategory, raw FROM corpus.documents")
            )
        }
    narcotics = rows["1/2024"]
    assert (narcotics.area, narcotics.subcategory) == ("narcotics", None)
    assert narcotics.raw["file_status"] == "ok"  # other raw keys kept
    label = narcotics.raw["area_label"]
    assert label["taxonomy_version"] == "v1" and label["confidence"] > 0
    assert label["evidence"][0]["ref"] == "Control of Narcotic Substances Act 1997"
    assert rows["2/2024"].area == UNCLASSIFIED

    assert run(engine, TAXONOMY)[2] == 0  # a re-run changes nothing


@pytest.mark.skipif(not AI_URL, reason="needs AI_TEST_DATABASE_URL (set in CI)")
def test_a_reload_keeps_the_area_label(engine: Engine) -> None:
    """#257 review: the loader replaced raw on upsert, dropping raw.area_label."""
    from caseguard_ai.ingest.load import load
    from caseguard_ai.taxonomy.cli import run

    run(engine, TAXONOMY)
    report = load(engine, _records(), "p@1")  # the same rows again
    assert (report.inserted, report.updated, report.unchanged) == (0, 0, 2)

    # A changed record is updated, and keeps its label until the classifier runs again.
    revised = _records("Bail under section 9(c) CNSA, the text revised. ", "a1-revised")
    report = load(engine, revised, "p@1")
    assert (report.inserted, report.updated) == (0, 1)
    with engine.connect() as conn:
        raws = {
            r.case_number: r.raw
            for r in conn.execute(text("SELECT case_number, raw FROM corpus.documents"))
        }
    assert raws["1/2024"]["area_label"]["area"] == "narcotics"
    assert raws["1/2024"]["file_status"] == "ok"
    assert raws["2/2024"]["area_label"]["area"] == UNCLASSIFIED
    assert run(engine, TAXONOMY)[2] == 1  # only the revised judgment's evidence changed


def test_a_sample_of_zero_is_refused_before_touching_the_database(
    capsys: pytest.CaptureFixture[str],
) -> None:
    from caseguard_ai.taxonomy.cli import main

    with pytest.raises(SystemExit) as exit_:
        main(["--sample", "0"])
    assert exit_.value.code == 2
    assert "--sample needs at least 1" in capsys.readouterr().err
