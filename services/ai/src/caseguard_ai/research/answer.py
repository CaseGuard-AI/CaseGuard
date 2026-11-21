"""Answer a research question with checked, stored citations (#20, ai.v1 ``answerQuestion``).

    retrieve (#19) → prompt with numbered passages → generation (gateway, allow-list only)
      → parse [[p:N]] markers and quotes → existence check → support check (only if existence
        passed) → status → one transaction:
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

import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import Engine

from caseguard_ai.gateway.client import ModelGateway
from caseguard_ai.gateway.providers import ProviderConfig
from caseguard_ai.ingest.embedder import Embedder
from caseguard_ai.research import store
from caseguard_ai.research.parse import Reply, parse_reply
from caseguard_ai.research.prompts import answer_v1 as prompt
from caseguard_ai.retrieval.hybrid import Passage, Retrieval, Scope, retrieve
from caseguard_ai.retrieval.reranker import Reranker
from caseguard_ai.trust.status import VERIFIER_VERSION
from caseguard_ai.trust.support import SupportChecker
from caseguard_ai.trust.verify import passage_heading, quote_languages, tidy, verify_markers

HISTORY_TURNS = 6  # recent turns sent to the model; small models lose the passages otherwise
UNANSWERABLE_TEXT = (
    "The sources in the corpus do not answer this question, so no answer is given. "
    "Try rephrasing it, or name the statute or section you mean."
)
# What a "law as of" date changed (FR-RES-11), in the answer's language. Statutes are not
# versioned yet (FR-TEMP-* is a later module), so the note says the text is the current one.
AS_OF_NOTES = {
    "en": (
        "Law as of {d}: judgments decided after this date were left out. Statute text is the "
        "current version, because historical versions are not curated yet."
    ),
    "ur": (
        "{d} تک کا قانون: اس تاریخ کے بعد کے فیصلے شامل نہیں کیے گئے۔ قوانین کا متن موجودہ "
        "ہے، کیونکہ پرانے ورژن ابھی مرتب نہیں کیے گئے۔"
    ),
    "roman_ur": (
        "{d} tak ka qanoon: is tareekh ke baad ke faislay shamil nahin kiye gaye. Qawaneen ka "
        "matan maujooda version hai, kyunke purane versions abhi murattab nahin kiye gaye."
    ),
}


def as_of_note(law_as_of: date, language: str) -> str:
    return AS_OF_NOTES.get(language, AS_OF_NOTES["en"]).format(d=law_as_of.isoformat())


@dataclass(frozen=True)
class Question:
    request_id: uuid.UUID
    question: str
    scope: Scope
    language: str | None = None
    law_as_of: date | None = None
    history: list[tuple[str, str]] = field(default_factory=list)  # (role, content)
    allowed_providers: list[str] | None = None
    # A user's own key and model for the generation role (FR-SET-2). Lives for this request only.
    generation_override: ProviderConfig | None = None


def _messages(q: Question, passages: list[Passage], language: str) -> list[dict[str, str]]:
    messages = [{"role": "system", "content": prompt.SYSTEM}]
    for role, content in q.history[-HISTORY_TURNS:]:
        messages.append({"role": role, "content": content})
    body = prompt.user_message(
        q.question, [(passage_heading(p), p.text) for p in passages], language
    )
    messages.append({"role": "user", "content": body})
    return messages


def answer_question(
    engine: Engine,
    q: Question,
    *,
    gateway: ModelGateway,
    embedder: Embedder,
    reranker: Reranker,
    support_checker: SupportChecker,
    stale_days: int | None = None,  # FR-TRUST-6 review window; None = never flag "stale"
) -> dict[str, Any]:
    started = time.perf_counter()
    language = q.language or "en"
    # Fail closed before any work.
    gateway.provider_for("generation", q.allowed_providers, q.generation_override)

    with engine.connect() as conn:
        found: Retrieval = retrieve(
            conn, q.question, q.scope, embedder, reranker, law_as_of=q.law_as_of
        )
    passages = found.passages
    models: dict[str, Any] = {
        "embedding": f"{embedder.model_id}@{embedder.revision}",
        "reranker": reranker.model_id,
        "prompt": prompt.VERSION,
        "verifier": VERIFIER_VERSION,
        "support": support_checker.model_id,
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

    now = datetime.now(UTC)  # one clock for every citation in this answer
    numbered = {i: p for i, p in enumerate(passages, start=1)}
    languages = quote_languages(engine, passages) if reply.answerable else {}
    with engine.begin() as conn:
        verified = verify_markers(
            conn,
            reply,
            numbered,
            support_checker=support_checker,
            allowed_providers=q.allowed_providers,
            languages=languages,
            now=now,
            stale_days=stale_days,
        )
        new = verified.citations
        answerable = reply.answerable and bool(new)
        models["invalid_markers"] = verified.invalid_markers
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

    note = {"asOfNote": as_of_note(q.law_as_of, language)} if q.law_as_of else {}
    if not answerable:
        return {
            "requestId": str(q.request_id),
            "answerable": False,
            "language": language,
            "text": UNANSWERABLE_TEXT,
            "citations": [],
            **note,
        }
    with engine.connect() as conn:
        stored = store.read_citations(conn, [c.id for c in new])
    return {
        "requestId": str(q.request_id),
        "answerable": True,
        "language": language,
        "text": tidy(verified.text),
        "citations": stored,
        **note,
    }
