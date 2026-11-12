"""Hybrid retrieval (#19): RRF, the reranked order, the trace, the model guard, and the scope.

The scope tests are the FR-CASE-6 marker-document test: a failure blocks release.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Connection, Engine, create_engine, text

from caseguard_ai.config import _sqlalchemy_url
from caseguard_ai.ingest.embed import run
from caseguard_ai.ingest.embedder import HashEmbedder
from caseguard_ai.ingest.load import load
from caseguard_ai.retrieval.guard import CorpusNotReady, EmbeddingMismatch
from caseguard_ai.retrieval.hybrid import Retrieval, Scope, retrieve, ts_query
from caseguard_ai.retrieval.reranker import OverlapReranker
from caseguard_ai.retrieval.rrf import fuse
from tests.test_load import judgment, record

# ── no database ────────────────────────────────────────────────────────────────────────────


def test_rrf_adds_one_over_k_plus_rank_from_each_list() -> None:
    fused = dict(fuse([["a", "b", "c"], ["b", "d"]], k=60))
    assert fused["b"] == pytest.approx(1 / 62 + 1 / 61)
    assert fused["a"] == pytest.approx(1 / 61)
    assert fused["d"] == pytest.approx(1 / 62)
    assert [item for item, _ in fuse([["a", "b", "c"], ["b", "d"]])] == ["b", "a", "d", "c"]


def test_rrf_ties_keep_first_seen_order() -> None:
    assert [i for i, _ in fuse([["x"], ["y"]])] == ["x", "y"]
    assert fuse([]) == []


def test_the_sparse_query_ors_plain_words_only() -> None:
    assert ts_query("What is the punishment under s.302 PPC?") == (
        "what | is | the | punishment | under | s | 302 | ppc"
    )
    assert ts_query("bail' & !(x | y) <-> :*") == "bail | x | y"
    assert ts_query("?!") == ""


def test_the_overlap_reranker_scores_shared_words() -> None:
    assert OverlapReranker().score("qatl punishment", ["punishment of qatl", "bail", ""]) == [
        1.0,
        0.0,
        0.0,
    ]


# ── database ───────────────────────────────────────────────────────────────────────────────

AI_URL = os.environ.get("AI_TEST_DATABASE_URL")
SERVICE_DIR = Path(__file__).resolve().parents[1]
db = pytest.mark.skipif(not AI_URL, reason="needs AI_TEST_DATABASE_URL (set in CI)")

PPC = (
    "WHEREAS it is expedient; It is hereby enacted as follows:__\n"
    "301. Culpable homicide by causing death of person other than person intended.\n"
    "302. Punishment of qatl-i-amd. Whoever commits qatl-i-amd shall be punished with death.\n"
    "303. Qatl committed under the influence of extreme provocation. Whoever commits qatl.\n"
)
CRPC = (
    "WHEREAS it is expedient; It is hereby enacted as follows:__\n"
    "496. In what cases bail to be taken. When any person other than a person accused of a "
    "non-bailable offence is arrested he shall be released on bail.\n"
    "497. When bail may be taken in case of non-bailable offence. Such person may be released.\n"
)
MARKER = "zebraquokka"  # a word no public document contains

USER_A, USER_B = uuid.uuid4(), uuid.uuid4()
CASE_X, CASE_Y, CASE_B = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()


@pytest.fixture
def engine() -> Iterator[Engine]:
    url = _sqlalchemy_url(AI_URL or "")
    cfg = Config(str(SERVICE_DIR / "alembic.ini"))
    cfg.attributes["url"] = url
    command.upgrade(cfg, "head")
    eng = create_engine(url)
    with eng.begin() as conn:
        conn.execute(text("TRUNCATE corpus.documents, corpus.corpus_meta, ai.case_chunks CASCADE"))
    load(
        eng,
        [
            record(full_text=PPC, content_hash="h-ppc"),
            record(
                id="pakistan_code-crpc",
                title="Code of Criminal Procedure, 1898",
                source_url="https://pakistancode.gov.pk/english/crpc-sg-jjj",
                full_text=CRPC,
                content_hash="h-crpc",
            ),
        ],
        "p@1",
    )
    run(eng, HashEmbedder())
    _case_chunk(eng, USER_A, CASE_X, f"Client statement in case X: {MARKER} bail punishment")
    _case_chunk(eng, USER_A, CASE_Y, f"Another case of the same user: {MARKER} bail punishment")
    _case_chunk(eng, USER_B, CASE_B, f"Someone else's case: {MARKER} bail punishment")
    # The same case id under another user must not leak either: scope is user AND case.
    _case_chunk(eng, USER_B, CASE_X, f"Other user, same case id: {MARKER} bail punishment")
    yield eng
    with eng.begin() as conn:
        conn.execute(text("TRUNCATE corpus.documents, corpus.corpus_meta, ai.case_chunks CASCADE"))
    eng.dispose()


def _case_chunk(engine: Engine, user: uuid.UUID, case: uuid.UUID, body: str) -> None:
    (vector,) = HashEmbedder().embed([body])
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO ai.case_chunks (user_id, case_id, document_id, ordinal, locator,"
                " text, token_count, chunker_version, embedding)"
                " VALUES (:u, :c, :d, 0, 'p. 1', :t, 10, '1', CAST(:v AS vector))"
            ),
            {"u": user, "c": case, "d": uuid.uuid4(), "t": body, "v": str(vector)},
        )


def _ask(conn: Connection, question: str, scope: Scope, **kw: int):  # type: ignore[no-untyped-def]
    return retrieve(conn, question, scope, HashEmbedder(), OverlapReranker(), **kw)


def scope(user: uuid.UUID = USER_A, *cases: uuid.UUID) -> Scope:
    return Scope(user_id=user, account_id=uuid.uuid4(), allowed_case_ids=tuple(cases))


@db
def test_the_matching_section_comes_first(engine: Engine) -> None:
    with engine.connect() as conn:
        result = _ask(conn, "What is the punishment of qatl-i-amd?", scope())
    top = result.passages[0]
    assert (top.locator, top.title, top.kind) == ("s. 302", "Pakistan Penal Code, 1860", "statute")
    assert top.official_url and top.official_url.startswith("https://pakistancode.gov.pk/")
    assert len(result.passages) <= 8


@db
def test_the_trace_keeps_both_lists_before_fusion_and_the_final_order(engine: Engine) -> None:
    with engine.connect() as conn:
        result = _ask(conn, "bail in a non-bailable offence", scope())
    trace = result.trace()
    assert trace["dense"] and trace["sparse"]  # FR-RES-2: both ranked lists, before fusion
    assert [e["rank"] for e in trace["fused"]] == list(range(1, len(trace["fused"]) + 1))
    assert all(set(e) == {"rank", "origin", "chunkId", "score"} for e in trace["dense"])
    # FR-RES-4: what goes to generation follows the reranker's scores.
    scores = [p.rerank_score for p in result.passages]
    assert scores == sorted(scores, reverse=True)
    assert [e["chunkId"] for e in trace["reranked"]] == [str(p.chunk_id) for p in result.passages]


@db
def test_the_sparse_search_finds_words_the_dense_one_might_miss(engine: Engine) -> None:
    with engine.connect() as conn:
        result = _ask(conn, "extreme provocation", scope())
    sparse_ids = [e["chunkId"] for e in result.sparse]
    s303 = next(p for p in result.passages if p.locator == "s. 303")
    assert str(s303.chunk_id) == sparse_ids[0]


# ── FR-CASE-6: the marker-document test ────────────────────────────────────────────────────


@pytest.fixture
def case_ids(engine: Engine) -> dict[tuple[uuid.UUID, uuid.UUID], str]:
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT id, user_id, case_id FROM ai.case_chunks")).all()
    return {(r.user_id, r.case_id): str(r.id) for r in rows}


def _case_chunks_seen(result) -> set[str]:  # type: ignore[no-untyped-def]
    """Every case chunk id anywhere in the result: passages and all three ranked lists."""
    seen = {str(p.chunk_id) for p in result.passages if p.origin == "case"}
    for name in ("dense", "sparse", "fused", "reranked"):
        seen |= {e["chunkId"] for e in result.trace()[name] if e["origin"] == "case"}
    return seen


@db
def test_no_case_is_searched_when_none_is_allowed(engine: Engine, case_ids) -> None:  # type: ignore[no-untyped-def]
    with engine.connect() as conn:
        result = _ask(conn, f"{MARKER} bail punishment", scope(USER_A))
    assert _case_chunks_seen(result) == set()
    assert not any(MARKER in p.text for p in result.passages)


@db
def test_only_the_allowed_case_of_the_caller_is_searched(engine: Engine, case_ids) -> None:  # type: ignore[no-untyped-def]
    with engine.connect() as conn:
        result = _ask(conn, f"{MARKER} bail punishment", scope(USER_A, CASE_X))
    assert _case_chunks_seen(result) == {case_ids[(USER_A, CASE_X)]}
    assert [p.case_id for p in result.passages if p.origin == "case"] == [CASE_X]


@db
def test_other_users_cases_never_leak_even_with_their_case_ids(engine: Engine, case_ids) -> None:  # type: ignore[no-untyped-def]
    with engine.connect() as conn:
        result = _ask(conn, f"{MARKER} bail punishment", scope(USER_A, CASE_X, CASE_Y, CASE_B))
    assert _case_chunks_seen(result) == {
        case_ids[(USER_A, CASE_X)],
        case_ids[(USER_A, CASE_Y)],
    }
    assert case_ids[(USER_B, CASE_B)] not in _case_chunks_seen(result)
    assert case_ids[(USER_B, CASE_X)] not in _case_chunks_seen(result)


# ── FR-RES-11: "law as of" date ────────────────────────────────────────────────────────────

AS_OF = date(2024, 1, 1)
BEFORE, AFTER, UNDATED = "Bail Before 1", "Bail After 2", "Bail Undated 3"
BAIL_QUESTION = "bail in a non-bailable offence"
WIDE: dict[str, Any] = {"fused_k": 50, "final_k": 50}  # keep every candidate in view


@pytest.fixture
def dated(engine: Engine) -> Engine:
    """Three bail judgments: decided before AS_OF, after it, and on an unknown date."""
    body = "Bail application in a non-bailable offence: the accused is released on bail."
    load(
        engine,
        [
            judgment(1, title=BEFORE, judgment_date="2023-06-01", full_text=f"{BEFORE}. {body}"),
            judgment(2, title=AFTER, judgment_date="2025-03-01", full_text=f"{AFTER}. {body}"),
            judgment(3, title=UNDATED, judgment_date=None, full_text=f"{UNDATED}. {body}"),
        ],
        "shc@1",
    )
    run(engine, HashEmbedder())
    return engine


def _retrieve(conn: Connection, law_as_of: date | None) -> Retrieval:
    return retrieve(
        conn, BAIL_QUESTION, scope(), HashEmbedder(), OverlapReranker(), law_as_of=law_as_of, **WIDE
    )


def _titles(conn: Connection, result: Retrieval) -> set[str]:
    """Titles of every corpus document either search found, before fusion."""
    ids = [e["chunkId"] for e in result.dense + result.sparse if e["origin"] == "corpus"]
    rows = conn.execute(
        text(
            "SELECT DISTINCT d.title FROM corpus.chunks c JOIN corpus.documents d"
            " ON d.id = c.document_id WHERE c.id = ANY(CAST(:ids AS uuid[]))"
        ),
        {"ids": ids},
    )
    return {r.title for r in rows}


@db
def test_a_law_as_of_date_leaves_out_later_judgments_only(dated: Engine) -> None:
    with dated.connect() as conn:
        result = _retrieve(conn, AS_OF)
        titles = _titles(conn, result)
    assert AFTER not in titles
    # Earlier and undated judgments stay in, and so do statutes (not versioned yet).
    assert {BEFORE, UNDATED, "Code of Criminal Procedure, 1898"} <= titles
    assert AFTER not in {p.title for p in result.passages}


@db
def test_without_a_date_retrieval_is_unchanged(dated: Engine) -> None:
    with dated.connect() as conn:
        plain = retrieve(conn, BAIL_QUESTION, scope(), HashEmbedder(), OverlapReranker(), **WIDE)
        none = _retrieve(conn, None)
        late = _retrieve(conn, date(2100, 1, 1))  # nothing is later, so nothing is left out
        titles = _titles(conn, plain)
    assert {BEFORE, AFTER, UNDATED} <= titles
    assert plain.trace() == none.trace() == late.trace()
    assert plain.passages == none.passages == late.passages


# ── the model guard ────────────────────────────────────────────────────────────────────────


class OtherModel(HashEmbedder):
    revision = "2"


@db
def test_a_query_model_that_differs_from_the_corpus_is_refused(engine: Engine) -> None:
    with engine.connect() as conn, pytest.raises(EmbeddingMismatch, match="EMBEDDING_REVISION"):
        retrieve(conn, "bail", scope(), OtherModel(), OverlapReranker())


@db
def test_a_corpus_that_was_never_embedded_is_refused(engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE corpus.corpus_meta"))
    with engine.connect() as conn, pytest.raises(CorpusNotReady, match="data:embed"):
        _ask(conn, "bail", scope())
