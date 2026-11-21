"""Build the knowledge graph from the corpus (#210, FR-GRAPH-1, PRD §9, ADR-0011).

    pnpm ai:graph-build

One pass over the judgments in ``corpus.documents``:

- ``CITES_JUDGMENT`` from ``raw.cited_cases`` (metadata) and law-report citations matched in
  ``full_text`` (regex), resolved against ``corpus.documents.citation`` and
  ``raw.all_citations``. An unresolved citation becomes a judgment entity without a ref,
  labelled by the citation.
- ``CITES_SECTION`` from section references in ``raw.cited_laws`` (metadata) and ``full_text``
  (regex). A section entity points at its statute's document when the code resolves to one.
- ``CONNECTED_CASE`` from ``raw.connected_cases`` (metadata), resolved by citation or by case
  number (the same court preferred).
- ``OVERRULES`` only from an explicit ``raw.overrules`` list (§9.2). The collector does not emit
  that key yet; nothing is ever inferred.

Every edge carries its provenance: the judgment it came from, the extraction method and a
confidence. Metadata beats regex for the same relation.

**Idempotent.** New edges are staged, upserted on the identity key, and machine edges the run
no longer produced are deleted; human-entered or human-confirmed edges are never touched. A
re-run over an unchanged corpus changes nothing.
"""

from __future__ import annotations

import argparse
import sys
import uuid
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import Connection, Engine, create_engine, text

from caseguard_ai.config import DatabaseSettings
from caseguard_ai.graph.citations import (
    CODES,
    Code,
    find_citations,
    find_sections,
    normalise_case_number,
    normalise_citation,
)

METADATA = "metadata"
REGEX = "regex"
CONFIDENCE = {METADATA: 0.9, REGEX: 0.7}
OVERRULES_CONFIDENCE = 1.0  # an explicit statement in the source metadata

EntityKey = tuple[str, str]  # (type, key)


@dataclass(frozen=True)
class Entity:
    type: str
    key: str
    label: str
    ref_id: uuid.UUID | None = None


@dataclass(frozen=True)
class Edge:
    type: str
    src: EntityKey
    dst: EntityKey
    provenance_doc_id: uuid.UUID
    extraction_method: str
    confidence: float
    valid_from: date | None


@dataclass
class Report:
    judgments: int = 0
    entities: int = 0
    edges: int = 0
    inserted: int = 0
    updated: int = 0
    removed: int = 0
    by_type: dict[str, int] = field(default_factory=dict)

    def line(self) -> str:
        types = ", ".join(f"{k} {v}" for k, v in sorted(self.by_type.items())) or "none"
        return (
            f"graph: {self.judgments} judgments, {self.entities} entities, {self.edges} edges "
            f"({types}); {self.inserted} added, {self.updated} updated, {self.removed} removed"
        )


# ── resolution ─────────────────────────────────────────────────────────────────────────────


def doc_key(doc_id: uuid.UUID) -> str:
    return f"doc:{doc_id}"


@dataclass
class Resolver:
    """Maps citation strings and case numbers to corpus judgments, and codes to statutes."""

    by_citation: dict[str, uuid.UUID | None] = field(default_factory=dict)  # None: ambiguous
    by_case_number: dict[str, list[tuple[uuid.UUID, str | None]]] = field(
        default_factory=lambda: defaultdict(list)
    )
    statutes: dict[str, uuid.UUID] = field(default_factory=dict)  # code abbreviation → doc

    def add_citation(self, value: str, doc_id: uuid.UUID) -> None:
        norm = normalise_citation(value)
        seen = self.by_citation.get(norm, doc_id)
        self.by_citation[norm] = doc_id if seen == doc_id else None

    def citation(self, value: str) -> uuid.UUID | None:
        return self.by_citation.get(normalise_citation(value))

    def case_number(self, value: str, court: str | None) -> uuid.UUID | None:
        candidates = self.by_case_number.get(normalise_case_number(value), [])
        if len(candidates) > 1:
            candidates = [c for c in candidates if court and c[1] == court]
        return candidates[0][0] if len(candidates) == 1 else None


