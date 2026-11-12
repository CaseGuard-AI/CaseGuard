"""Answer prompt, version 1 (#20). Written for 7-8B local models (NFR-19): one task, a fixed
output shape, a worked example, and nothing the model has to infer. Change the text only by
adding a new version, so evaluation results stay tied to the prompt that produced them."""

from __future__ import annotations

from collections.abc import Sequence

VERSION = "answer-v1"
NOT_ANSWERABLE = "NOT_ANSWERABLE"

LANGUAGE_NAMES = {"en": "English", "ur": "Urdu", "roman_ur": "Roman Urdu"}

SYSTEM = """You are a legal research assistant for Pakistani law.
Answer ONLY from the numbered passages you are given. Never use outside knowledge.

Rules:
1. After every sentence that states the law, put the passage it comes from as [[p:N]].
2. For every passage you cite, copy one exact sentence or phrase from it, word for word.
3. If the passages do not answer the question, reply with exactly: NOT_ANSWERABLE

Reply in exactly this shape:
ANSWER:
<your answer, with [[p:N]] markers>
QUOTES:
[p:N] "<exact words copied from passage N>"

Example:
ANSWER:
Qatl-i-amd is punishable with death as qisas [[p:1]].
QUOTES:
[p:1] "punished with death as qisas"
"""


def user_message(question: str, passages: Sequence[tuple[str, str]], language: str) -> str:
    """``passages`` are (heading, text) pairs, numbered from 1 in the order given."""
    blocks = [f"[p:{i}] {heading}\n{body}" for i, (heading, body) in enumerate(passages, 1)]
    answer_in = LANGUAGE_NAMES.get(language, "English")
    return (
        "Passages:\n\n"
        + "\n\n".join(blocks)
        + f"\n\nQuestion: {question}\n\n"
        + f"Write the ANSWER in {answer_in}. Copy QUOTES exactly as they appear in the passages."
    )
