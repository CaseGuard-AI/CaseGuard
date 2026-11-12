"""The support check (FR-TRUST-3): verdict mapping, the LLM fallback and the stub. No model is
downloaded and no database is needed."""

from __future__ import annotations

import math
from typing import Any

import pytest

from caseguard_ai.gateway.client import ChatResult, GatewayError, NoProviderError
from caseguard_ai.trust.prompts import support_v1
from caseguard_ai.trust.support import (
    FallbackSupportChecker,
    LlmSupportChecker,
    StubSupportChecker,
    SupportResult,
    label_indices,
    softmax,
    verdict_from_logits,
)
from caseguard_ai.trust.support_eval import evaluate, load_pairs

STANDARD = {0: "entailment", 1: "neutral", 2: "contradiction"}
REORDERED = {0: "NEUTRAL", 1: "CONTRADICTION", 2: "ENTAILMENT"}


def logits_for(probs: dict[str, float], id2label: dict[int, str]) -> list[float]:
    """Logits whose softmax gives ``probs`` (by label name) in the model's own order."""
    return [math.log(probs[id2label[i].lower()]) for i in range(len(id2label))]


def judge(probs: dict[str, float], id2label: dict[int, str] = STANDARD) -> SupportResult:
    return verdict_from_logits(
        logits_for(probs, id2label), id2label, pass_threshold=0.7, fail_threshold=0.7
    )


# ── NLI verdicts ───────────────────────────────────────────────────────────────────────────


def test_softmax_sums_to_one_and_keeps_order() -> None:
    probs = softmax([2.0, 1.0, -1.0])
    assert math.isclose(sum(probs), 1.0)
    assert probs[0] > probs[1] > probs[2]
    assert softmax([1000.0, 0.0, 0.0])[0] == pytest.approx(1.0)  # no overflow


@pytest.mark.parametrize(
    ("probs", "verdict"),
    [
        ({"entailment": 0.9, "neutral": 0.05, "contradiction": 0.05}, "pass"),
        ({"entailment": 0.7, "neutral": 0.2, "contradiction": 0.1}, "pass"),  # inclusive
        ({"entailment": 0.69, "neutral": 0.3, "contradiction": 0.01}, "uncertain"),
        ({"entailment": 0.05, "neutral": 0.15, "contradiction": 0.8}, "fail"),
        ({"entailment": 0.2, "neutral": 0.6, "contradiction": 0.2}, "uncertain"),
        ({"entailment": 0.4, "neutral": 0.0001, "contradiction": 0.5999}, "uncertain"),
    ],
)
def test_thresholds_map_to_verdicts(probs: dict[str, float], verdict: str) -> None:
    result = judge(probs)
    assert result.verdict == verdict
    assert result.method == "nli"
    assert result.score == pytest.approx(probs["entailment"], abs=1e-4)


def test_the_label_order_comes_from_the_model_config() -> None:
    probs = {"entailment": 0.9, "neutral": 0.05, "contradiction": 0.05}
    assert judge(probs, REORDERED).verdict == "pass"
    # The same logits read with the wrong order would be a contradiction.
    wrong = verdict_from_logits(
        logits_for(probs, REORDERED), STANDARD, pass_threshold=0.7, fail_threshold=0.7
    )
    assert wrong.verdict == "fail"
    assert label_indices({"0": "entailment", "1": "neutral", "2": "contradiction"}) == (0, 2)


def test_a_model_without_nli_labels_is_refused() -> None:
    with pytest.raises(ValueError, match="not an NLI model"):
        label_indices({0: "LABEL_0", 1: "LABEL_1"})


# ── the LLM judge ──────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("reply", "verdict"),
    [
        ("SUPPORTED", "pass"),
        ("supported.", "pass"),
        ("**SUPPORTED**\nThe evidence says the same.", "pass"),
        ("NOT_SUPPORTED", "fail"),
        ("NOT SUPPORTED", "fail"),
        ("Not-supported: the section differs", "fail"),
        ("UNCLEAR", "uncertain"),
        ("SUPPORTED or NOT_SUPPORTED, hard to say", "uncertain"),
        ("I think it is SUPPORTED, or maybe NOT_SUPPORTED", "uncertain"),
        ("SUPPORTED. Clearly SUPPORTED.", "pass"),
        ("The answer is SUPPORTED", "pass"),
        ("", "uncertain"),
        ("Yes", "uncertain"),
        ("UNSUPPORTED", "uncertain"),  # not one of the labels: never a pass
    ],
)
def test_judge_replies_are_parsed_defensively(reply: str, verdict: str) -> None:
    assert support_v1.parse(reply) == verdict


class FakeGateway:
    def __init__(self, reply: str = "SUPPORTED", *, fail: Exception | None = None) -> None:
        self.reply, self.fail = reply, fail
        self.allowed_seen: list[list[str] | None] = []
        self.messages: list[list[dict[str, str]]] = []

    def provider_for(self, role: str, allowed: list[str] | None) -> object:
        self.allowed_seen.append(allowed)
        if role != "judge" or "ollama" not in (allowed or ["ollama"]):
            raise NoProviderError("judge")
        return object()

    def chat(
        self, role: str, messages: list[dict[str, str]], allowed: list[str] | None, **_: Any
    ) -> ChatResult:
        self.provider_for(role, allowed)
        self.messages.append(messages)
        if self.fail:
            raise self.fail
        return ChatResult(self.reply, "ollama", "qwen2.5:7b", 5, "stop", {})


