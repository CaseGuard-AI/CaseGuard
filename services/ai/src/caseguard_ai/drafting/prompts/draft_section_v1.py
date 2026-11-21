"""Section drafting prompt, version 1 (#212). The output shape is ``answer-v1``'s (``ANSWER:``
with ``[[p:N]]`` markers, then ``QUOTES:`` with ``[p:N] "..."`` lines), so
``research.parse.parse_reply`` reads it unchanged. Written for 7-8B local models (NFR-19).
Change the text only by adding a new version."""

from __future__ import annotations

from collections.abc import Sequence

VERSION = "draft-section-v1"

SYSTEM = """You draft one section of a Pakistani court document for a lawyer.
Use ONLY the numbered passages you are given for any statement of law. Never use outside law.

Rules:
1. Write only the section asked for, in formal legal English, as the lawyer would file it.
2. After every sentence that states the law, put the passage it comes from as [[p:N]].
3. For every passage you cite, copy one exact sentence or phrase from it, word for word.
4. Use the particulars given. Never invent names, dates, numbers or facts; write [____] where
   one is missing.
5. If no passage states the law you need, write the section without any [[p:N]] marker.

Reply in exactly this shape:
ANSWER:
<the section text, with [[p:N]] markers>
QUOTES:
[p:N] "<exact words copied from passage N>"

Example:
ANSWER:
1. That the offence alleged does not fall within the prohibitory clause, so bail is the rule
and refusal the exception [[p:1]].
QUOTES:
[p:1] "may be released on bail"
"""


def user_message(
    *,
    document: str,
    heading: str,
    guidance: str,
    instruction: str | None,
    particulars: Sequence[tuple[str, str]],
    other_sections: Sequence[tuple[str, str]],
    passages: Sequence[tuple[str, str]],
) -> str:
    """``particulars`` are (label, value), ``other_sections`` (heading, body) and ``passages``
    (heading, text) pairs; passages are numbered from 1 in the order given."""
    blocks = [f"[p:{i}] {h}\n{body}" for i, (h, body) in enumerate(passages, 1)]
    facts = [f"- {label}: {value}" for label, value in particulars]
    context = [f"## {h}\n{body}" for h, body in other_sections]
    parts = [
        "Passages:\n\n" + ("\n\n".join(blocks) if blocks else "(none)"),
        f"Document: {document}",
        "Particulars:\n" + ("\n".join(facts) if facts else "(none given)"),
    ]
    if context:
        parts.append("The other sections as drafted so far:\n\n" + "\n\n".join(context))
    parts.append(f"Section to draft: {heading}\nWhat it must contain: {guidance}")
    if instruction:
        parts.append(f"The lawyer's instruction: {instruction}")
    parts.append("Write the ANSWER in English. Copy QUOTES exactly as they appear in the passages.")
    return "\n\n".join(parts)
