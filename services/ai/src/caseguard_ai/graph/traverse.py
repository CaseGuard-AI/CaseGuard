"""Graph traversal with a recursive CTE (PRD §9.1, ADR-0003): depth ≤ 2, both directions.

``walk`` returns every path of 1..``max_depth`` edges from the start entities over the given
edge types. Paths never revisit an entity, and every intermediate entity must be one of
``through`` (e.g. a precedent search goes judgment → section → judgment, never through another
judgment). Callers decide which paths they want; this module only walks.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import Connection, text

MAX_DEPTH = 2  # PRD §9.1 default; deeper fan-out is not explainable on a regex graph
MAX_PATHS = 2000  # a safety cap on what one walk returns

_WALK = text(
    """
    WITH RECURSIVE walk (start_id, entity_id, entity_type, depth, edge_ids, edge_types,
                         directions, path) AS (
        SELECT e.id, e.id, e.type, 0, ARRAY[]::uuid[], ARRAY[]::text[], ARRAY[]::text[],
               ARRAY[e.id]
          FROM corpus.graph_entities e
         WHERE e.id = ANY(CAST(:starts AS uuid[]))
        UNION ALL
        SELECT w.start_id, n.other, o.type, w.depth + 1, w.edge_ids || n.edge_id,
               w.edge_types || n.type, w.directions || n.direction, w.path || n.other
          FROM walk w
          CROSS JOIN LATERAL (
              SELECT g.id AS edge_id, g.type, 'outgoing'::text AS direction, g.dst_entity AS other
                FROM corpus.graph_edges g
               WHERE g.src_entity = w.entity_id AND g.type = ANY(CAST(:types AS text[]))
              UNION ALL
              SELECT g.id, g.type, 'incoming'::text, g.src_entity
                FROM corpus.graph_edges g
               WHERE g.dst_entity = w.entity_id AND g.type = ANY(CAST(:types AS text[]))
          ) n
          JOIN corpus.graph_entities o ON o.id = n.other
         WHERE w.depth < :max_depth
           AND NOT n.other = ANY(w.path)
           AND (w.depth = 0 OR w.entity_type = ANY(CAST(:through AS text[])))
    )
    SELECT w.start_id, w.entity_id, w.entity_type, w.depth, w.edge_ids, w.edge_types,
           w.directions, w.path
      FROM walk w
     WHERE w.depth > 0
     ORDER BY w.start_id, w.depth, w.edge_types, w.entity_id, w.edge_ids
     LIMIT :cap
    """
)


@dataclass(frozen=True)
class Path:
    start: uuid.UUID
    end: uuid.UUID
    end_type: str
    edges: tuple[uuid.UUID, ...]
    types: tuple[str, ...]
    directions: tuple[str, ...]  # "outgoing" / "incoming", seen from the walker
    entities: tuple[uuid.UUID, ...]  # start .. end

    @property
    def depth(self) -> int:
        return len(self.edges)


def walk(
    conn: Connection,
    starts: Sequence[uuid.UUID],
    edge_types: Sequence[str],
    *,
    max_depth: int = 1,
    through: Sequence[str] = (),
    cap: int = MAX_PATHS,
) -> list[Path]:
    if not starts or not edge_types:
        return []
    if not 1 <= max_depth <= MAX_DEPTH:
        raise ValueError(f"max_depth must be 1..{MAX_DEPTH}")
    rows = conn.execute(
        _WALK,
        {
            "starts": [str(s) for s in starts],
            "types": list(edge_types),
            "through": list(through),
            "max_depth": max_depth,
            "cap": cap,
        },
    )
    return [
        Path(
            start=r.start_id,
            end=r.entity_id,
            end_type=r.entity_type,
            edges=tuple(r.edge_ids),
            types=tuple(r.edge_types),
            directions=tuple(r.directions),
            entities=tuple(r.path),
        )
        for r in rows
    ]
