"""Citation parsing for the graph build (#210, FR-GRAPH-1). Pure functions, no database.

- **Law-report citations** ("2019 SCMR 984", "PLD 2023 SC 1"). ``CITATION`` is ported from the
  collector's ``extractors/metadata_extractor.py``: the collector is a separate package, so it
  is copied rather than imported. Keep the two in step.
- **Section references** ("section 497 Cr.P.C.", "s. 302 PPC", "u/s 9 of the Code of Civil
  Procedure") for the codes the parser knows. Each becomes one canonical label, "s.497 CrPC",
  so the same section from two judgments is one graph entity.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Pakistani law-report citations: 2019 SCMR 984, PLD 2023 FSC 301, 2021 PTD 484 (collector).
CITATION = re.compile(
    r"\b(?:PLD\s+((?:1[89]|20)\d{2})|((?:1[89]|20)\d{2})\s+"
    r"(?:PLD|SCMR|CLC|YLR|MLD|PCr\.?\s?LJ|PLJ|PTD|CLD|PLC|SBLR|TAX|GBLR))"
    r"(?:\s*\(?[A-Za-z .]{0,24}\)?)?\s*\d+\b"
)


def find_citations(text: str | None, limit: int = 200) -> list[str]:
    """Law-report citations in ``text``, in order, each once (as normalised)."""
    if not text:
        return []
    found: dict[str, str] = {}
    for match in CITATION.finditer(text):
        value = " ".join(match.group(0).split())
        found.setdefault(normalise_citation(value), value)
        if len(found) >= limit:
            break
    return list(found.values())


def normalise_citation(value: str) -> str:
    """One spelling per citation: upper case, no dots or brackets, single spaces, and no spaces
    inside a report name ("P Cr. L J" and "PCr.LJ" are both "PCRLJ")."""
    s = re.sub(r"[.()\[\],]", " ", value.upper())
    s = " ".join(s.split())
    return re.sub(r"(?<=[A-Z]) (?=[A-Z])", "", s)


def normalise_case_number(value: str) -> str:
    """A case number for matching only: upper case, letters and digits, '/' kept."""
    return re.sub(r"[^A-Z0-9/]", "", value.upper())


# ── sections ───────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Code:
    abbreviation: str  # the canonical label's suffix
    title_pattern: str  # SQL ILIKE pattern for the statute's title in corpus.documents
    aliases: tuple[str, ...]  # regex alternatives, matched case-insensitively


CODES: tuple[Code, ...] = (
    Code(
        "CrPC",
        "Code of Criminal Procedure%",
        (r"Cr\.?\s?P\.?\s?C\.?", r"Code\s+of\s+Criminal\s+Procedure(?:,?\s*1898)?"),
    ),
    Code(
        "PPC",
        "Pakistan Penal Code%",
        (r"P\.?\s?P\.?\s?C\.?", r"Pakistan\s+Penal\s+Code(?:,?\s*1860)?"),
    ),
    Code(
        "CPC",
        "Code of Civil Procedure%",
        (r"C\.?\s?P\.?\s?C\.?", r"Code\s+of\s+Civil\s+Procedure(?:,?\s*1908)?"),
    ),
    Code(
        "QSO",
        "Qanun-e-Shahadat%",
        (r"Q\.?\s?S\.?\s?O\.?", r"Qanun-?e-?Shahadat(?:\s+Order)?(?:,?\s*1984)?"),
    ),
    Code(
        "Constitution",
        "%Constitution of the Islamic Republic of Pakistan%",
        (r"(?:the\s+)?Constitution(?:\s+of\s+(?:the\s+)?Islamic\s+Republic\s+of\s+Pakistan)?",),
    ),
)

_BY_ABBREVIATION = {c.abbreviation.upper(): c for c in CODES}
_ALIASES = "|".join(f"(?P<c{i}>{'|'.join(c.aliases)})" for i, c in enumerate(CODES))

# "section 497", "s. 497(2)", "S.302-B", "u/s 9", "ss. 302", "Article 199" (Constitution only),
# then optionally "of the", then a known code. Without a code the reference is ambiguous, so
# it is not matched.
SECTION = re.compile(
    r"\b(?P<kw>sections?|ss?\.|u/s\.?|art(?:icle)?s?\.?)\s*"
    r"(?P<num>\d{1,4}(?:-?[A-Z](?![a-z]))?)"
    r"(?:\s*\(\s*\w{1,4}\s*\))*"
    r"\s*,?\s*(?:of\s+(?:the\s+)?)?"
    rf"(?:{_ALIASES})(?![A-Za-z])",
    re.I,
)


@dataclass(frozen=True)
class SectionRef:
    label: str  # "s.497 CrPC", "Art.199 Constitution"
    code: Code


def _label(keyword: str, number: str, code: Code) -> str:
    article = keyword.lower().startswith("art") or code.abbreviation == "Constitution"
    prefix = "Art." if article else "s."
    return f"{prefix}{number.upper().replace('-', '')} {code.abbreviation}"


def find_sections(text: str | None, limit: int = 200) -> list[SectionRef]:
    """Section references to known codes in ``text``, in order, each once."""
    if not text:
        return []
    found: dict[str, SectionRef] = {}
    for match in SECTION.finditer(text):
        code = next(c for i, c in enumerate(CODES) if match.group(f"c{i}"))
        ref = SectionRef(_label(match.group("kw"), match.group("num"), code), code)
        found.setdefault(ref.label, ref)
        if len(found) >= limit:
            break
    return list(found.values())


def parse_section_label(value: str) -> SectionRef | None:
    """A user's section filter ("s.497 CrPC", "section 497 Cr.P.C.") as its canonical label, or
    None when it names no known code."""
    found = find_sections(value, limit=1)
    if found:
        return found[0]
    # The canonical form itself: "s.497 CrPC".
    m = re.fullmatch(r"\s*(s|art)\.?\s*(\d{1,4}[A-Z]?)\s+(\w+)\s*", value, re.I)
    if m and m.group(3).upper() in _BY_ABBREVIATION:
        code = _BY_ABBREVIATION[m.group(3).upper()]
        return SectionRef(_label(m.group(1), m.group(2), code), code)
    return None
