"""Agreement of the support check with hand-labelled claim-evidence pairs (FR-TRUST-3).

    pnpm ai:support-eval [-- --checker nli|stub] [-- --pairs <file.jsonl>]

Each line of the pairs file is ``{"claim", "evidence", "label"}`` with label ``pass`` (the
evidence supports the claim), ``fail`` (it contradicts it: another punishment, section or
condition) or ``uncertain`` (it is about something else). Prints accuracy, per-label precision
and recall, and the confusion matrix. ``nli`` runs the NLI model alone, without the LLM
fallback, so the numbers describe the pinned model and thresholds (TBD-13).
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from caseguard_ai.trust.support import NliSupportChecker, StubSupportChecker, SupportChecker

LABELS = ("pass", "uncertain", "fail")
DEFAULT_PAIRS = Path(__file__).resolve().parents[3] / "tests" / "data" / "support_pairs.jsonl"


@dataclass(frozen=True)
class Report:
    n: int
    accuracy: float
    precision: dict[str, float]
    recall: dict[str, float]
    confusion: dict[str, dict[str, int]]  # gold label → predicted label → count


def load_pairs(path: Path = DEFAULT_PAIRS) -> list[dict[str, str]]:
    pairs = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("label") not in LABELS or not row.get("claim") or not row.get("evidence"):
            raise ValueError(f"{path.name}:{number}: needs claim, evidence and a label in {LABELS}")
        pairs.append(row)
    return pairs


def evaluate(checker: SupportChecker, pairs: Sequence[dict[str, Any]]) -> Report:
    confusion = {gold: dict.fromkeys(LABELS, 0) for gold in LABELS}
    for pair in pairs:
        predicted = checker.check(pair["claim"], pair["evidence"]).verdict
        confusion[pair["label"]][predicted] += 1
    n = len(pairs)
    correct = sum(confusion[label][label] for label in LABELS)
    precision, recall = {}, {}
    for label in LABELS:
        predicted_as = sum(confusion[gold][label] for gold in LABELS)
        actual = sum(confusion[label].values())
        precision[label] = confusion[label][label] / predicted_as if predicted_as else 0.0
        recall[label] = confusion[label][label] / actual if actual else 0.0
    return Report(n, correct / n if n else 0.0, precision, recall, confusion)


def format_report(report: Report, checker: str) -> str:
    lines = [
        f"support check: {checker}",
        f"pairs: {report.n}   accuracy: {report.accuracy:.3f}",
        "",
        f"{'label':<10} {'precision':>9} {'recall':>7} {'n':>4}",
    ]
    for label in LABELS:
        lines.append(
            f"{label:<10} {report.precision[label]:>9.3f} {report.recall[label]:>7.3f}"
            f" {sum(report.confusion[label].values()):>4}"
        )
    lines += [
        "",
        "confusion (rows = gold, columns = predicted)",
        " " * 10 + "".join(f"{p:>10}" for p in LABELS),
    ]
    for gold in LABELS:
        lines.append(f"{gold:<10}" + "".join(f"{report.confusion[gold][p]:>10}" for p in LABELS))
    return "\n".join(lines)


def _checker(name: str) -> SupportChecker:
    if name == "stub":
        return StubSupportChecker()
    from caseguard_ai.config import EmbeddingSettings

    s = EmbeddingSettings()
    return NliSupportChecker(
        s.support_model,
        s.support_revision,
        pass_threshold=s.support_pass_threshold,
        fail_threshold=s.support_fail_threshold,
        device=s.embedding_device or None,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--checker", choices=["nli", "stub"], default="nli")
    parser.add_argument("--pairs", type=Path, default=DEFAULT_PAIRS)
    args = parser.parse_args(argv)
    checker = _checker(args.checker)
    report = evaluate(checker, load_pairs(args.pairs))
    name = checker.model_id
    if isinstance(checker, NliSupportChecker):
        # ASCII only: a Windows console may not encode anything else.
        name += f"@{checker.revision} (pass >= {checker.pass_threshold}, fail >= {checker.fail_threshold})"
    print(format_report(report, name))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
