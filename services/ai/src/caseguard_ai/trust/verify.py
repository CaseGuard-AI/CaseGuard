"""Check one cited passage and build the citation the trust store keeps (PRD §7.1, FR-TRUST-10).

Shared by research (#20) and drafting (#212), so every module runs the same checks in the same
order and writes into the one store:

    existence (deterministic) → support (only if existence passed, FR-TRUST-9)
      → source flags → status (``decide``) → ``NewCitation``

``verify_markers`` walks a parsed model reply: each ``[[p:N]]`` marker becomes ``[[c:<id>]]``
for the citation built from passage N. A marker for a passage the model was never shown cannot
be attributed to any source, so it is removed and counted.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import Connection, Engine, text

from caseguard_ai.research.parse import Reply
from caseguard_ai.research.store import NewCitation
from caseguard_ai.retrieval.hybrid import CORPUS, Passage
from caseguard_ai.trust import existence
from caseguard_ai.trust.status import VERIFIER_VERSION, Support, decide, source_flags
from caseguard_ai.trust.support import SupportChecker, SupportResult


def passage_heading(p: Passage) -> str:
    """How a passage is introduced to the model, after its ``[p:N]`` number."""
    parts = [p.title or "Case document", p.locator or ""]
    heading = " — ".join(x for x in parts if x)
    return heading + (" (head-note only)" if p.headnote_only else "")


def quote_languages(engine: Engine, passages: list[Passage]) -> dict[uuid.UUID, str]:
    """The language of each cited corpus source, for the quote (FR-RES-10)."""
    ids = [p.document_id for p in passages if p.origin == CORPUS]
    if not ids:
        return {}
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT id, language FROM corpus.documents WHERE id = ANY(:ids)"), {"ids": ids}
        )
        return {r.id: r.language for r in rows}


def tidy(answer: str) -> str:
    """Spaces left where a dropped marker was: no double spaces, none before punctuation."""
    answer = re.sub(r"[ \t]{2,}", " ", answer)
    return re.sub(r"[ \t]+([.,;:])", r"\1", answer).strip()


def verify_citation(
    conn: Connection,
    passage: Passage,
    quote: str | None,
    claim: str,
    *,
    support_checker: SupportChecker,
    allowed_providers: list[str] | None,
    quote_language: str | None,
    now: datetime,
    stale_days: int | None,
) -> NewCitation:
    """Run the checks for one claim citing one passage, and build its stored citation."""
    checked = existence.check(conn, passage, quote)
    # Support runs only after existence passed (FR-TRUST-9): a model never sees, and never
    # rescues, a citation the deterministic check already failed.
    supported: SupportResult | None = None
    if checked.passed:
        supported = support_checker.check(
            claim, checked.span or passage.text, allowed_providers=allowed_providers
        )
    support: Support = supported.verdict if supported else "not_run"
    flags = source_flags(
        headnote_only=passage.headnote_only,
        third_party=passage.third_party,
        # Case passages are the user's own material: never stale.
        retrieved_at=passage.retrieved_at,
        now=now,
        stale_days=stale_days if passage.origin == CORPUS else None,
    )
    checks: dict[str, Any] = {
        "existence": "pass" if checked.passed else "fail",
        "support": support,
        "currency": "unknown",
        "existence_reason": checked.reason,
    }
    if supported is not None:
        checks["support_method"] = supported.method
        if supported.score is not None:
            checks["support_score"] = supported.score
    return NewCitation(
        id=uuid.uuid4(),
        source_id=passage.document_id,
        chunk_id=passage.chunk_id,
        claim=claim,
        locator=passage.locator,
        quote=checked.span,
        quote_language=quote_language,
        status=decide("pass" if checked.passed else "fail", support, flags),
        flags=flags,
        checks=checks,
        verifier_version=VERIFIER_VERSION,
    )


@dataclass(frozen=True)
class Verified:
    text: str  # the reply text with [[c:<id>]] markers, before tidying
    citations: list[NewCitation]
    invalid_markers: int


def verify_markers(
    conn: Connection,
    reply: Reply,
    numbered: Mapping[int, Passage],
    *,
    support_checker: SupportChecker,
    allowed_providers: list[str] | None,
    languages: Mapping[uuid.UUID, str],
    now: datetime,
    stale_days: int | None,
) -> Verified:
    """Check every marker of ``reply`` against the passages the model was shown."""
    new: list[NewCitation] = []
    pieces: list[str] = []
    cursor = 0
    invalid = 0
    for marker in reply.markers:
        pieces.append(reply.text[cursor : marker.start])
        cursor = marker.end
        passage = numbered.get(marker.passage)
        if passage is None:
            invalid += 1
            continue
        citation = verify_citation(
            conn,
            passage,
            reply.quotes.get(marker.passage),
            marker.claim or reply.text.strip()[:500],
            support_checker=support_checker,
            allowed_providers=allowed_providers,
            quote_language=languages.get(passage.document_id),
            now=now,
            stale_days=stale_days,
        )
        new.append(citation)
        pieces.append(f"[[c:{citation.id}]]")
    pieces.append(reply.text[cursor:])
    return Verified("".join(pieces), new, invalid)