_INDEX = text(
    """
    SELECT id, citation, case_number, court, raw -> 'all_citations' AS all_citations
      FROM corpus.documents WHERE kind = 'judgment'
    """
)

# The shortest matching title is the code itself, not an amending act.
_STATUTE = text(
    """
    SELECT id FROM corpus.documents
     WHERE kind = 'statute' AND title ILIKE :pattern
     ORDER BY length(title), id LIMIT 1
    """
)


def build_resolver(conn: Connection, codes: Iterable[Code] = CODES) -> Resolver:
    resolver = Resolver()
    for r in conn.execute(_INDEX):
        if r.citation:
            resolver.add_citation(r.citation, r.id)
        for value in r.all_citations if isinstance(r.all_citations, list) else []:
            if isinstance(value, str) and value.strip():
                resolver.add_citation(value, r.id)
        if r.case_number:
            resolver.by_case_number[normalise_case_number(r.case_number)].append((r.id, r.court))
    for code in codes:
        statute = conn.execute(_STATUTE, {"pattern": code.title_pattern}).scalar()
        if statute is not None:
            resolver.statutes[code.abbreviation] = statute
    return resolver


# ── extraction ─────────────────────────────────────────────────────────────────────────────


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [v.strip() for v in value if isinstance(v, str) and v.strip()]
    return []


def _judgment_entity(resolver: Resolver, value: str, resolved: uuid.UUID | None) -> Entity:
    if resolved is not None:
        return Entity("judgment", doc_key(resolved), value, resolved)
    norm = normalise_citation(value)
    return Entity("judgment", f"cite:{norm}", " ".join(value.split()))


def extract(
    row: Any, resolver: Resolver
) -> tuple[Entity, list[Entity], dict[tuple[str, EntityKey], tuple[str, float]]]:
    """One judgment's own entity, the entities it points at, and its relations
    ``(type, target) → (method, confidence)``, metadata preferred over regex."""
    me = Entity("judgment", doc_key(row.id), row.citation or row.title, row.id)
    raw: dict[str, Any] = row.raw if isinstance(row.raw, dict) else {}
    targets: list[Entity] = []
    relations: dict[tuple[str, EntityKey], tuple[str, float]] = {}

    def relate(edge_type: str, target: Entity, method: str, confidence: float) -> None:
        if (target.type, target.key) == (me.type, me.key):
            return  # a judgment's own citation in its header
        rel = (edge_type, (target.type, target.key))
        if rel in relations and relations[rel][1] >= confidence:
            return
        targets.append(target)
        relations[rel] = (method, confidence)

    def judgment(value: str) -> Entity:
        return _judgment_entity(resolver, value, resolver.citation(value))

    for value in _strings(raw.get("cited_cases")):
        relate("CITES_JUDGMENT", judgment(value), METADATA, CONFIDENCE[METADATA])
    for value in find_citations(row.full_text):
        relate("CITES_JUDGMENT", judgment(value), REGEX, CONFIDENCE[REGEX])

    def section_entity(label: str, code: Code) -> Entity:
        return Entity("section", label, label, resolver.statutes.get(code.abbreviation))

    for value in _strings(raw.get("cited_laws")):
        for ref in find_sections(value):
            relate(
                "CITES_SECTION", section_entity(ref.label, ref.code), METADATA, CONFIDENCE[METADATA]
            )
    for ref in find_sections(row.full_text):
        relate("CITES_SECTION", section_entity(ref.label, ref.code), REGEX, CONFIDENCE[REGEX])

    for value in _strings(raw.get("connected_cases")):
        resolved = resolver.citation(value) or resolver.case_number(value, row.court)
        if resolved is not None:
            target = Entity("judgment", doc_key(resolved), value, resolved)
        elif find_citations(value):
            target = _judgment_entity(resolver, value, None)
        else:
            target = Entity("judgment", f"case:{normalise_case_number(value)}", value)
        relate("CONNECTED_CASE", target, METADATA, CONFIDENCE[METADATA])

    for value in _strings(raw.get("overrules")):
        relate("OVERRULES", judgment(value), METADATA, OVERRULES_CONFIDENCE)

    return me, targets, relations


