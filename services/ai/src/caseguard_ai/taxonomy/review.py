"""The hand-labelling review of the area classifier (#200, docs/engineering/case-taxonomy.md §6).
Pure functions: the CLI (``taxonomy/cli.py``) reads the corpus and the files.

- ``stratified`` picks the sample: spread evenly over proceeding types, and within each over the
  benches (SHC seats), the same for the same input and seed.
- ``write_sample`` writes it as CSV with the classifier's prediction and blank gold columns.
- ``score`` / ``format_score`` read the filled CSV back: precision and recall per area, the
  ``unclassified`` rate, and whether the 85% bar is met.
"""

from __future__ import annotations

import csv
import random
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from caseguard_ai.taxonomy.rules import UNCLASSIFIED

BAR = 0.85  # doc §6: correct on the sample before area filters are switched on

SAMPLE_COLUMNS = (
    "document_id",
    "collector_id",
    "title",
    "case_number",
    "proceeding",  # proceeding_type, or the SHC case type until #16 fills it
    "bench",
    "headnote_only",
    "official_url",
    "predicted_area",
    "predicted_subcategory",
    "confidence",
    "reason",
    "evidence",
)
GOLD_COLUMNS = ("gold_area", "gold_subcategory", "reviewer", "notes")


@dataclass(frozen=True)
class Candidate:
    id: str
    proceeding: str
    bench: str


def stratified(candidates: Iterable[Candidate], n: int, seed: int = 200) -> list[Candidate]:
    """Up to ``n`` candidates, taken in rounds: each round takes one from every proceeding type
    that has any left, and each proceeding type cycles through its benches. Within a
    (proceeding, bench) group the order is a seeded shuffle, so the sample is reproducible and
    small proceeding types and benches are not drowned out by constitutional petitions."""
    rng = random.Random(seed)  # noqa: S311 (a reproducible sample, not a secret)
    groups: dict[str, dict[str, list[Candidate]]] = defaultdict(lambda: defaultdict(list))
    for c in sorted(candidates, key=lambda c: c.id):
        groups[c.proceeding][c.bench].append(c)
    for by_bench in groups.values():
        for members in by_bench.values():
            rng.shuffle(members)
    turn = {p: 0 for p in groups}  # which bench a proceeding type takes from next
    picked: list[Candidate] = []
    while len(picked) < n:
        took = False
        for proceeding in sorted(groups):
            if len(picked) >= n:
                break
            benches = [b for b in sorted(groups[proceeding]) if groups[proceeding][b]]
            if not benches:
                continue
            bench = benches[turn[proceeding] % len(benches)]
            turn[proceeding] += 1
            picked.append(groups[proceeding][bench].pop())
            took = True
        if not took:
            break
    return picked


def write_sample(rows: Iterable[dict[str, Any]], path: Path) -> int:
    """The sample CSV: the given columns, then empty gold columns for the reviewers."""
    count = 0
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[*SAMPLE_COLUMNS, *GOLD_COLUMNS])
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {**{k: row.get(k, "") for k in SAMPLE_COLUMNS}, **dict.fromkeys(GOLD_COLUMNS, "")}
            )
            count += 1
    return count


def read_sample(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as f:  # -sig: a sheet saved from Excel
        return list(csv.DictReader(f))


@dataclass
class AreaCounts:
    gold: int = 0
    predicted: int = 0
    correct: int = 0

    @property
    def precision(self) -> float | None:
        return self.correct / self.predicted if self.predicted else None

    @property
    def recall(self) -> float | None:
        return self.correct / self.gold if self.gold else None


@dataclass
class Score:
    labelled: int = 0
    correct: int = 0
    predicted_unclassified: int = 0
    unlabelled: int = 0
    invalid: list[str] = field(default_factory=list)  # gold values that are not area ids
    subcategory_checked: int = 0
    subcategory_correct: int = 0
    areas: dict[str, AreaCounts] = field(default_factory=lambda: defaultdict(AreaCounts))

    @property
    def accuracy(self) -> float:
        return self.correct / self.labelled if self.labelled else 0.0

    @property
    def unclassified_rate(self) -> float:
        return self.predicted_unclassified / self.labelled if self.labelled else 0.0

    @property
    def classified_precision(self) -> float | None:
        """Correct among the judgments that were given an area."""
        classified = self.labelled - self.predicted_unclassified
        right = sum(c.correct for a, c in self.areas.items() if a != UNCLASSIFIED)
        return right / classified if classified else None

    @property
    def meets_bar(self) -> bool:
        return self.labelled > 0 and self.accuracy >= BAR


def score(rows: Iterable[dict[str, str]], area_ids: Sequence[str]) -> Score:
    """Compare ``predicted_area`` with the reviewers' ``gold_area``. Rows without a gold area are
    counted as unlabelled; gold values that are not area ids are listed and left out."""
    known = set(area_ids)
    result = Score()
    for row in rows:
        gold = (row.get("gold_area") or "").strip()
        predicted = (row.get("predicted_area") or "").strip() or UNCLASSIFIED
        if not gold:
            result.unlabelled += 1
            continue
        if gold not in known:
            result.invalid.append(f"{row.get('document_id', '?')}: {gold}")
            continue
        result.labelled += 1
        result.areas[gold].gold += 1
        result.areas[predicted].predicted += 1
        if predicted == UNCLASSIFIED:
            result.predicted_unclassified += 1
        if predicted == gold:
            result.correct += 1
            result.areas[gold].correct += 1
            gold_sub = (row.get("gold_subcategory") or "").strip()
            if gold_sub and gold != UNCLASSIFIED:
                result.subcategory_checked += 1
                if gold_sub == (row.get("predicted_subcategory") or "").strip():
                    result.subcategory_correct += 1
    return result


def _pct(value: float | None) -> str:
    return "–" if value is None else f"{value:.0%}"


def format_score(result: Score) -> str:
    """A markdown table for the final report, then the summary lines."""
    lines = [
        "| Area | Gold | Predicted | Correct | Precision | Recall |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for area in sorted(a for a in result.areas if a != UNCLASSIFIED):
        c = result.areas[area]
        lines.append(
            f"| {area} | {c.gold} | {c.predicted} | {c.correct} | {_pct(c.precision)} | {_pct(c.recall)} |"
        )
    u = result.areas.get(UNCLASSIFIED, AreaCounts())
    lines.append(f"| {UNCLASSIFIED} | {u.gold} | {u.predicted} | {u.correct} | – | – |")
    lines += [
        "",
        f"- Labelled: {result.labelled} (unlabelled rows skipped: {result.unlabelled})",
        f"- Correct: {result.correct} ({_pct(result.accuracy)}); bar {BAR:.0%}: "
        + ("**met**" if result.meets_bar else "**not met**"),
        f"- Unclassified rate: {_pct(result.unclassified_rate)} ({result.predicted_unclassified})",
        f"- Precision where an area was given: {_pct(result.classified_precision)}",
    ]
    if result.subcategory_checked:
        lines.append(
            f"- Sub-category agreement (area right, gold sub-category given): "
            f"{result.subcategory_correct}/{result.subcategory_checked}"
        )
    if result.invalid:
        lines.append(f"- Gold values that are not area ids (left out): {', '.join(result.invalid)}")
    return "\n".join(lines)
