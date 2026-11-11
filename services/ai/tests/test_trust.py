"""Status rules, the existence check and reply parsing (#20). No database needed."""

from __future__ import annotations

import itertools
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from caseguard_ai.research.parse import parse_reply
from caseguard_ai.retrieval.hybrid import Passage
from caseguard_ai.trust.existence import find_span
from caseguard_ai.trust.status import (
    BLOCKING_FLAGS,
    NON_BLOCKING_FLAGS,
    decide,
    is_stale,
    source_flags,
)

# ── status (PRD §7.2): every branch ────────────────────────────────────────────────────────


@pytest.mark.parametrize("support", ["pass", "uncertain", "fail", "not_run"])
def test_a_failed_existence_is_unverified_whatever_else(support: str) -> None:
    assert decide("fail", support, ["repealed"]) == "unverified"  # type: ignore[arg-type]
    assert decide("fail", support) == "unverified"  # type: ignore[arg-type]


@pytest.mark.parametrize("support", ["uncertain", "fail", "not_run"])
def test_existence_without_a_passed_support_check_needs_review(support: str) -> None:
    assert decide("pass", support) == "needs_review"  # type: ignore[arg-type]


@pytest.mark.parametrize("flag", sorted(BLOCKING_FLAGS))
def test_a_blocking_flag_needs_review_even_when_supported(flag: str) -> None:
    assert decide("pass", "pass", [flag]) == "needs_review"


@pytest.mark.parametrize("flag", sorted(NON_BLOCKING_FLAGS))
def test_only_existence_and_support_with_no_blocking_flag_is_verified(flag: str) -> None:
    assert decide("pass", "pass") == "verified"
    assert decide("pass", "pass", [flag]) == "verified"


def test_m1_never_shows_verified() -> None:
    # FR-TRUST-8: the support check is not run in M1, so no combination reaches "verified".
    flag_sets = [[], ["headnote_only"], ["third_party_source"]]
    results = {decide(e, "not_run", f) for e, f in itertools.product(["pass", "fail"], flag_sets)}  # type: ignore[arg-type]
    assert results == {"needs_review", "unverified"}


def test_an_unknown_flag_is_refused() -> None:
    with pytest.raises(ValueError, match="unknown flag"):
        decide("pass", "pass", ["looks_fine"])


def test_source_flags() -> None:
    assert source_flags(headnote_only=False, third_party=False) == []
    assert source_flags(headnote_only=True, third_party=True) == [
        "headnote_only",
        "third_party_source",
    ]


# ── stale (FR-TRUST-6) ─────────────────────────────────────────────────────────────────────

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("retrieved_at", "flags"),
    [
        (NOW - timedelta(days=181), ["stale"]),  # older than the window
        (NOW - timedelta(days=180), []),  # exactly the window: still current
        (NOW - timedelta(days=3), []),
        (None, ["stale"]),  # never dated: its age is unknown, so it is not shown as current
    ],
)
def test_a_source_older_than_the_review_window_is_stale(
    retrieved_at: datetime | None, flags: list[str]
) -> None:
    assert is_stale(retrieved_at, NOW, 180) is bool(flags)
    got = source_flags(
        headnote_only=False, third_party=False, retrieved_at=retrieved_at, now=NOW, stale_days=180
    )
    assert got == flags


def test_stale_is_only_checked_when_a_window_is_given() -> None:
    # Case passages are passed without a window: no retrieval date, never stale.
    assert source_flags(headnote_only=False, third_party=False, retrieved_at=None, now=NOW) == []


def test_stale_comes_after_the_other_source_flags() -> None:
    got = source_flags(headnote_only=True, third_party=True, now=NOW, stale_days=180)
    assert got == ["headnote_only", "third_party_source", "stale"]


@pytest.mark.parametrize("support", ["pass", "not_run"])
def test_stale_never_changes_the_status(support: str) -> None:
    for existence in ("pass", "fail"):
        assert decide(existence, support, ["stale"]) == decide(existence, support)  # type: ignore[arg-type]


# ── existence: the verbatim span ───────────────────────────────────────────────────────────

CHUNK = "302. Punishment of qatl-i-amd. Whoever commits qatl-i-amd shall,\nsubject to this Chapter, be punished with death."


def test_a_quote_across_a_line_break_resolves_to_the_source_span() -> None:
    span = find_span(CHUNK, "“shall, subject to this Chapter, be punished”")
    assert span == "shall,\nsubject to this Chapter, be punished"
    assert span is not None and span in CHUNK  # byte for byte (FR-RES-10)


@pytest.mark.parametrize(
    "quote",
    [
        "shall be punished with death",  # words left out
        "Shall, subject to this chapter",  # case changed
        "shall subject to this Chapter",  # punctuation dropped
        "",
    ],
)
def test_anything_but_whitespace_must_match_exactly(quote: str) -> None:
    assert find_span(CHUNK, quote) is None


def _passage() -> Passage:
    return Passage(
        origin="case",  # a case chunk: no corpus lookup needed
        chunk_id=uuid.uuid4(),
        document_id=uuid.uuid4(),
        text=CHUNK,
        locator="p. 1",
        section_id=None,
        headnote_only=False,
        third_party=False,
    )


def test_existence_needs_a_retrieved_passage_and_a_real_quote() -> None:
    from caseguard_ai.trust.existence import check

    conn = None  # case chunks never query the corpus
    assert check(conn, None, "anything at all here").reason.startswith("the cited passage")  # type: ignore[arg-type]
    assert check(conn, _passage(), None).reason == "no verbatim quote was given"  # type: ignore[arg-type]
    assert check(conn, _passage(), "death").reason == "no verbatim quote was given"  # type: ignore[arg-type]
    assert (
        check(conn, _passage(), "punished with life").reason
        == "the quote is not in the cited passage"
    )  # type: ignore[arg-type]
    ok = check(conn, _passage(), "be punished with death")  # type: ignore[arg-type]
    assert (ok.passed, ok.span) == (True, "be punished with death")


# ── parsing the model's reply ──────────────────────────────────────────────────────────────


def test_markers_claims_and_quotes_are_read() -> None:
    reply = parse_reply(
        "ANSWER:\nQatl-i-amd is punishable with death [[p:1]]. Bail is discretionary [[ p : 3 ]].\n"
        'QUOTES:\n[p:1] "punished with death"\n[p:3]: “may be released on bail”\n'
    )
    assert reply.answerable
    assert [(m.passage, m.claim) for m in reply.markers] == [
        (1, "Qatl-i-amd is punishable with death."),
        (3, "Bail is discretionary."),
    ]
    assert reply.quotes == {1: '"punished with death"', 3: "“may be released on bail”"}


def test_a_reply_without_headings_still_counts() -> None:
    reply = parse_reply("Bail may be refused [[p:2]].")
    assert reply.answerable and reply.markers[0].passage == 2 and reply.quotes == {}


@pytest.mark.parametrize(
    "raw",
    ["NOT_ANSWERABLE", "  not_answerable.", "ANSWER:\nThe law is clear on this.\nQUOTES:\n", ""],
)
def test_not_answerable_or_uncited_replies_are_unanswerable(raw: str) -> None:
    assert parse_reply(raw).answerable is False
