"""Draft one section of a document with checked, stored citations (#212, ai.v1 ``draftSection``).

    retrieve within the scope → prompt draft-section-v1 with numbered passages → generation
      (gateway, allow-list only) → parse_reply → trust.verify (existence, then support, then
      flags and status) → one transaction: ai.answer_traces + ai.citations + ai.verifications
      → read the citations back → response

- **Fails closed** exactly as ``answer_question``: no allowed generation provider is a
  ``NoProviderError`` (503) before any work (SEC-11).
- **Same trust layer, same store** as research (FR-DRAFT-3, FR-TRUST-10). The statuses returned
  are the stored ones, read back.
- **Audit (FR-TRUST-12).** One trace row per request, with ``models.prompt`` naming the drafting
  prompt and ``models.kind`` = ``drafting``. The instruction and the field values are never stored
  or logged: the trace holds only retrieval ids and scores.
- A section that cites nothing (the model found no law, or the section needs none) is returned as
  plain text with no citations.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import Engine

from caseguard_ai.drafting.catalog import Template, TemplateSection
from caseguard_ai.drafting.prompts import draft_section_v1 as prompt
from caseguard_ai.gateway.client import ModelGateway
from caseguard_ai.gateway.providers import ProviderConfig
from caseguard_ai.ingest.embedder import Embedder
from caseguard_ai.research import store
from caseguard_ai.research.parse import answer_text, parse_reply
from caseguard_ai.retrieval.hybrid import Passage, Scope, retrieve
from caseguard_ai.retrieval.reranker import Reranker
from caseguard_ai.trust.status import VERIFIER_VERSION
from caseguard_ai.trust.support import SupportChecker
from caseguard_ai.trust.verify import passage_heading, quote_languages, tidy, verify_markers

QUERY_CHARS = 1000  # the retrieval query: heading, instruction and particulars, capped
CONTEXT_CHARS = 2000  # each other section shown to the model, capped


@dataclass(frozen=True)
class SectionRequest:
    request_id: uuid.UUID
    template: Template
    section: TemplateSection
    scope: Scope
    instruction: str | None = None
    fields: Mapping[str, str | None] = field(default_factory=dict)
    other_sections: Sequence[tuple[str, str]] = ()  # (key, body)
    allowed_providers: list[str] | None = None
    generation_override: ProviderConfig | None = None


def _particulars(r: SectionRequest) -> list[tuple[str, str]]:
    """The template's fields that have a value, by label, in template order. Unknown keys are
    ignored (ai.v1)."""
    out = []
    for f in r.template.fields:
        value = (r.fields.get(f.key) or "").strip()
        if value:
            out.append((f.label, value))
    return out


def _query(r: SectionRequest, particulars: list[tuple[str, str]]) -> str:
    parts = [r.template.title, r.section.heading, r.instruction or ""]
    parts += [v.replace("\n", "; ") for _, v in particulars]
    return " ".join(p for p in parts if p)[:QUERY_CHARS]


def _context(r: SectionRequest) -> list[tuple[str, str]]:
    """The other sections that have text, by heading, in template order."""
    bodies = {key: body for key, body in r.other_sections if key != r.section.key}
    out = []
    for s in r.template.sections:
        body = bodies.get(s.key, "").strip()
        if body:
            out.append((s.heading, body[:CONTEXT_CHARS]))
    return out


def _messages(
    r: SectionRequest, particulars: list[tuple[str, str]], passages: list[Passage]
) -> list[dict[str, str]]:
    body = prompt.user_message(
        document=r.template.title,
        heading=r.section.heading,
        guidance=r.section.guidance,
        instruction=r.instruction,
        particulars=particulars,
        other_sections=_context(r),
        passages=[(passage_heading(p), p.text) for p in passages],
    )
    return [{"role": "system", "content": prompt.SYSTEM}, {"role": "user", "content": body}]


def draft_section(
    engine: Engine,
    r: SectionRequest,
    *,
    gateway: ModelGateway,
    embedder: Embedder,
    reranker: Reranker,
    support_checker: SupportChecker,
    stale_days: int | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    # Fail closed before any work.
    gateway.provider_for("generation", r.allowed_providers, r.generation_override)

    particulars = _particulars(r)
    with engine.connect() as conn:
        found = retrieve(conn, _query(r, particulars), r.scope, embedder, reranker)
    passages = found.passages
    result = gateway.chat(
        "generation",
        _messages(r, particulars, passages),
        r.allowed_providers,
        override=r.generation_override,
    )
    models: dict[str, Any] = {
        "kind": "drafting",
        "prompt": prompt.VERSION,
        "template": f"{r.template.id}@{r.template.version}",
        "section": r.section.key,
        "embedding": f"{embedder.model_id}@{embedder.revision}",
        "reranker": reranker.model_id,
        "verifier": VERIFIER_VERSION,
        "support": support_checker.model_id,
        "generation": result.model,
    }
    reply = parse_reply(result.text)
    numbered = {i: p for i, p in enumerate(passages, start=1)}
    languages = quote_languages(engine, passages) if reply.answerable else {}
    now = datetime.now(UTC)  # one clock for every citation in this section
    with engine.begin() as conn:
        if reply.answerable:
            verified = verify_markers(
                conn,
                reply,
                numbered,
                support_checker=support_checker,
                allowed_providers=r.allowed_providers,
                languages=languages,
                now=now,
                stale_days=stale_days,
            )
            text_out, new, invalid = (
                tidy(verified.text),
                verified.citations,
                verified.invalid_markers,
            )
        else:
            text_out, new, invalid = answer_text(result.text), [], 0
        models["invalid_markers"] = invalid
        store.write_answer(
            conn,
            request_id=r.request_id,
            answerable=bool(text_out),
            trace=found.trace(),
            models=models,
            provider=result.provider_id,
            latency_ms=round((time.perf_counter() - started) * 1000),
            new_citations=new,
        )
    with engine.connect() as conn:
        stored = store.read_citations(conn, [c.id for c in new])
    return {"requestId": str(r.request_id), "text": text_out, "citations": stored}
