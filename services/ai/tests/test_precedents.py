"""POST /ai/v1/precedents/search and GET /ai/v1/precedents/{sourceId}/relationships (#210).

The synthetic corpus of ``test_graph`` (known citations between five judgments), embedded with
HashEmbedder and ranked by OverlapReranker. In a corpus this small, dense retrieval returns
every embedded chunk, so a test controls what is *retrieved* by keeping chunks only for some
judgments; the rest can only arrive through the graph. Every 200 is checked against ai.v1.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from caseguard_ai.api import deps
from caseguard_ai.config import get_settings
from caseguard_ai.graph.build import build
from caseguard_ai.ingest.embed import run
from caseguard_ai.ingest.embedder import HashEmbedder
from caseguard_ai.ingest.load import load
from caseguard_ai.main import app
from caseguard_ai.retrieval.reranker import OverlapReranker
from tests.conftest import TOKEN
from tests.test_answer import conforms
from tests.test_graph import RESET, corpus, ids, migrated_engine

AI_URL = os.environ.get("AI_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not AI_URL, reason="needs AI_TEST_DATABASE_URL (set in CI)")

AUTH = {"Authorization": f"Bearer {TOKEN}"}
QUERY = "zephyr quarantine bail"


@pytest.fixture
def engine() -> Iterator[Engine]:
    eng = migrated_engine()
    with eng.begin() as conn:
        conn.execute(text(RESET))
    load(eng, corpus(), "p@1")
    run(eng, HashEmbedder())
    build(eng)
    yield eng
    with eng.begin() as conn:
        conn.execute(text(RESET))
    eng.dispose()


@pytest.fixture
def client(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("AI_SERVICE_TOKEN", TOKEN)
    get_settings.cache_clear()
    app.dependency_overrides[deps.get_engine] = lambda: engine
    app.dependency_overrides[deps.get_embedder] = HashEmbedder
    app.dependency_overrides[deps.get_reranker] = OverlapReranker
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    get_settings.cache_clear()


@pytest.fixture
def doc(engine: Engine) -> dict[str, uuid.UUID]:
    return ids(engine)


@pytest.fixture
def retrievable(engine: Engine, doc: dict[str, uuid.UUID]) -> Callable[..., None]:
    """Keep chunks only for the given judgments, so only they can be retrieved."""

    def _keep(*names: str) -> None:
        keep = [doc[n] for n in names]
        with engine.begin() as conn:
            conn.execute(
                text(
                    "DELETE FROM corpus.chunks c USING corpus.documents d "
                    "WHERE d.id = c.document_id AND d.kind = 'judgment' "
                    "AND NOT d.id = ANY(CAST(:keep AS uuid[]))"
                ),
                {"keep": [str(k) for k in keep]},
            )

    return _keep


def search(client: TestClient, **overrides: Any) -> Any:
    body = {"requestId": str(uuid.uuid4()), "query": QUERY, **overrides}
    r = client.post("/ai/v1/precedents/search", json=body, headers=AUTH)
    if r.status_code == 200:
        conforms("PrecedentSearchResult", r.json())
        assert r.json()["requestId"] == body["requestId"]
    return r


def by_id(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {h["sourceId"]: h for h in body["hits"]}


# ── search ─────────────────────────────────────────────────────────────────────────────────


def test_a_graph_derived_hit_is_labelled_and_says_how_it_came_in(
    client: TestClient, doc: dict[str, uuid.UUID], retrievable: Callable[..., None]
) -> None:
    retrievable("1")
    r = search(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["graphAvailable"] is True
    hits = body["hits"]
    # The retrieved judgment first, then (at most two of) the judgments linked to it.
    assert [h["sourceId"] for h in hits] == [str(doc["1"]), str(doc["2"]), str(doc["3"])]
    first, cited, connected = hits
    assert first["origin"] == "retrieved" and first["via"] is None
    assert first["snippet"] and "Zephyr quarantine" in first["snippet"]
    assert cited["origin"] == "graph_derived"
    assert cited["via"]["type"] == "CITES_JUDGMENT"
    assert cited["via"]["relatedSourceId"] == str(doc["1"])
    assert cited["via"]["sectionLabel"] is None
    assert cited["locator"] is None and cited["snippet"] is None
    assert cited["title"] == "Older (Appellant) VS The State"
    assert cited["citation"] == "PLD 2019 SC 50" and cited["decidedOn"] == "2019-01-10"
    assert connected["via"]["type"] == "CONNECTED_CASE"
    scores = [h["score"] for h in hits]
    assert scores == sorted(scores, reverse=True)


def test_via_is_an_edge_of_the_derived_judgment(
    client: TestClient, engine: Engine, doc: dict[str, uuid.UUID], retrievable: Callable[..., None]
) -> None:
    retrievable("1")
    hit = by_id(search(client).json())[str(doc["2"])]
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT g.type, g.provenance_doc_id FROM corpus.graph_edges g WHERE g.id = :id"),
            {"id": hit["via"]["edgeId"]},
        ).one()
    assert (row.type, row.provenance_doc_id) == ("CITES_JUDGMENT", doc["1"])


def test_a_shared_section_brings_in_judgments_citing_it(
    client: TestClient, doc: dict[str, uuid.UUID], retrievable: Callable[..., None]
) -> None:
    retrievable("1")
    # Judgment 3 cites no section, so the filter leaves judgments 2 and 5 under judgment 1.
    r = search(client, filters={"sectionRef": "section 497 Cr.P.C."})
    hits = r.json()["hits"]
    assert [h["sourceId"] for h in hits] == [str(doc["1"]), str(doc["2"]), str(doc["5"])]
    assert hits[2]["origin"] == "graph_derived"
    assert hits[2]["via"]["type"] == "CITES_SECTION"
    assert hits[2]["via"]["sectionLabel"] == "s.497 CrPC"


def test_a_judgment_with_an_overruling_edge_is_flagged(
    client: TestClient, doc: dict[str, uuid.UUID], retrievable: Callable[..., None]
) -> None:
    retrievable("1")
    hits = by_id(search(client).json())
    assert hits[str(doc["2"])]["flags"] == ["overruled"]
    assert hits[str(doc["1"])]["flags"] == []


def test_a_judgment_found_both_ways_is_listed_once_as_retrieved(
    client: TestClient, doc: dict[str, uuid.UUID]
) -> None:
    hits = search(client).json()["hits"]
    assert sorted(h["sourceId"] for h in hits) == sorted(str(doc[n]) for n in "12345")
    assert {h["origin"] for h in hits} == {"retrieved"}
    assert hits[0]["sourceId"] == str(doc["1"])  # the best match
    # Flags apply to retrieved hits too.
    assert by_id({"hits": hits})[str(doc["2"])]["flags"] == ["overruled"]


def test_graph_derived_hits_can_be_turned_off(
    client: TestClient, doc: dict[str, uuid.UUID], retrievable: Callable[..., None]
) -> None:
    retrievable("1")
    body = search(client, includeGraphDerived=False).json()
    assert [h["sourceId"] for h in body["hits"]] == [str(doc["1"])]
    assert body["graphAvailable"] is True


def test_without_a_graph_only_retrieved_hits_come_back(
    client: TestClient, engine: Engine, doc: dict[str, uuid.UUID], retrievable: Callable[..., None]
) -> None:
    retrievable("1")
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE corpus.graph_edges, corpus.graph_entities"))
    body = search(client).json()
    assert body["graphAvailable"] is False
    assert [h["sourceId"] for h in body["hits"]] == [str(doc["1"])]
    assert body["hits"][0]["flags"] == []


@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        ({"court": "Supreme Court of Pakistan"}, {"2", "4"}),
        ({"decidedFrom": "2021-01-01"}, {"3", "4", "5"}),
        ({"decidedFrom": "2019-01-01", "decidedTo": "2020-12-31"}, {"1", "2"}),
        ({"sectionRef": "s.497 CrPC"}, {"1", "2", "5"}),
        ({"sectionRef": "s.302 PPC"}, set()),
        ({"area": "criminal"}, set()),
    ],
)
def test_filters_narrow_every_hit(
    client: TestClient, doc: dict[str, uuid.UUID], filters: dict[str, str], expected: set[str]
) -> None:
    hits = search(client, filters=filters).json()["hits"]
    assert {h["sourceId"] for h in hits} == {str(doc[n]) for n in expected}


def test_limit_caps_retrieved_and_graph_derived_together(
    client: TestClient, retrievable: Callable[..., None]
) -> None:
    retrievable("1")
    assert len(search(client, limit=2).json()["hits"]) == 2


@pytest.mark.parametrize(
    "overrides",
    [
        {"query": ""},
        {"limit": 51},
        {"filters": {"court": "x" * 121}},
        {"filters": {"decidedFrom": "2024-01-02", "decidedTo": "2024-01-01"}},
        {"filters": {"judge": "x"}},
        {"scope": {}},
    ],
)
def test_a_bad_search_is_a_400(client: TestClient, overrides: dict[str, Any]) -> None:
    assert search(client, **overrides).status_code == 400


def test_search_needs_the_service_token(client: TestClient) -> None:
    r = client.post("/ai/v1/precedents/search", json={"requestId": str(uuid.uuid4()), "query": "x"})
    assert r.status_code == 401


def test_an_unembedded_corpus_is_a_503(client: TestClient, engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE corpus.corpus_meta"))
    assert search(client).status_code == 503


# ── relationships ──────────────────────────────────────────────────────────────────────────


def relationships(client: TestClient, source_id: uuid.UUID | str) -> Any:
    return client.get(f"/ai/v1/precedents/{source_id}/relationships", headers=AUTH)


def test_relationships_carry_provenance_and_status(
    client: TestClient, doc: dict[str, uuid.UUID]
) -> None:
    r = relationships(client, doc["1"])
    assert r.status_code == 200, r.text
    body = r.json()
    conforms("RelationshipList", body)
    assert body["sourceId"] == str(doc["1"])
    got = [(i["direction"], i["type"], i["other"]["label"]) for i in body["items"]]
    assert got == [
        ("outgoing", "CITES_JUDGMENT", "2018 YLR 77"),
        ("outgoing", "CITES_JUDGMENT", "PLD 2019 SC 50"),
        ("outgoing", "CITES_SECTION", "s.497 CrPC"),
        ("outgoing", "CONNECTED_CASE", "2021 MLD 5"),
    ]
    items = {i["other"]["label"]: i for i in body["items"]}
    assert items["PLD 2019 SC 50"]["other"] == {
        "entityType": "judgment",
        "sourceId": str(doc["2"]),
        "label": "PLD 2019 SC 50",
    }
    assert items["2018 YLR 77"]["other"]["sourceId"] is None  # unresolved: a label only
    assert items["s.497 CrPC"]["other"]["entityType"] == "section"
    assert items["s.497 CrPC"]["other"]["sourceId"] == str(doc["crpc"])
    assert items["PLD 2019 SC 50"]["provenance"] == {
        "documentId": str(doc["1"]),
        "extractionMethod": "regex",
        "confidence": 0.7,
        "humanConfirmed": False,
    }
    assert items["2018 YLR 77"]["provenance"]["extractionMethod"] == "metadata"
    for item in body["items"]:
        assert item["verificationStatus"] == "unverified"
        assert item["validFrom"] == "2020-03-01" and item["validTo"] is None
        assert item["recordedAt"]


def test_relationships_list_outgoing_then_incoming(
    client: TestClient, doc: dict[str, uuid.UUID]
) -> None:
    body = relationships(client, doc["2"]).json()
    conforms("RelationshipList", body)
    got = [(i["direction"], i["type"], i["other"]["label"]) for i in body["items"]]
    assert got == [
        ("outgoing", "CITES_SECTION", "s.497 CrPC"),
        ("incoming", "CITES_JUDGMENT", "2020 SCMR 100"),
        ("incoming", "OVERRULES", "2022 SCMR 9"),
    ]
    overrules = body["items"][2]
    assert overrules["provenance"]["documentId"] == str(doc["4"])
    assert overrules["provenance"]["confidence"] == 1.0


def test_a_judgment_with_no_edges_has_an_empty_list(
    client: TestClient, engine: Engine, doc: dict[str, uuid.UUID]
) -> None:
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE corpus.graph_edges, corpus.graph_entities"))
    body = relationships(client, doc["3"]).json()
    assert body == {"sourceId": str(doc["3"]), "items": []}


def test_relationships_of_anything_but_a_judgment_are_a_404(
    client: TestClient, doc: dict[str, uuid.UUID]
) -> None:
    assert relationships(client, doc["crpc"]).status_code == 404
    assert relationships(client, uuid.uuid4()).status_code == 404
    assert relationships(client, "not-a-uuid").status_code == 400
