"""The case taxonomy file as typed rules (#200), and the PPC section comparator.

The file is ``packages/contracts/taxonomy/case-taxonomy.v1.yaml`` (#164). It is the source of
truth: this module only reads it. It is found by walking up from this file and from the current
directory, so the CLI works from the repo root and from ``services/ai``; ``CASEGUARD_TAXONOMY``
or ``--taxonomy`` overrides the path.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

TAXONOMY_RELATIVE = Path("packages") / "contracts" / "taxonomy" / "case-taxonomy.v1.yaml"
PROCEDURE = "procedure"  # procedural or evidence law: never decides an area (doc §5)
UNCLASSIFIED = "unclassified"

# A section number as the PPC numbers them: "302", "338-H", "489F", "377 B".
_SECTION_NUMBER = re.compile(r"^\s*(\d{1,4})\s*-?\s*([A-Z]{0,2})\s*$", re.I)

SectionKey = tuple[int, str]


def section_key(value: str) -> SectionKey:
    """``"338-H"`` → ``(338, "H")``, ``"302"`` → ``(302, "")``. Plain numbers sort before their
    lettered sections (302 < 302-A < 302-B < 303), so an inclusive range compares as tuples."""
    match = _SECTION_NUMBER.match(value)
    if not match:
        raise ValueError(f"not a section number: {value!r}")
    return int(match.group(1)), match.group(2).upper()


@dataclass(frozen=True)
class SectionRange:
    start: SectionKey
    end: SectionKey

    def __contains__(self, key: object) -> bool:
        return isinstance(key, tuple) and self.start <= key <= self.end


@dataclass(frozen=True)
class StatuteRule:
    statute: str  # as written in the file: "PPC", "Anti-Terrorism Act 1997"
    area: str  # an area id, or "procedure"
    subcategory: str | None = None
    sections: SectionRange | None = None

    @property
    def procedural(self) -> bool:
        return self.area == PROCEDURE


@dataclass(frozen=True)
class Area:
    id: str
    branch: str | None
    subcategories: tuple[str, ...]


@dataclass(frozen=True)
class Taxonomy:
    version: str
    areas: dict[str, Area]
    proceeding_types: tuple[str, ...]
    rules: tuple[StatuteRule, ...]

    def rules_for(self, statute: str) -> list[StatuteRule]:
        return [r for r in self.rules if r.statute == statute]

    def section_rule(self, statute: str, number: str) -> StatuteRule | None:
        """The rule for one section of a code: the first range that holds it, else a rule for the
        whole code (CrPC, CPC), else None (e.g. s.34 PPC, a general explanation)."""
        try:
            key = section_key(number)
        except ValueError:
            return None
        whole: StatuteRule | None = None
        for rule in self.rules_for(statute):
            if rule.sections is None:
                whole = whole or rule
            elif key in rule.sections:
                return rule
        return whole

    def check_subcategory(self, area: str, subcategory: str | None) -> None:
        if subcategory is not None and subcategory not in self.areas[area].subcategories:
            raise ValueError(f"{subcategory!r} is not a sub-category of {area!r}")


def find_taxonomy_file(start: Path | None = None) -> Path:
    """The taxonomy file: ``CASEGUARD_TAXONOMY``, else the first ``packages/contracts/...`` above
    ``start`` (default: this file, then the current directory)."""
    override = os.environ.get("CASEGUARD_TAXONOMY")
    if override:
        return Path(override)
    roots = [start] if start else [Path(__file__).resolve(), Path.cwd().resolve()]
    for root in roots:
        for parent in [root, *root.parents]:
            candidate = parent / TAXONOMY_RELATIVE
            if candidate.is_file():
                return candidate
    raise FileNotFoundError(
        f"{TAXONOMY_RELATIVE} not found above {', '.join(map(str, roots))}; run from the repo "
        "or set CASEGUARD_TAXONOMY"
    )


def parse_taxonomy(data: dict[str, Any]) -> Taxonomy:
    """Typed rules from the parsed file, checked: every rule names a known area (or procedure)
    and a sub-category of that area, and every range is well formed."""
    areas = {
        a["id"]: Area(a["id"], a.get("branch"), tuple(a.get("subcategories") or ()))
        for a in data["areas"]
    }
    rules: list[StatuteRule] = []
    for item in data.get("statute_rules") or []:
        sections = None
        if item.get("sections"):
            start = section_key(str(item["sections"]["from"]))
            end = section_key(str(item["sections"]["to"]))
            if start > end:
                raise ValueError(f"empty section range in {item}")
            sections = SectionRange(start, end)
        rule = StatuteRule(str(item["statute"]), item["area"], item.get("subcategory"), sections)
        if rule.area != PROCEDURE and rule.area not in areas:
            raise ValueError(f"unknown area {rule.area!r} in {item}")
        rules.append(rule)
    taxonomy = Taxonomy(
        version=str(data["version"]),
        areas=areas,
        proceeding_types=tuple(p["id"] for p in data.get("proceeding_types") or ()),
        rules=tuple(rules),
    )
    for rule in rules:
        if not rule.procedural:
            taxonomy.check_subcategory(rule.area, rule.subcategory)
    return taxonomy


def load_taxonomy(path: Path | None = None) -> Taxonomy:
    return _load(str(path or find_taxonomy_file()))


@lru_cache(maxsize=4)
def _load(path: str) -> Taxonomy:
    data: dict[str, Any] = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    return parse_taxonomy(data)
