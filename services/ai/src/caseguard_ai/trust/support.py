"""The citation support check (PRD §7.1 step 2, FR-TRUST-3, FR-TRUST-9).

Does the cited evidence support the claim it is attached to? It runs only after the
deterministic existence check has passed, and its verdict can never lift a failed existence
(``trust.status.decide``).

- ``NliSupportChecker``: a multilingual NLI cross-encoder (in-process, ADR-0008), pinned to a
  revision. P(entailment) at or above the pass threshold → ``pass``; P(contradiction) at or above
  the fail threshold → ``fail``; anything else → ``uncertain``.
- ``FallbackSupportChecker``: NLI first, and the LLM judge (``LlmSupportChecker``) only when NLI
  is uncertain **and** the request's allow-list reaches a judge provider. It never widens the
  allow-list (SEC-11); without an allowed judge the NLI verdict stands.
- ``StubSupportChecker``: a deterministic stand-in for tests and CI (word overlap). Never use it
  for real answers.

Nothing here logs the claim or the evidence: only verdicts, scores and provider ids.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, Protocol

import structlog

from caseguard_ai.trust.prompts import support_v1 as prompt

if TYPE_CHECKING:
    from caseguard_ai.gateway.client import ModelGateway

log = structlog.get_logger("support")

Verdict = Literal["pass", "uncertain", "fail"]


@dataclass(frozen=True)
class SupportResult:
    verdict: Verdict
    score: float | None  # P(entailment) from NLI; None when no model score exists
    method: str  # "nli", "nli+llm", "stub"


class SupportChecker(Protocol):
    model_id: str

    def check(
        self, claim: str, evidence: str, *, allowed_providers: list[str] | None = None
    ) -> SupportResult: ...


# ── NLI ────────────────────────────────────────────────────────────────────────────────────


def softmax(logits: Sequence[float]) -> list[float]:
    top = max(logits)
    exps = [math.exp(x - top) for x in logits]
    total = sum(exps)
    return [e / total for e in exps]


def label_indices(id2label: Mapping[Any, str]) -> tuple[int, int]:
    """(entailment index, contradiction index), read from the model config, never assumed."""
    entail = contra = None
    for key, name in id2label.items():
        lowered = name.lower()
        if lowered.startswith("entail"):
            entail = int(key)
        elif lowered.startswith("contradict"):
            contra = int(key)
    if entail is None or contra is None:
        raise ValueError(f"not an NLI model: labels are {sorted(id2label.values())}")
    return entail, contra


def verdict_from_logits(
    logits: Sequence[float],
    id2label: Mapping[Any, str],
    *,
    pass_threshold: float,
    fail_threshold: float,
) -> SupportResult:
    probs = softmax(logits)
    entail, contra = label_indices(id2label)
    p_entail, p_contra = probs[entail], probs[contra]
    if p_entail >= pass_threshold:
        verdict: Verdict = "pass"
    elif p_contra >= fail_threshold:
        verdict = "fail"
    else:
        verdict = "uncertain"
    return SupportResult(verdict, round(p_entail, 4), "nli")


class NliSupportChecker:
    """Premise = the evidence, hypothesis = the claim (the usual NLI order)."""

    def __init__(
        self,
        model_id: str,
        revision: str,
        *,
        pass_threshold: float = 0.7,
        fail_threshold: float = 0.7,
        device: str | None = None,
        max_length: int = 512,
    ) -> None:
        # heavy: only when used
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        from caseguard_ai.ingest.embedder import default_device

        self.model_id = model_id
        self.revision = revision
        self.pass_threshold = pass_threshold
        self.fail_threshold = fail_threshold
        self.max_length = max_length
        self.device = device or default_device()
        self._tokenizer: Any = AutoTokenizer.from_pretrained(model_id, revision=revision)
        self._model: Any = AutoModelForSequenceClassification.from_pretrained(
            model_id, revision=revision
        )
        self._model.to(self.device).eval()
        self.id2label: dict[int, str] = dict(self._model.config.id2label)
        label_indices(self.id2label)  # refuse a model without entailment/contradiction labels

    def logits(self, claim: str, evidence: str) -> list[float]:
        import torch

        inputs = self._tokenizer(
            evidence,
            claim,
            truncation=True,
            max_length=self.max_length,
            return_tensors="pt",
        ).to(self.device)
        with torch.no_grad():
            out = self._model(**inputs).logits[0]
        return [float(x) for x in out]

    def check(
        self, claim: str, evidence: str, *, allowed_providers: list[str] | None = None
    ) -> SupportResult:
        return verdict_from_logits(
            self.logits(claim, evidence),
            self.id2label,
            pass_threshold=self.pass_threshold,
            fail_threshold=self.fail_threshold,
        )


# ── LLM judge ──────────────────────────────────────────────────────────────────────────────


class LlmSupportChecker:
    """The judge role through the gateway. Any gateway failure is ``uncertain``: the support
    check never raises into the answer."""

    model_id = prompt.VERSION

    def __init__(self, gateway: ModelGateway) -> None:
        self._gateway = gateway

    def available(self, allowed_providers: list[str] | None) -> bool:
        from caseguard_ai.gateway.client import NoProviderError

        try:
            self._gateway.provider_for("judge", allowed_providers)
        except NoProviderError:
            return False
        return True

    def check(
        self, claim: str, evidence: str, *, allowed_providers: list[str] | None = None
    ) -> SupportResult:
        messages = [
            {"role": "system", "content": prompt.SYSTEM},
            {"role": "user", "content": prompt.user_message(claim, evidence)},
        ]
        try:
            result = self._gateway.chat("judge", messages, allowed_providers, max_tokens=256)
        except Exception as exc:  # never let the judge break an answer
            log.warning("support_judge_failed", error=type(exc).__name__)
            return SupportResult("uncertain", None, "llm")
        verdict = prompt.parse(result.text)
        log.info("support_judge", provider=result.provider_id, verdict=verdict)
        return SupportResult(verdict, None, "llm")


class FallbackSupportChecker:
    """NLI, then the judge only when NLI is uncertain and the request allows a judge."""

    def __init__(self, nli: SupportChecker, judge: LlmSupportChecker | None) -> None:
        self.nli = nli
        self.judge = judge
        self.model_id = nli.model_id + (f"+{judge.model_id}" if judge else "")

    def check(
        self, claim: str, evidence: str, *, allowed_providers: list[str] | None = None
    ) -> SupportResult:
        first = self.nli.check(claim, evidence)
        if first.verdict != "uncertain" or self.judge is None:
            return first
        if not self.judge.available(allowed_providers):
            return first
        judged = self.judge.check(claim, evidence, allowed_providers=allowed_providers)
        return SupportResult(judged.verdict, first.score, f"{first.method}+llm")


# ── test stand-in ──────────────────────────────────────────────────────────────────────────

_WORDS = re.compile(r"\w+")
_NUMBER = re.compile(r"\d+")


class StubSupportChecker:
    """Deterministic, for tests and CI only. Never use it for real answers.

    ``pass`` when at least ``pass_overlap`` of the claim's words (3+ letters) are in the
    evidence; ``fail`` when the claim names a number other than the evidence's; else ``uncertain``.
    """

    model_id = "caseguard/support-stub"

    def __init__(self, pass_overlap: float = 0.6) -> None:
        self.pass_overlap = pass_overlap

    def check(
        self, claim: str, evidence: str, *, allowed_providers: list[str] | None = None
    ) -> SupportResult:
        wanted = {w for w in _WORDS.findall(claim.lower()) if len(w) >= 3}
        have = set(_WORDS.findall(evidence.lower()))
        score = len(wanted & have) / len(wanted) if wanted else 0.0
        numbers = set(_NUMBER.findall(evidence))
        if numbers and set(_NUMBER.findall(claim)) - numbers:
            return SupportResult("fail", round(score, 4), "stub")
        if score >= self.pass_overlap:
            return SupportResult("pass", round(score, 4), "stub")
        return SupportResult("uncertain", round(score, 4), "stub")
