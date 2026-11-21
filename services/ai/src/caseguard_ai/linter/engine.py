"""The procedural linter (FR-LINT-1, FR-LINT-3, ADR-0012).

Pure and deterministic: no database, no model provider, no writes. The text is only read; the
result carries the SHA-256 of its UTF-8 bytes so a caller can show it was left unchanged, and
every span is in UTF-16 code units so a JavaScript client can slice the same string.
"""

from __future__ import annotations

import hashlib
import re
from bisect import bisect_left
from dataclasses import dataclass

from caseguard_ai.linter.rules import (
    Detection,
    Kind,
    Rule,
    Severity,
    Source,
    load_rulesets,
)

Span = tuple[int, int]


class InvalidText(ValueError):
    """Text with no UTF-8 encoding (a lone surrogate), so it has no bytes to hash."""


@dataclass(frozen=True)
class Finding:
    rule_id: str
    kind: Kind
    severity: Severity
    message: str
    span: Span | None  # UTF-16 code units, [start, end)
    source: Source | None


@dataclass(frozen=True)
class LintOutcome:
    ruleset_id: str
    ruleset_version: str
    input_sha256: str
    findings: tuple[Finding, ...]


def utf16_offset(text: str, index: int) -> int:
    """The UTF-16 offset of code point ``index``: characters above U+FFFF take two units."""
    if text.isascii():
        return index
    return index + sum(1 for ch in text[:index] if ord(ch) > 0xFFFF)


def _starts(patterns: tuple[re.Pattern[str], ...], text: str) -> list[int]:
    return sorted(m.start() for p in patterns for m in p.finditer(text))


def _anchors(detection: Detection, text: str) -> list[tuple[int, int]]:
    assert detection.near is not None  # noqa: S101 - callers check
    return sorted((m.start(), m.end()) for p in detection.near.anchor for m in p.finditer(text))


def _check(detection: Detection, text: str) -> tuple[bool, tuple[int, int] | None]:
    """Whether the detection is satisfied and, if not, the first anchor (in code points)."""
    near = detection.near
    if near is None:
        return all(any(p.search(text) for p in group) for group in detection.groups), None
    anchors = _anchors(detection, text)
    for group in detection.groups:
        starts = _starts(group, text)
        if not any(_any_in(starts, *_window(a, near.window, near.direction)) for a in anchors):
            return False, anchors[0] if anchors else None
    return bool(anchors), None


def _window(anchor: tuple[int, int], window: int, direction: str) -> tuple[int, int]:
    start, end = anchor
    return (start if direction == "after" else start - window), end + window


def _any_in(sorted_starts: list[int], lo: int, hi: int) -> bool:
    i = bisect_left(sorted_starts, lo)
    return i < len(sorted_starts) and sorted_starts[i] <= hi


def _applies(rule: Rule, text: str) -> bool:
    if rule.when is not None and not _check(rule.when, text)[0]:
        return False
    return rule.unless is None or not _check(rule.unless, text)[0]


def _matches(detection: Detection, text: str) -> list[tuple[int, int]]:
    return sorted(
        (m.start(), m.end()) for group in detection.groups for p in group for m in p.finditer(text)
    )


def _order_violation(
    rule: Rule, by_id: dict[str, Rule], text: str
) -> tuple[bool, tuple[int, int] | None]:
    """B must not come entirely before A. Silent when either is missing: its own rule reports."""
    assert rule.order is not None  # noqa: S101
    first, then = (by_id[i].detect for i in rule.order)
    assert first is not None and then is not None  # noqa: S101 - checked at load
    a, b = _matches(first, text), _matches(then, text)
    if not a or not b or b[-1][0] >= a[0][0]:
        return False, None
    return True, b[0]


def _to_utf16(text: str, span: tuple[int, int] | None) -> Span | None:
    if span is None:
        return None
    return utf16_offset(text, span[0]), utf16_offset(text, span[1])


def lint(document_type: str, text: str) -> LintOutcome:
    """Lint ``text`` against the rule set for ``document_type``. Findings are in document order;
    findings without a span come last, in rule order."""
    try:
        data = text.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise InvalidText("text is not valid Unicode") from exc
    ruleset = load_rulesets()[document_type]
    by_id = {r.id: r for r in ruleset.rules}
    keyed: list[tuple[tuple[int, int, int, int], Finding]] = []
    for index, rule in enumerate(ruleset.rules):
        if not _applies(rule, text):
            continue
        if rule.order is not None:
            failed, at = _order_violation(rule, by_id, text)
        else:
            assert rule.detect is not None  # noqa: S101
            ok, at = _check(rule.detect, text)
            failed = not ok
        if not failed:
            continue
        span = _to_utf16(text, at)
        key = (0, span[0], span[1], index) if span else (1, 0, 0, index)
        finding = Finding(rule.id, rule.kind, rule.severity, rule.message, span, rule.source)
        keyed.append((key, finding))
    return LintOutcome(
        ruleset_id=ruleset.id,
        ruleset_version=ruleset.version,
        input_sha256=hashlib.sha256(data).hexdigest(),
        findings=tuple(f for _, f in sorted(keyed, key=lambda kf: kf[0])),
    )