class FixedNli:
    model_id = "fixed-nli"

    def __init__(self, verdict: str) -> None:
        self.verdict = verdict
        self.calls = 0

    def check(
        self, claim: str, evidence: str, *, allowed_providers: list[str] | None = None
    ) -> SupportResult:
        self.calls += 1
        return SupportResult(self.verdict, 0.4, "nli")  # type: ignore[arg-type]


def fallback(nli_verdict: str, gateway: FakeGateway) -> FallbackSupportChecker:
    return FallbackSupportChecker(FixedNli(nli_verdict), LlmSupportChecker(gateway))  # type: ignore[arg-type]


@pytest.mark.parametrize("nli_verdict", ["pass", "fail"])
def test_a_decisive_nli_verdict_never_asks_the_judge(nli_verdict: str) -> None:
    gateway = FakeGateway("UNCLEAR")
    result = fallback(nli_verdict, gateway).check("c", "e", allowed_providers=["ollama"])
    assert result == SupportResult(nli_verdict, 0.4, "nli")  # type: ignore[arg-type]
    assert gateway.messages == []


@pytest.mark.parametrize(("reply", "verdict"), [("SUPPORTED", "pass"), ("NOT_SUPPORTED", "fail")])
def test_an_uncertain_nli_asks_the_judge(reply: str, verdict: str) -> None:
    gateway = FakeGateway(reply)
    result = fallback("uncertain", gateway).check(
        "the claim", "the evidence", allowed_providers=["ollama"]
    )
    assert result == SupportResult(verdict, 0.4, "nli+llm")  # type: ignore[arg-type]
    (messages,) = gateway.messages
    assert messages[0]["content"] == support_v1.SYSTEM
    assert "CLAIM: the claim" in messages[1]["content"]
    assert "EVIDENCE: the evidence" in messages[1]["content"]


def test_the_judge_is_skipped_when_the_allow_list_has_no_judge() -> None:
    gateway = FakeGateway("SUPPORTED")
    result = fallback("uncertain", gateway).check("c", "e", allowed_providers=["gemini"])
    assert result.verdict == "uncertain" and result.method == "nli"
    assert gateway.messages == []
    assert gateway.allowed_seen == [["gemini"]]  # passed through as given, never widened


@pytest.mark.parametrize(
    "error", [GatewayError("ollama", "HTTP 500"), NoProviderError("judge"), RuntimeError("boom")]
)
def test_a_judge_error_is_uncertain_and_never_raises(error: Exception) -> None:
    gateway = FakeGateway(fail=error)
    result = fallback("uncertain", gateway).check("c", "e", allowed_providers=["ollama"])
    assert result.verdict == "uncertain" and result.method == "nli+llm"


def test_the_judge_never_logs_the_claim_or_evidence(capsys: pytest.CaptureFixture[str]) -> None:
    gateway = FakeGateway("SUPPORTED")
    fallback("uncertain", gateway).check(
        "zebraquokka claim", "okapinarwhal evidence", allowed_providers=["ollama"]
    )
    out = capsys.readouterr()
    assert "zebraquokka" not in out.out + out.err
    assert "okapinarwhal" not in out.out + out.err


def test_without_a_judge_the_nli_verdict_stands() -> None:
    checker = FallbackSupportChecker(FixedNli("uncertain"), None)
    assert checker.check("c", "e").verdict == "uncertain"
    assert checker.model_id == "fixed-nli"


# ── the stub ───────────────────────────────────────────────────────────────────────────────


def test_the_stub_is_deterministic() -> None:
    stub = StubSupportChecker()
    claim = "Qatl-i-amd is punished with death as qisas."
    evidence = "Whoever commits qatl-i-amd shall be punished with death as qisas."
    assert stub.check(claim, evidence) == stub.check(claim, evidence)
    assert stub.check(claim, evidence).verdict == "pass"
    assert stub.check("Theft is punished under section 380.", "section 379 theft").verdict == "fail"
    assert stub.check(claim, "Bail may be granted to a woman.").verdict == "uncertain"
    assert stub.check(claim, evidence).method == "stub"


# ── the evaluation set ─────────────────────────────────────────────────────────────────────


def test_the_evaluation_set_is_well_formed() -> None:
    pairs = load_pairs()
    assert len(pairs) >= 40
    assert {p["label"] for p in pairs} == {"pass", "fail", "uncertain"}
    assert all(p["claim"].strip() and p["evidence"].strip() for p in pairs)


def test_evaluate_reports_accuracy_and_a_confusion_matrix() -> None:
    pairs = [
        {"claim": "a", "evidence": "x", "label": "pass"},
        {"claim": "b", "evidence": "x", "label": "fail"},
        {"claim": "c", "evidence": "x", "label": "uncertain"},
        {"claim": "d", "evidence": "x", "label": "pass"},
    ]
    verdicts = {"a": "pass", "b": "pass", "c": "uncertain", "d": "uncertain"}

    class Scripted:
        model_id = "scripted"

        def check(
            self, claim: str, evidence: str, *, allowed_providers: list[str] | None = None
        ) -> SupportResult:
            return SupportResult(verdicts[claim], None, "scripted")  # type: ignore[arg-type]

    report = evaluate(Scripted(), pairs)
    assert report.accuracy == pytest.approx(0.5)
    assert report.confusion["pass"] == {"pass": 1, "uncertain": 1, "fail": 0}
    assert report.confusion["fail"] == {"pass": 1, "uncertain": 0, "fail": 0}
    assert report.precision["pass"] == pytest.approx(0.5)
    assert report.recall["pass"] == pytest.approx(0.5)
    assert report.recall["fail"] == 0.0
    assert report.precision["uncertain"] == pytest.approx(0.5)