# ── writing ────────────────────────────────────────────────────────────────────────────────

_JUDGMENTS = text(
    """
    SELECT id, title, citation, court, decided_on, raw, full_text
      FROM corpus.documents WHERE kind = 'judgment' ORDER BY id
    """
)

_UPSERT_ENTITY = text(
    """
    INSERT INTO corpus.graph_entities (type, ref_table, ref_id, label, key)
    VALUES (:type, :ref_table, :ref_id, :label, :key)
    ON CONFLICT (type, key) DO UPDATE
       SET ref_table = EXCLUDED.ref_table, ref_id = EXCLUDED.ref_id, label = EXCLUDED.label
     WHERE (graph_entities.ref_table, graph_entities.ref_id, graph_entities.label)
           IS DISTINCT FROM (EXCLUDED.ref_table, EXCLUDED.ref_id, EXCLUDED.label)
    """
)

_STAGE = text(
    """
    CREATE TEMPORARY TABLE graph_build_edges (
        type text, src_type text, src_key text, dst_type text, dst_key text,
        provenance_doc_id uuid, extraction_method text, confidence double precision,
        valid_from date
    ) ON COMMIT DROP
    """
)

_STAGE_ROW = text(
    """
    INSERT INTO graph_build_edges VALUES (:type, :src_type, :src_key, :dst_type, :dst_key,
        :provenance_doc_id, :extraction_method, :confidence, :valid_from)
    """
)

_RESOLVED = """
    SELECT b.type, s.id AS src, d.id AS dst, b.provenance_doc_id, b.extraction_method,
           b.confidence, b.valid_from
      FROM graph_build_edges b
      JOIN corpus.graph_entities s ON (s.type, s.key) = (b.src_type, b.src_key)
      JOIN corpus.graph_entities d ON (d.type, d.key) = (b.dst_type, b.dst_key)
"""

# A human-confirmed edge keeps what the human saw; only machine edges are refreshed.
_UPSERT_EDGES = text(
    f"""
    WITH upserted AS (
        INSERT INTO corpus.graph_edges (type, src_entity, dst_entity, provenance_doc_id,
                                        extraction_method, confidence, valid_from)
        {_RESOLVED}
        ON CONFLICT ON CONSTRAINT graph_edges_identity_key DO UPDATE
           SET extraction_method = EXCLUDED.extraction_method,
               confidence = EXCLUDED.confidence,
               valid_from = EXCLUDED.valid_from
         WHERE NOT graph_edges.human_confirmed
           AND graph_edges.extraction_method <> 'human'
           AND (graph_edges.extraction_method, graph_edges.confidence, graph_edges.valid_from)
               IS DISTINCT FROM (EXCLUDED.extraction_method, EXCLUDED.confidence,
                                 EXCLUDED.valid_from)
        RETURNING (xmax = 0) AS inserted
    )
    SELECT count(*) FILTER (WHERE inserted) AS inserted,
           count(*) FILTER (WHERE NOT inserted) AS updated
      FROM upserted
    """  # noqa: S608 - a fixed fragment, no input
)

_REMOVE_STALE = text(
    f"""
    DELETE FROM corpus.graph_edges g
     WHERE g.extraction_method IN ('metadata', 'regex') AND NOT g.human_confirmed
       AND NOT EXISTS (
           SELECT 1 FROM ({_RESOLVED}) n
            WHERE (n.type, n.src, n.dst, n.provenance_doc_id)
                  = (g.type, g.src_entity, g.dst_entity, g.provenance_doc_id))
    """  # noqa: S608 - a fixed fragment, no input
)

