"""Answer a research question with checked, stored citations (#20, ai.v1 ``answerQuestion``).

    retrieve (#19) → prompt with numbered passages → generation (gateway, allow-list only)
      → parse [[p:N]] markers and quotes → existence check → status → one transaction:
        ai.answer_traces + ai.citations + ai.verifications → read the statuses back → response

- **Fails closed.** A request whose allow-list has no configured generation provider is refused
  before any work (``NoProviderError`` → 503, SEC-11).
- **Unanswerable** (FR-RES-9): nothing retrieved, the model replies NOT_ANSWERABLE, or its answer
  cites nothing. The response is ``answerable=false`` with no citations, and the trace is kept.
- **Statuses come from the store** (FR-TRUST-10): what the response shows is what was read back.
- A marker that points at a passage number the model was not shown cannot be attributed to any
  source, so it is removed from the text and counted in the trace (``models.invalid_markers``).
- Nothing here logs or stores the question text; the api keeps the audit record (FR-TRUST-12).
"""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import Engine, text

from caseguard_ai.gateway.client import ModelGateway
from caseguard_ai.gateway.providers import ProviderConfig
from caseguard_ai.ingest.embedder import Embedder
from caseguard_ai.research import store
from caseguard_ai.research.parse import Reply, parse_reply
from caseguard_ai.research.prompts import answer_v1 as prompt
from caseguard_ai.retrieval.hybrid import CORPUS, Passage, Retrieval, Scope, retrieve
from caseguard_ai.retrieval.reranker import Reranker
from caseguard_ai.trust import existence
from caseguard_ai.trust.status import VERIFIER_VERSION, decide, source_flags

HISTORY_TURNS = 6  # recent turns sent to the model; small models lose the passages otherwise
UNANSWERABLE_TEXT = (
    "The sources in the corpus do not answer this question, so no answer is given. "
    "Try rephrasing it, or name the statute or section you mean."
)


@dataclass(frozen=True)
class Question:
    request_id: uuid.UUID
    question: str
    scope: Scope
    language: str | None = None
    history: list[tuple[str, str]] = field(default_factory=list)  # (role, content)
    allowed_providers: list[str] | None = None
    # A user's own key and model for the generation role (FR-SET-2). Lives for this request only.
    generation_override: ProviderConfig | None = None


def _tidy(answer: str) -> str:
    """Spaces left where a dropped marker was: no double spaces, none before punctuation."""
    answer = re.sub(r"[ \t]{2,}", " ", answer)
    return re.sub(r"[ \t]+([.,;:])", r"\1", answer).strip()


def _heading(p: Passage) -> str:
    parts = [p.title or "Case document", p.locator or ""]
    heading = " — ".join(x for x in parts if x)
    return heading + (" (head-note only)" if p.headnote_only else "")


def _quote_languages(engine: Engine, passages: list[Passage]) -> dict[uuid.UUID, str]:
    ids = [p.document_id for p in passages if p.origin == CORPUS]
    if not ids:
        return {}
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT id, language FROM corpus.documents WHERE id = ANY(:ids)"), {"ids": ids}
        )
        return {r.id: r.language for r in rows}


def _messages(q: Question, passages: list[Passage], language: str) -> list[dict[str, str]]:
    messages = [{"role": "system", "content": prompt.SYSTEM}]
    for role, content in q.history[-HISTORY_TURNS:]:
        messages.append({"role": role, "content": content})
    body = prompt.user_message(q.question, [(_heading(p), p.text) for p in passages], language)
    messages.append({"role": "user", "content": body})
    return messages


def answer_question(
    engine: Engine,
    q: Question,
    *,
    gateway: ModelGateway,
    embedder: Embedder,
    reranker: Reranker,
) -> dict[str, Any]:
    started = time.perf_counter()
    language = q.language or "en"
    # Fail closed before any work.
    gateway.provider_for("generation", q.allowed_providers, q.generation_override)

    with engine.connect() as conn:
        found: Retrieval = retrieve(conn, q.question, q.scope, embedder, reranker)
    passages = found.passages
    models: dict[str, Any] = {
        "embedding": f"{embedder.model_id}@{embedder.revision}",
        "reranker": reranker.model_id,
        "prompt": prompt.VERSION,
        "verifier": VERIFIER_VERSION,
    }

    reply = Reply(answerable=False)
    provider: str | None = None
    if passages:
        result = gateway.chat(
            "generation",
            _messages(q, passages, language),
            q.allowed_providers,
            override=q.generation_override,
        )
        provider = result.provider_id
        models["generation"] = result.model
        reply = parse_reply(result.text)

    numbered = {i: p for i, p in enumerate(passages, start=1)}
    languages = _quote_languages(engine, passages) if reply.answerable else {}
    new: list[store.NewCitation] = []
    pieces: list[str] = []
    cursor = 0
    invalid = 0
    with engine.begin() as conn:
        for marker in reply.markers:
            pieces.append(reply.text[cursor : marker.start])
            cursor = marker.end
            passage = numbered.get(marker.passage)
            if passage is None:
                invalid += 1
                continue
            checked = existence.check(conn, passage, reply.quotes.get(marker.passage))
            flags = source_flags(
                headnote_only=passage.headnote_only, third_party=passage.third_party
            )
            checks = {
                "existence": "pass" if checked.passed else "fail",
                "support": "not_run",  # the support check comes after M1 (PRD §7.1 step 2)
                "currency": "unknown",
                "existence_reason": checked.reason,
            }
            citation = store.NewCitation(
                id=uuid.uuid4(),
                source_id=passage.document_id,
                chunk_id=passage.chunk_id,
                claim=marker.claim or reply.text.strip()[:500],
                locator=passage.locator,
                quote=checked.span,
                quote_language=languages.get(passage.document_id),
                status=decide("pass" if checked.passed else "fail", "not_run", flags),
                flags=flags,
                checks=checks,
                verifier_version=VERIFIER_VERSION,
            )
            new.append(citation)
            pieces.append(f"[[c:{citation.id}]]")
        pieces.append(reply.text[cursor:])
        answerable = reply.answerable and bool(new)
        models["invalid_markers"] = invalid
        store.write_answer(
            conn,
            request_id=q.request_id,
            answerable=answerable,
            trace=found.trace(),
            models=models,
            provider=provider,
            latency_ms=round((time.perf_counter() - started) * 1000),
            new_citations=new if answerable else [],
        )

    if not answerable:
        return {
            "requestId": str(q.request_id),
            "answerable": False,
            "language": language,
            "text": UNANSWERABLE_TEXT,
            "citations": [],
        }
    with engine.connect() as conn:
        stored = store.read_citations(conn, [c.id for c in new])
    return {
        "requestId": str(q.request_id),
        "answerable": True,
        "language": language,
        "text": _tidy("".join(pieces)),
        "citations": stored,
    }
