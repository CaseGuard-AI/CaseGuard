"""Loading and validating the linter's rule sets (ADR-0012).

Each ``rules/*.yaml`` file is one versioned rule set. Loading is strict: an unknown key, a bad
id, an unknown kind or severity, a duplicate id, a pattern that doesn't compile, an ``order``
naming a rule that doesn't exist or a missing ``source`` key raises ``RulesetError``, so a broken
rule file fails at import and in the tests rather than on a request.
"""

from __future__ import annotations

import re
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any, Literal, cast

import yaml

RULES_DIR = Path(__file__).resolve().parent / "rules"

Kind = Literal["missing_section", "missing_particular", "structure"]
Severity = Literal["error", "warning", "info"]
DocumentType = Literal["bail_application", "plaint"]

KINDS: tuple[Kind, ...] = ("missing_section", "missing_particular", "structure")
SEVERITIES: tuple[Severity, ...] = ("error", "warning", "info")
DOCUMENT_TYPES: tuple[DocumentType, ...] = ("bail_application", "plaint")

_RULE_ID = re.compile(r"^[a-z][a-z0-9_.]{0,63}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_FLAGS = re.IGNORECASE | re.MULTILINE


class RulesetError(ValueError):
    """A rule file that doesn't follow the rule-set format."""


@dataclass(frozen=True)
class Source:
    provision: str
    reference: str | None


@dataclass(frozen=True)
class Near:
    """A match counts only if it starts within ``window`` characters of an anchor match
    (``after``: from the anchor's start to ``window`` past its end)."""

    anchor: tuple[re.Pattern[str], ...]
    window: int
    direction: Literal["both", "after"]


@dataclass(frozen=True)
class Detection:
    """Every group must match (``anyOf`` is one group, ``allOf`` several); within a group, any
    one pattern is enough."""

    groups: tuple[tuple[re.Pattern[str], ...], ...]
    near: Near | None


@dataclass(frozen=True)
class Rule:
    id: str
    kind: Kind
    severity: Severity
    title: str
    message: str
    source: Source | None
    detect: Detection | None  # None for an order rule
    order: tuple[str, str] | None
    when: Detection | None
    unless: Detection | None


@dataclass(frozen=True)
class Ruleset:
    id: str
    document_type: DocumentType
    version: str
    title: str
    rules: tuple[Rule, ...]


def _keys(obj: Any, where: str, required: set[str], optional: Collection[str] = ()) -> None:
    if not isinstance(obj, Mapping):
        raise RulesetError(f"{where}: expected a mapping")
    missing = required - obj.keys()
    unknown = obj.keys() - required - set(optional)
    if missing:
        raise RulesetError(f"{where}: missing {sorted(missing)}")
    if unknown:
        raise RulesetError(f"{where}: unknown {sorted(unknown)}")


def _text(value: Any, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RulesetError(f"{where}: expected a non-empty string")
    return value


def _patterns(value: Any, where: str) -> tuple[re.Pattern[str], ...]:
    if not isinstance(value, list) or not value:
        raise RulesetError(f"{where}: expected a non-empty list of patterns")
    out = []
    for i, p in enumerate(value):
        try:
            out.append(re.compile(_text(p, f"{where}[{i}]"), _FLAGS))
        except re.error as exc:
            raise RulesetError(f"{where}[{i}]: {exc}") from exc
    return tuple(out)


def _near(value: Any, where: str) -> Near:
    _keys(value, where, {"anchor", "window"}, {"direction"})
    window = value["window"]
    if not isinstance(window, int) or isinstance(window, bool) or not 0 < window <= 2000:
        raise RulesetError(f"{where}.window: expected 1..2000")
    direction = value.get("direction", "both")
    if direction not in ("both", "after"):
        raise RulesetError(f"{where}.direction: expected both or after")
    return Near(_patterns(value["anchor"], f"{where}.anchor"), window, direction)


def _detection(value: Any, where: str) -> Detection:
    if not isinstance(value, Mapping):
        raise RulesetError(f"{where}: expected a mapping")
    if ("anyOf" in value) == ("allOf" in value):
        raise RulesetError(f"{where}: expected exactly one of anyOf, allOf")
    if "anyOf" in value:
        _keys(value, where, {"anyOf"}, {"near"})
        groups: tuple[tuple[re.Pattern[str], ...], ...] = (
            _patterns(value["anyOf"], f"{where}.anyOf"),
        )
    else:
        _keys(value, where, {"allOf"}, {"near"})
        all_of = value["allOf"]
        if not isinstance(all_of, list) or not all_of:
            raise RulesetError(f"{where}.allOf: expected a non-empty list of groups")
        groups = tuple(_patterns(g, f"{where}.allOf[{i}]") for i, g in enumerate(all_of))
    near = _near(value["near"], f"{where}.near") if "near" in value else None
    return Detection(groups, near)


def _source(value: Any, where: str) -> Source | None:
    if value is None:
        return None
    _keys(value, where, {"provision", "reference"})
    reference = value["reference"]
    if reference is not None and (not isinstance(reference, str) or not _UUID.match(reference)):
        raise RulesetError(f"{where}.reference: expected a uuid or null")
    return Source(_text(value["provision"], f"{where}.provision"), reference)


def _rule(raw: Any, where: str) -> Rule:
    _keys(
        raw,
        where,
        {"id", "kind", "severity", "title", "message", "detect", "source"},
        {"when", "unless"},
    )
    rule_id = raw["id"]
    if not isinstance(rule_id, str) or not _RULE_ID.match(rule_id):
        raise RulesetError(f"{where}.id: expected {_RULE_ID.pattern}")
    where = f"rule {rule_id}"
    if raw["kind"] not in KINDS:
        raise RulesetError(f"{where}.kind: expected one of {KINDS}")
    if raw["severity"] not in SEVERITIES:
        raise RulesetError(f"{where}.severity: expected one of {SEVERITIES}")
    detect, order = raw["detect"], None
    if isinstance(detect, Mapping) and "order" in detect:
        _keys(detect, f"{where}.detect", {"order"})
        pair = detect["order"]
        if raw["kind"] != "structure":
            raise RulesetError(f"{where}: an order rule has kind structure")
        if (
            not isinstance(pair, list)
            or len(pair) != 2
            or not all(isinstance(p, str) for p in pair)
        ):
            raise RulesetError(f"{where}.detect.order: expected two rule ids")
        order, detection = (pair[0], pair[1]), None
    else:
        detection = _detection(detect, f"{where}.detect")
    return Rule(
        id=rule_id,
        kind=cast(Kind, raw["kind"]),
        severity=cast(Severity, raw["severity"]),
        title=_text(raw["title"], f"{where}.title"),
        message=_text(raw["message"], f"{where}.message"),
        source=_source(raw["source"], f"{where}.source"),
        detect=detection,
        order=order,
        when=_detection(raw["when"], f"{where}.when") if "when" in raw else None,
        unless=_detection(raw["unless"], f"{where}.unless") if "unless" in raw else None,
    )


def parse_ruleset(raw: Any) -> Ruleset:
    _keys(raw, "ruleset", {"id", "documentType", "version", "title", "rules"}, {"x-patterns"})
    if raw["documentType"] not in DOCUMENT_TYPES:
        raise RulesetError(f"ruleset.documentType: expected one of {DOCUMENT_TYPES}")
    if not isinstance(raw["rules"], list) or not raw["rules"]:
        raise RulesetError("ruleset.rules: expected a non-empty list")
    rules = tuple(_rule(r, f"rules[{i}]") for i, r in enumerate(raw["rules"]))
    by_id = {r.id: r for r in rules}
    if len(by_id) != len(rules):
        raise RulesetError("ruleset.rules: duplicate rule ids")
    for r in rules:
        for ref in r.order or ():
            target = by_id.get(ref)
            if target is None or target.detect is None or target.detect.near is not None:
                raise RulesetError(f"rule {r.id}: order names {ref!r}, not a plain section rule")
    return Ruleset(
        id=_text(raw["id"], "ruleset.id"),
        document_type=cast(DocumentType, raw["documentType"]),
        version=_text(raw["version"], "ruleset.version"),
        title=_text(raw["title"], "ruleset.title"),
        rules=rules,
    )


@cache
def load_rulesets() -> dict[str, Ruleset]:
    """Every rule set by document type, in ``DOCUMENT_TYPES`` order."""
    loaded: dict[str, Ruleset] = {}
    for path in sorted(RULES_DIR.glob("*.yaml")):
        try:
            ruleset = parse_ruleset(yaml.safe_load(path.read_text(encoding="utf-8")))
        except RulesetError as exc:
            raise RulesetError(f"{path.name}: {exc}") from exc
        if ruleset.document_type in loaded:
            raise RulesetError(f"{path.name}: a second rule set for {ruleset.document_type}")
        loaded[ruleset.document_type] = ruleset
    missing = set(DOCUMENT_TYPES) - loaded.keys()
    if missing:
        raise RulesetError(f"no rule set for {sorted(missing)}")
    return {t: loaded[t] for t in DOCUMENT_TYPES}