# Unresolved names nobody points at any more, and judgments that left the corpus.
_REMOVE_ORPHANS = text(
    """
    DELETE FROM corpus.graph_entities e
     WHERE (e.key NOT LIKE 'doc:%'
            AND NOT EXISTS (SELECT 1 FROM corpus.graph_edges g
                             WHERE g.src_entity = e.id OR g.dst_entity = e.id))
        OR (e.key LIKE 'doc:%'
            AND NOT EXISTS (SELECT 1 FROM corpus.documents d WHERE d.id = e.ref_id))
    """
)


def _entity_params(entities: Iterable[Entity]) -> list[dict[str, Any]]:
    return [
        {
            "type": e.type,
            "key": e.key,
            "label": e.label,
            "ref_id": e.ref_id,
            "ref_table": "documents" if e.ref_id else None,
        }
        for e in entities
    ]


def build(engine: Engine) -> Report:
    """Build or refresh the whole graph in one transaction."""
    report = Report()
    with engine.begin() as conn:
        resolver = build_resolver(conn)
        entities: dict[EntityKey, Entity] = {}
        edges: list[Edge] = []
        for row in conn.execute(_JUDGMENTS, execution_options={"yield_per": 200}):
            report.judgments += 1
            me, targets, relations = extract(row, resolver)
            entities[(me.type, me.key)] = me
            for target in targets:
                # A resolved judgment's own entity wins over the label another judgment used.
                entities.setdefault((target.type, target.key), target)
            for (edge_type, dst), (method, confidence) in relations.items():
                edges.append(
                    Edge(
                        edge_type,
                        (me.type, me.key),
                        dst,
                        row.id,
                        method,
                        confidence,
                        row.decided_on,
                    )
                )
        # Resolved judgments are labelled by their own citation or title, not by how they
        # were cited.
        for r in conn.execute(
            text("SELECT id, title, citation FROM corpus.documents WHERE kind = 'judgment'")
        ):
            key = ("judgment", doc_key(r.id))
            if key in entities:
                entities[key] = Entity("judgment", key[1], r.citation or r.title, r.id)

        if entities:
            conn.execute(_UPSERT_ENTITY, _entity_params(entities.values()))
        conn.execute(_STAGE)
        if edges:
            conn.execute(
                _STAGE_ROW,
                [
                    {
                        "type": e.type,
                        "src_type": e.src[0],
                        "src_key": e.src[1],
                        "dst_type": e.dst[0],
                        "dst_key": e.dst[1],
                        "provenance_doc_id": e.provenance_doc_id,
                        "extraction_method": e.extraction_method,
                        "confidence": e.confidence,
                        "valid_from": e.valid_from,
                    }
                    for e in edges
                ],
            )
        counts = conn.execute(_UPSERT_EDGES).one()
        report.inserted, report.updated = int(counts.inserted), int(counts.updated)
        report.removed = conn.execute(_REMOVE_STALE).rowcount
        conn.execute(_REMOVE_ORPHANS)
        report.entities = conn.execute(
            text("SELECT count(*) FROM corpus.graph_entities")
        ).scalar_one()
        for t, n in conn.execute(
            text("SELECT type, count(*) FROM corpus.graph_edges GROUP BY type")
        ):
            report.by_type[t] = int(n)
        report.edges = sum(report.by_type.values())
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build the knowledge graph (corpus.graph_entities, corpus.graph_edges) "
        "from corpus.documents. Idempotent: safe to re-run after every load."
    )
    parser.parse_args([a for a in (sys.argv[1:] if argv is None else argv) if a != "--"])
    engine = create_engine(DatabaseSettings().sqlalchemy_url)
    try:
        report = build(engine)
    finally:
        engine.dispose()
    print(report.line())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
