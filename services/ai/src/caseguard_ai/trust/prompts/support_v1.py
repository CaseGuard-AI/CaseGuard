"""Support-judge prompt, version 1 (FR-TRUST-3, PRD §7.1 step 2). Asked only when the NLI model
is inconclusive. Written for 7-8B local models (NFR-19): one question, one word back. Change the
text only by adding a new version, so evaluation results stay tied to the prompt that produced
them."""

from __future__ import annotations

import re
from typing import Literal

VERSION = "support-v1"

SUPPORTED = "SUPPORTED"
NOT_SUPPORTED = "NOT_SUPPORTED"
UNCLEAR = "UNCLEAR"

SYSTEM = """You check citations for a Pakistani legal research tool.
You are given a CLAIM and the EVIDENCE quoted from the cited source.
Decide ONLY from the EVIDENCE. Never use outside knowledge.

Reply with exactly one word:
SUPPORTED      if the evidence states what the claim says (a paraphrase is fine)
NOT_SUPPORTED  if the evidence says something different (another punishment, section, condition)
UNCLEAR        if the evidence is about something else, or is not enough to decide

Example:
CLAIM: Qatl-i-amd is punishable with death as qisas.
EVIDENCE: Whoever commits qatl-i-amd shall be punished with death as qisas.
SUPPORTED
"""


def user_message(claim: str, evidence: str) -> str:
    return f"CLAIM: {claim}\nEVIDENCE: {evidence}\n\nReply with one word: SUPPORTED, NOT_SUPPORTED or UNCLEAR."


Verdict = Literal["pass", "fail", "uncertain"]

_WORD = re.compile(r"\b(NOT[\s_-]*SUPPORTED|SUPPORTED|UNCLEAR)\b", re.I)


def parse(reply: str) -> Verdict:
    """The verdict in a judge reply. Anything ambiguous is ``uncertain``, never ``pass``.

    Models sometimes explain after the label, so the label may sit anywhere in the reply. But
    every label it mentions must agree: "SUPPORTED or NOT_SUPPORTED?" is uncertain.
    """
    found = {re.sub(r"[\s_-]+", "_", m.upper()) for m in _WORD.findall(reply)}
    if len(found) != 1:
        return "uncertain"
    (label,) = found
    if label == SUPPORTED:
        return "pass"
    if label == NOT_SUPPORTED:
        return "fail"
    return "uncertain"
