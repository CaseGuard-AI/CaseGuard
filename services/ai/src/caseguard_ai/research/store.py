"""Writes and reads of the trust store (FR-TRUST-2, FR-TRUST-10).

``ai.verifications`` is the single store of citation statuses. An answer's statuses are written
here first and the response is built from what is read back, so the api, the citation route and
the UI all show the one stored value and nothing recomputes it.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from sqlalchemy import Connection, delete, insert, select

from caseguard_ai.db.tables import answer_traces, citations, documents, verifications

LANGUAGES = ("en", "ur", "roman_ur")  # ai.v1 Language


@dataclass(frozen=True)
class NewCitation:
    id: uuid.UUID
    source_id: uuid.UUID
    chunk_id: uuid.UUID | None
    claim: str
    locator: str | None
    quote: str | None
    quote_language: str | None
    status: str
    flags: list[str]
    checks: dict[str, Any]
    verifier_version: str


def write_answer(
    conn: Connection,
    *,
    request_id: uuid.UUID,
    answerable: bool,
    trace: dict[str, list[dict[str, Any]]],
    models: dict[str, Any],
    provider: str | None,
    latency_ms: int,
    new_citations: list[NewCitation],
) -> None:
    """One transaction (the caller's): the trace, then each citation with its verification."""
    # A retried request id replaces its earlier trace; citations cascade with it.
    conn.execute(delete(answer_traces).where(answer_traces.c.request_id == request_id))
    conn.execute(
        insert(answer_traces).values(
            request_id=request_id,
            answerable=answerable,
            models=models,
            provider=provider,
            latency_ms=latency_ms,
            **trace,
        )
    )
    for c in new_citations:
        conn.execute(
            insert(citations).values(
                id=c.id,
                request_id=request_id,
                source_id=c.source_id,
                chunk_id=c.chunk_id,
                claim=c.claim,
                locator=c.locator,
                quote=c.quote,
                quote_language=c.quote_language,
            )
        )
        conn.execute(
            insert(verifications).values(
                citation_id=c.id,
                status=c.status,
                flags=c.flags,
                checks=c.checks,
                verifier_version=c.verifier_version,
            )
        )


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _citation_dto(row: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(row.id),
        "sourceId": str(row.source_id),
        "claim": row.claim,
        "verification": {
            "status": row.status,
            "flags": list(row.flags),
            "lastVerifiedAt": _iso(row.last_verified_at),
            "checks": dict(row.checks),
        },
    }
    if row.locator:
        out["locator"] = row.locator
    if row.quote:
        out["quote"] = row.quote
    if row.quote_language in LANGUAGES:
        out["quoteLanguage"] = row.quote_language
    return out


def _citation_query() -> Any:
    return select(
        citations.c.id,
        citations.c.source_id,
        citations.c.claim,
        citations.c.locator,
        citations.c.quote,
        citations.c.quote_language,
        verifications.c.status,
        verifications.c.flags,
        verifications.c.checks,
        verifications.c.last_verified_at,
    ).join(verifications, verifications.c.citation_id == citations.c.id)


def read_citations(conn: Connection, ids: list[uuid.UUID]) -> list[dict[str, Any]]:
    """The stored citations with their stored verifications, in the order of ``ids``."""
    if not ids:
        return []
    rows = {r.id: r for r in conn.execute(_citation_query().where(citations.c.id.in_(ids)))}
    return [_citation_dto(rows[i]) for i in ids if i in rows]


def get_citation(conn: Connection, citation_id: uuid.UUID) -> dict[str, Any] | None:
    row = conn.execute(_citation_query().where(citations.c.id == citation_id)).first()
    return _citation_dto(row) if row else None


def get_source(conn: Connection, source_id: uuid.UUID) -> dict[str, Any] | None:
    row = conn.execute(select(documents).where(documents.c.id == source_id)).mappings().first()
    if row is None:
        return None
    out: dict[str, Any] = {
        "id": str(row["id"]),
        "kind": row["kind"],
        "title": row["title"],
        "officialUrl": row["official_url"],
        "sourceTier": row["source_tier"],
        "thirdParty": row["third_party"],
        "headnoteOnly": row["headnote_only"],
        # The collector writes en or ur; anything else is shown as English, the corpus default.
        "language": row["language"] if row["language"] in LANGUAGES else "en",
    }
    for key, column in (("citation", "citation"), ("court", "court")):
        if row[column]:
            out[key] = row[column]
    decided: date | None = row["decided_on"]
    if decided:
        out["decidedOn"] = decided.isoformat()
    retrieved: datetime | None = row["retrieved_at"]
    if retrieved:
        out["retrievedAt"] = _iso(retrieved)
    return out
