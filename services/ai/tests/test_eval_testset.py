"""The evaluation test set (#22, PRD §11): its balance, the freeze, and gold resolution."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from caseguard_ai.eval import testset as ts


def test_the_committed_test_set_passes_the_structural_check() -> None:
    report = ts.check(ts.load())
    assert report.errors == []


def test_the_committed_splits_follow_prd_section_11() -> None:
    sets = ts.load()
    assert {k: len(v) for k, v in sets.items()} == {"dev": 60, "heldout": 40}
    every = [r for rows in sets.values() for r in rows]
    assert sum(not r["answerable"] for r in every) == 10
    assert sum("urdu" in r for r in every) >= 15


@pytest.fixture
def copy(tmp_path: Path) -> Path:
    for split in ts.SPLITS:
        shutil.copy(ts.ROOT / f"{split}.jsonl", tmp_path / f"{split}.jsonl")
    return tmp_path


def rewrite(root: Path, split: str, change: Any) -> None:
    path = root / f"{split}.jsonl"
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    change(rows)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def test_a_question_in_both_splits_is_refused(copy: Path) -> None:
    dev_q = ts.load(copy)["dev"][0]["question"]
    rewrite(copy, "heldout", lambda rows: rows[0].update(question=dev_q.upper() + "  "))
    assert any("same question" in e for e in ts.check(ts.load(copy), copy).errors)


def test_an_unbalanced_split_is_refused(copy: Path) -> None:
    def flip(rows: list[dict[str, Any]]) -> None:
        first_civil = next(r for r in rows if r["domain"] == "civil")
        first_civil["domain"] = "criminal"

    rewrite(copy, "dev", flip)
    assert any("half civil" in e for e in ts.check(ts.load(copy), copy).errors)


def test_an_unanswerable_question_needs_absent_terms_and_no_gold(copy: Path) -> None:
    def break_it(rows: list[dict[str, Any]]) -> None:
        row = next(r for r in rows if not r["answerable"])
        row["gold"] = [{"act": "PPC", "section": "302", "heading": "Punishment of qatl-i-amd"}]
        del row["absent_terms"]

    rewrite(copy, "dev", break_it)
    errors = ts.check(ts.load(copy), copy).errors
    assert any("no gold" in e for e in errors)
    assert any("absent_terms" in e for e in errors)


def test_urdu_stays_flagged_for_native_review(copy: Path) -> None:
    def unflag(rows: list[dict[str, Any]]) -> None:
        row = next(r for r in rows if "urdu" in r)
        row["needs_native_review"] = False

    rewrite(copy, "dev", unflag)
    assert any("needs_native_review" in e for e in ts.check(ts.load(copy), copy).errors)


def test_the_frozen_held_out_set_cannot_change(copy: Path) -> None:
    assert any("not frozen" in w for w in ts.check(ts.load(copy), copy).warnings)
    ts.freeze(copy)
    assert ts.check(ts.load(copy), copy).ok
    rewrite(copy, "heldout", lambda rows: rows[0].update(question="Changed after the freeze?"))
    assert any("FROZEN.sha256" in e for e in ts.check(ts.load(copy), copy).errors)


# --- gold resolution, against a fake corpus ---


def act(text: str, ids: dict[str, list[str]] | None = None) -> ts.Act:
    return ts.Act(text, ts.normalise(text), ids or {})


S500 = (
    "1500. Punishment for defamation. Whoever defames another shall be punished with simple "
    "imprisonment for a term which may extend to two years, or with fine, or with both."
)


def row(section: str, heading: str, reference: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": "dev-001",
        "gold": [{"act": "PPC", "section": section, "heading": heading}],
        "reference_answer": reference,
        **extra,
    }


def test_a_section_resolves_through_footnote_debris_and_a_glued_footnote_number() -> None:
    sets = {"dev": [row("500", "Punishment for defamation", S500[6:])]}
    report = ts.check_corpus(sets, {"PPC": act(S500, {"500": [S500]})}, {})
    assert report.ok and report.warnings == []


def test_a_hyphenated_section_matches_the_unhyphenated_corpus_form() -> None:
    text = "4[489F. Dishonestly issuing a cheque.__ Whoever dishonestly issues a cheque towards re-payment of a loan."
    sets = {
        "dev": [
            row(
                "489-F",
                "Dishonestly issuing a cheque",
                "Whoever dishonestly issues a cheque towards re-payment of a loan.",
            )
        ]
    }
    assert ts.check_corpus(sets, {"PPC": act(text)}, {}).ok


def test_a_wrong_heading_or_a_reference_not_in_the_act_is_an_error() -> None:
    corpus = {"PPC": act(S500)}
    wrong_heading = {"dev": [row("500", "Punishment for theft", S500[6:])]}
    assert any("not found" in e for e in ts.check_corpus(wrong_heading, corpus, {}).errors)
    made_up = {
        "dev": [
            row(
                "500",
                "Punishment for defamation",
                "The offender shall be fined ten rupees and released at once by the court.",
            )
        ]
    }
    assert any("only" in e for e in ts.check_corpus(made_up, corpus, {}).errors)


def test_a_section_the_chunker_did_not_tag_is_a_warning_not_an_error() -> None:
    sets = {"dev": [row("500", "Punishment for defamation", S500[6:])]}
    report = ts.check_corpus(sets, {"PPC": act(S500, {"334": [S500]})}, {})
    assert report.ok
    assert any("section_id 500" in w for w in report.warnings)


def test_an_absent_term_found_in_the_corpus_is_an_error() -> None:
    sets = {"dev": [{"id": "dev-060", "gold": [], "absent_terms": ["Theft Act 1968"]}]}
    assert ts.check_corpus(sets, {}, {"Theft Act 1968": 0}).ok
    assert not ts.check_corpus(sets, {}, {"Theft Act 1968": 2}).ok
