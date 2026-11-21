"""Precedent search: hybrid retrieval over judgments, then one graph hop (#210, ADR-0011).

1. ``retrieve()`` over the public corpus, judgments only. Chunks are grouped by judgment, best
   passage first: these hits are ``retrieved`` (with that passage's locator and snippet).
2. One hop from each retrieved judgment, through the graph (``graph/traverse.py``):
   ``CITES_JUDGMENT`` either way, ``CONNECTED_CASE`` either way, and judgments citing the same
   statute section (judgment → section ← judgment). These are ``graph_derived``, with ``via``
   naming the edge that brought them in and the retrieved judgment they hang off (FR-PREC-3).
3. Filters apply to every hit. A judgment is listed once, ``retrieved`` if it was. Each
   retrieved hit is followed by up to ``DERIVED_PER_HIT`` of its graph-derived hits.
4. ``overruled`` flags a judgment with an incoming ``OVERRULES`` edge (§9.3 "constrain").

Deterministic: no model provider is called (ADR-0011). Case documents are never searched: the
scope has no cases, so ``retrieve()``'s case branch matches nothing.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from sqlalchemy import Connection, Engine, text

from caseguard_ai.graph.build import doc_key
from caseguard_ai.graph.citations import parse_section_label
from caseguard_ai.graph.traverse import walk
from caseguard_ai.ingest.embedder import Embedder
from caseguard_ai.retrieval.hybrid import Passage, Scope, retrieve
from caseguard_ai.retrieval.reranker import Reranker

# Judgments are public: no user, no cases (FR-CASE-6 keeps case chunks out in SQL).
PUBLIC = Scope(user_id=uuid.UUID(int=0), account_id=uuid.UUID(int=0), allowed_case_ids=())
CANDIDATES = 40  # passages reranked before grouping by judgment
DERIVED_PER_HIT = 2
SNIPPET_CHARS = 500
# Which graph-derived link is shown first under a retrieved judgment.
PRIORITY = {"CITES_JUDGMENT": 0, "CONNECTED_CASE": 1, "CITES_SECTION": 2}


@dataclass(frozen=True)
class Filters:
    court: str | None = None
    area: str | None = None
    decided_from: date | None = None
    decided_to: date | None = None
    section_ref: str | None = None


@dataclass(frozen=True)
class PrecedentQuery:
    request_id: uuid.UUID
    query: str
    filters: Filters = Filters()
    include_graph_derived: bool = True
    limit: int = 20


@dataclass(frozen=True)
class Via:
    edge_id: uuid.UUID
    type: str
    related_source_id: uuid.UUID
    section_label: str | None


@dataclass(frozen=True)
class Judgment:
    id: uuid.UUID
    title: str
    citation: str | None
    court: str | None
    decided_on: date | None
    area: str | None


_JUDGMENTS = text(
    """
    SELECT id, title, citation, court, decided_on, area FROM corpus.documents
     WHERE kind = 'judgment' AND id = ANY(CAST(:ids AS uuid[]))
    """
)

_GRAPH_AVAILABLE = text("SELECT EXISTS (SELECT 1 FROM corpus.graph_edges)")

_ENTITIES = text(
    """
    SELECT id, ref_id FROM corpus.graph_entities
     WHERE type = 'judgment' AND key = ANY(CAST(:keys AS text[]))
    """
)

_LABELS = text("SELECT id, type, ref_id, label FROM corpus.graph_entities WHERE id = ANY(:ids)")

_OVERRULED = text(
    """
    SELECT DISTINCT e.ref_id FROM corpus.graph_edges g
      JOIN corpus.graph_entities e ON e.id = g.dst_entity
     WHERE g.type = 'OVERRULES' AND e.ref_id = ANY(CAST(:ids AS uuid[]))
    """
)

_CITING_SECTION = text(
    """
    SELECT DISTINCT j.ref_id FROM corpus.graph_edges g
      JOIN corpus.graph_entities s ON s.id = g.dst_entity
      JOIN corpus.graph_entities j ON j.id = g.src_entity
     WHERE g.type = 'CITES_SECTION' AND s.type = 'section' AND s.key = :label
       AND j.ref_id IS NOT NULL
    """
)


def _judgments(conn: Connection, ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, Judgment]:
    if not ids:
        return {}
    rows = conn.execute(_JUDGMENTS, {"ids": [str(i) for i in ids]}).mappings()
    return {r["id"]: Judgment(**r) for r in rows}


def _citing_section(conn: Connection, section_ref: str) -> set[uuid.UUID]:
    ref = parse_section_label(section_ref)
    label = ref.label if ref else " ".join(section_ref.split())
    return {r[0] for r in conn.execute(_CITING_SECTION, {"label": label})}


def _passes(j: Judgment, f: Filters, citing: set[uuid.UUID] | None) -> bool:
    if f.court is not None and j.court != f.court:
        return False
    if f.area is not None and (j.area or "").casefold() != f.area.casefold():
        return False
    if f.decided_from is not None and (j.decided_on is None or j.decided_on < f.decided_from):
        return False
    if f.decided_to is not None and (j.decided_on is None or j.decided_on > f.decided_to):
        return False
    return citing is None or j.id in citing


def _group(passages: Sequence[Passage]) -> dict[uuid.UUID, Passage]:
    """The best passage per judgment, in rank order."""
    best: dict[uuid.UUID, Passage] = {}
    for p in passages:
        best.setdefault(p.document_id, p)
    return best


def _derived(
    conn: Connection, retrieved: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[tuple[uuid.UUID, Via]]]:
    """For each retrieved judgment, the judgments one hop away and the edge that links them."""
    keys = [doc_key(d) for d in retrieved]
    entity_of = {r.id: r.ref_id for r in conn.execute(_ENTITIES, {"keys": keys})}
    starts = list(entity_of)
    paths = walk(conn, starts, ["CITES_JUDGMENT", "CONNECTED_CASE"], max_depth=1)
    paths += [
        p
        for p in walk(conn, starts, ["CITES_SECTION"], max_depth=2, through=["section"])
        if p.depth == 2 and p.directions == ("outgoing", "incoming")
    ]
    ids = {e for p in paths for e in p.entities}
    info = {r.id: r for r in conn.execute(_LABELS, {"ids": list(ids)})} if ids else {}
    out: dict[uuid.UUID, list[tuple[uuid.UUID, Via]]] = {}
    for p in paths:
        end = info.get(p.end)
        if p.end_type != "judgment" or end is None or end.ref_id is None:
            continue  # only judgments in the corpus can be hits
        parent = entity_of[p.start]
        section = info[p.entities[1]].label if p.types[0] == "CITES_SECTION" else None
        # The edge that touches the derived judgment is the one that brought it in.
        via = Via(p.edges[-1], p.types[-1], parent, section)
        out.setdefault(parent, []).append((end.ref_id, via))
    return out


def _order_key(j: Judgment, via: Via) -> tuple[int, int, str, str]:
    newer_first = -(j.decided_on.toordinal() if j.decided_on else 0)
    return (PRIORITY.get(via.type, 9), newer_first, j.title, str(j.id))


def _hit(j: Judgment, origin: str, via: Via | None, passage: Passage | None) -> dict[str, Any]:
    return {
        "sourceId": str(j.id),
        "title": j.title,
        "citation": j.citation,
        "court": j.court,
        "decidedOn": j.decided_on.isoformat() if j.decided_on else None,
        "origin": origin,
        "via": None
        if via is None
        else {
            "edgeId": str(via.edge_id),
            "type": via.type,
            "relatedSourceId": str(via.related_source_id),
            "sectionLabel": via.section_label,
        },
        "flags": [],
        "locator": passage.locator if passage else None,
        "snippet": passage.text.strip()[:SNIPPET_CHARS] if passage else None,
        "score": 0.0,
    }


def search_precedents(
    engine: Engine, q: PrecedentQuery, *, embedder: Embedder, reranker: Reranker
) -> dict[str, Any]:
    """The ai.v1 ``PrecedentSearchResult`` for ``q``."""
    with engine.connect() as conn:
        found = retrieve(
            conn,
            q.query,
            PUBLIC,
            embedder,
            reranker,
            fused_k=CANDIDATES,
            final_k=CANDIDATES,
            kinds=("judgment",),
        )
        best = _group([p for p in found.passages if p.kind == "judgment"])
        graph_available = bool(conn.execute(_GRAPH_AVAILABLE).scalar_one())
        citing = (
            _citing_section(conn, q.filters.section_ref)
            if q.filters.section_ref is not None
            else None
        )
        meta = _judgments(conn, list(best))
        retrieved = [d for d in best if d in meta and _passes(meta[d], q.filters, citing)]

        derived: dict[uuid.UUID, list[tuple[uuid.UUID, Via]]] = {}
        if q.include_graph_derived and graph_available and retrieved:
            derived = _derived(conn, retrieved)
            meta.update(_judgments(conn, [d for links in derived.values() for d, _ in links]))

        hits: list[dict[str, Any]] = []
        listed = set(retrieved)
        for doc in retrieved:
            if len(hits) >= q.limit:
                break
            hits.append(_hit(meta[doc], "retrieved", None, best[doc]))
            links = [
                (meta[d], via)
                for d, via in derived.get(doc, [])
                if d in meta and d not in listed and _passes(meta[d], q.filters, citing)
            ]
            links.sort(key=lambda pair: _order_key(*pair))
            for j, via in links:
                if (
                    len(hits) >= q.limit
                    or sum(1 for h in hits if h["via"] and h["via"]["relatedSourceId"] == str(doc))
                    >= DERIVED_PER_HIT
                ):
                    break
                if j.id in listed:
                    continue
                listed.add(j.id)
                hits.append(_hit(j, "graph_derived", via, None))

        ids = [h["sourceId"] for h in hits]
        overruled = {str(r[0]) for r in conn.execute(_OVERRULED, {"ids": ids})} if ids else set()
    for rank, h in enumerate(hits):
        h["score"] = round(1.0 - rank / max(len(hits), 1), 6)
        if h["sourceId"] in overruled:
            h["flags"] = ["overruled"]
    return {"requestId": str(q.request_id), "hits": hits, "graphAvailable": graph_available}


# ── relationships ──────────────────────────────────────────────────────────────────────────

_IS_JUDGMENT = text("SELECT 1 FROM corpus.documents WHERE id = :id AND kind = 'judgment'")

_RELATIONSHIPS = text(
    """
    SELECT g.id, g.type, x.direction, o.type AS entity_type, o.ref_id, o.label,
           g.provenance_doc_id, g.extraction_method, g.confidence, g.human_confirmed,
           g.verification_status, g.valid_from, g.valid_to, g.recorded_at
      FROM corpus.graph_entities me
      CROSS JOIN LATERAL (
          SELECT e.id AS edge_id, 'outgoing' AS direction, e.dst_entity AS other
            FROM corpus.graph_edges e WHERE e.src_entity = me.id
          UNION ALL
          SELECT e.id, 'incoming', e.src_entity
            FROM corpus.graph_edges e WHERE e.dst_entity = me.id
      ) x
      JOIN corpus.graph_edges g ON g.id = x.edge_id
      JOIN corpus.graph_entities o ON o.id = x.other
     WHERE me.type = 'judgment' AND me.key = :key
     ORDER BY x.direction DESC, g.type, o.label, g.id
    """
)


def _iso(value: date | datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def get_relationships(conn: Connection, source_id: uuid.UUID) -> dict[str, Any] | None:
    """The ai.v1 ``RelationshipList`` of a judgment, outgoing first; None if not a judgment."""
    if conn.execute(_IS_JUDGMENT, {"id": source_id}).first() is None:
        return None
    items = [
        {
            "id": str(r.id),
            "type": r.type,
            "direction": r.direction,
            "other": {
                "entityType": r.entity_type,
                "sourceId": str(r.ref_id) if r.ref_id else None,
                "label": r.label,
            },
            "provenance": {
                "documentId": str(r.provenance_doc_id) if r.provenance_doc_id else None,
                "extractionMethod": r.extraction_method,
                "confidence": float(r.confidence),
                "humanConfirmed": bool(r.human_confirmed),
            },
            "verificationStatus": r.verification_status,
            "validFrom": _iso(r.valid_from),
            "validTo": _iso(r.valid_to),
            "recordedAt": _iso(r.recorded_at),
        }
        for r in conn.execute(_RELATIONSHIPS, {"key": doc_key(source_id)})
    ]
    return {"sourceId": str(source_id), "items": items}
