"""Read the model's reply (prompt ``answer-v1``) into an answer, its markers and quotes.

Lenient where small models drift (extra spaces, a missing "ANSWER:" line, curly quotes), strict
where it matters: a passage number is only ever taken from a ``[[p:N]]`` marker, and a quote
only from a ``[p:N]`` line, so nothing is guessed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from caseguard_ai.research.prompts.answer_v1 import NOT_ANSWERABLE

MARKER = re.compile(r"\[\[\s*p\s*:\s*(\d+)\s*\]\]")
_QUOTE_LINE = re.compile(r"^\s*\[\s*p\s*:\s*(\d+)\s*\]\s*[:\-]?\s*(.+?)\s*$")
_SECTION = re.compile(r"^\s*(ANSWER|QUOTES)\s*:\s*$", re.I | re.M)
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


@dataclass(frozen=True)
class Marker:
    start: int  # offset of the marker in Reply.text
    end: int
    passage: int  # 1-based, as shown to the model
    claim: str  # the sentence the marker supports, without markers


@dataclass
class Reply:
    answerable: bool
    text: str = ""
    markers: list[Marker] = field(default_factory=list)
    quotes: dict[int, str] = field(default_factory=dict)


def _sections(raw: str) -> tuple[str, str]:
    """(answer part, quotes part). Without headings, everything is the answer."""
    parts: dict[str, str] = {}
    matches = list(_SECTION.finditer(raw))
    if not matches:
        return raw.strip(), ""
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(raw)
        parts.setdefault(m.group(1).upper(), raw[m.end() : end].strip())
    return parts.get("ANSWER", ""), parts.get("QUOTES", "")


def _claim(text: str, start: int, end: int) -> str:
    """The sentence around a marker, with every marker removed."""
    left = max((m.end() for m in _SENTENCE_END.finditer(text, 0, start)), default=0)
    right_match = _SENTENCE_END.search(text, end)
    right = right_match.start() if right_match else len(text)
    sentence = " ".join(MARKER.sub("", text[left:right]).split())
    return re.sub(r"\s+([.,;:!?])", r"\1", sentence)


def parse_reply(raw: str) -> Reply:
    if raw.strip().upper().startswith(NOT_ANSWERABLE) or NOT_ANSWERABLE in raw.upper():
        return Reply(answerable=False)
    answer, quotes_part = _sections(raw)
    quotes: dict[int, str] = {}
    for line in quotes_part.splitlines():
        m = _QUOTE_LINE.match(line)
        if m:
            quotes.setdefault(int(m.group(1)), m.group(2))
    markers = [
        Marker(m.start(), m.end(), int(m.group(1)), _claim(answer, m.start(), m.end()))
        for m in MARKER.finditer(answer)
    ]
    if not answer or not markers:
        # An answer with no citations at all cannot be shown as a legal answer (FR-RES-5).
        return Reply(answerable=False)
    return Reply(answerable=True, text=answer, markers=markers, quotes=quotes)
