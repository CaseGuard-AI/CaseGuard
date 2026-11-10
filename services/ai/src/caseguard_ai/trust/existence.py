"""The deterministic existence check (PRD §7.1 step 1, FR-TRUST-9, FR-RES-10).

A citation passes only when all of these hold:

1. it points at a passage that retrieval returned for this question (the model cannot cite
   something it was never shown);
2. that passage's document still exists in the corpus (or, for a case chunk, the chunk was read
   under the request's scope);
3. its quote is a verbatim span of that passage's text.

On (3): PDF text breaks lines mid-sentence, and a model quoting "shall be punished with death"
cannot reproduce where the line breaks fell. So runs of whitespace match any whitespace, and
nothing else is forgiven: every character, its case and its punctuation must match. What is
stored is the span **as it appears in the source**, so the stored quote is a byte-for-byte
substring of the chunk (FR-RES-10).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import Connection, text

from caseguard_ai.retrieval.hybrid import CORPUS, Passage

MIN_QUOTE_CHARS = 12  # shorter "quotes" ("the", "s. 302") prove nothing about the passage

_STRIP = " \t\r\n\"'“”‘’«»"


@dataclass(frozen=True)
class ExistenceResult:
    passed: bool
    reason: str  # "ok" or why it failed, stored in verifications.checks
    span: str | None = None  # the quote as it appears in the source


def find_span(passage_text: str, quote: str) -> str | None:
    """The verbatim span of ``passage_text`` that ``quote`` reproduces, or None."""
    words = quote.strip(_STRIP).split()
    if not words:
        return None
    pattern = r"\s+".join(re.escape(w) for w in words)
    match = re.search(pattern, passage_text)
    return match.group(0) if match else None


def _document_exists(conn: Connection, passage: Passage) -> bool:
    if passage.origin != CORPUS:
        return True  # read moments ago under the request's scope (retrieval.hybrid)
    found = conn.execute(
        text("SELECT 1 FROM corpus.documents WHERE id = :id"), {"id": passage.document_id}
    ).first()
    return found is not None


def check(conn: Connection, passage: Passage | None, quote: str | None) -> ExistenceResult:
    if passage is None:
        return ExistenceResult(False, "the cited passage was not retrieved for this question")
    if not _document_exists(conn, passage):
        return ExistenceResult(False, "the cited document is no longer in the corpus")
    if not quote or len(quote.strip(_STRIP)) < MIN_QUOTE_CHARS:
        return ExistenceResult(False, "no verbatim quote was given")
    span = find_span(passage.text, quote)
    if span is None:
        return ExistenceResult(False, "the quote is not in the cited passage")
    return ExistenceResult(True, "ok", span)
