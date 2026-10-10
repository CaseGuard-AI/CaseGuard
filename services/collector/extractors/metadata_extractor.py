"""Metadata heuristics shared by several sources.

Everything here is best-effort pattern matching over text the source gave us.
Each function returns None / [] when it is not confident. That is deliberate:
a wrong judge name or citation in the corpus is worse than a missing one,
because the RAG layer will present it as fact.

Anything derived here (rather than read from a labelled field) should be
recorded in `LegalDocument.notes` by the caller so provenance stays honest.
"""

from __future__ import annotations

import re

from utils.dates import normalise_date

# ----------------------------------------------------------------------
# Document numbers, e.g. "XVIII of 1999", "Act No. XL of 1976"
# ----------------------------------------------------------------------
ROMAN = r"[IVXLCDM]+"
DOC_NUMBER = re.compile(
    rf"\b(?:(?:Act|Ordinance|Order|Regulation)\s*(?:No\.?)?\s*)?"
    rf"({ROMAN})\s+of\s+((?:1[89]|20)\d{{2}})\b",
    re.I,
)

# Pakistani law-report citations: 2019 SCMR 984, PLD 2023 FSC 301, 2021 PTD 484
CITATION = re.compile(
    r"\b(?:PLD\s+((?:1[89]|20)\d{2})|((?:1[89]|20)\d{2})\s+"
    r"(?:PLD|SCMR|CLC|YLR|MLD|PCr\.?\s?LJ|PLJ|PTD|CLD|PLC|SBLR|TAX|GBLR))"
    r"(?:\s*\(?[A-Za-z .]{0,24}\)?)?\s*\d+\b"
)

JUDGE_PREFIX = re.compile(
    # "...Justice <optional titles> <Name>" -- only the name is captured.
    # The keyword and titles are matched case-insensitively because FSC and
    # SCP judgment headers are ALL CAPS ("MR. JUSTICE DR. SYED MUHAMMAD ANWER")
    # while the name class stays case-sensitive so ordinary prose does not
    # match. Words within a name are separated by spaces but never newlines,
    # so a name cannot run into the next judge on the following line.
    r"(?i:justice)\s+"
    r"(?:(?i:dr|mr|mrs|ms|miss|hon'?ble|justice)\.?[^\S\n]+)*"
    r"(?!(?i:justice)\b)"
    r"([A-Z][A-Za-z.\-']+(?:[^\S\n]+[A-Z][A-Za-z.\-']+){0,4})"
)

# Party separators seen across PK portals: "V/S", "VS", "Versus", "vs.", "v."
PARTIES_VS = re.compile(
    r"^(?P<left>.+?)\s*(?:\((?P<lrole>[^)]+)\))?\s*"
    r"(?:V\s*/\s*S\.?|VERSUS|\bVS\b\.?|\bvs?\b\.?)\s*"
    r"(?P<right>.+?)\s*(?:\((?P<rrole>[^)]+)\))?\s*$",
    re.I,
)

CASE_NUMBER = re.compile(
    r"\b((?:C\.?P|C\.?A|C\.?M\.?A|Crl\.?[A-Za-z.]*|H\.?C\.?A|I\.?C\.?A|"
    r"R\.?F\.?A|W\.?P|S\.?M\.?C|J\.?P|Const\.?\s?P|Suit|Civil\s+Revision)"
    r"[.\s]*(?:No\.?)?\s*\d+[-/][A-Z]?\s*(?:of\s*)?(?:19|20)?\d{2})\b",
    re.I,
)

SECTION_REF = re.compile(
    r"\b(?:section|s\.|ss\.|article|art\.|order|rule)\s*(\d+[A-Za-z\-]*)"
    r"(?:\s*(?:of|,)\s*(?:the\s+)?([A-Z][\w'’\-]*(?:\s+[A-Z(][\w'’\-)]*){0,7}"
    r"(?:Act|Ordinance|Code|Constitution|Rules|Order)[,\s]*(?:\d{4})?))?",
    re.I,
)

DISPOSAL_WORDS = {
    "allowed",
    "dismissed",
    "disposed",
    "disposed of",
    "withdrawn",
    "pending",
    "decided",
    "accepted",
    "rejected",
    "remanded",
    "converted",
}


# ----------------------------------------------------------------------
def extract_document_number(text: str | None) -> str | None:
    if not text:
        return None
    match = DOC_NUMBER.search(text)
    return f"{match.group(1).upper()} of {match.group(2)}" if match else None


def extract_citations(text: str | None, limit: int = 20) -> list[str]:
    if not text:
        return []
    found: list[str] = []
    for match in CITATION.finditer(text):
        value = " ".join(match.group(0).split())
        if value not in found:
            found.append(value)
        if len(found) >= limit:
            break
    return found


def extract_judges(text: str | None, limit: int = 12) -> list[str]:
    """Pull judge names out of a bench string.

    Only run this on a field the source labels as the bench/judges. Running it
    over a whole judgment body will pick up judges merely cited in precedent.
    """
    if not text:
        return []
    names: list[str] = []
    for match in JUDGE_PREFIX.finditer(text):
        name = " ".join(match.group(1).split()).strip(" .,")
        name = re.sub(r"\s*\((?:Author|Autho[r]?)\)\s*$", "", name, flags=re.I)
        # an all-caps header can trail into the next judge's honorific
        name = re.sub(
            r"[\s,]*\b(?:MR|MRS|MS|DR|HON|HON'BLE|JUSTICE|CHIEF)\.?$", "", name, flags=re.I
        ).strip(" .,")
        if len(name) < 4 or name.lower() in {"of pakistan", "the state"}:
            continue
        name = _normalise_case(name)
        if name not in names:
            names.append(name)
        if len(names) >= limit:
            break
    return names


def _normalise_case(name: str) -> str:
    """ALL CAPS is a formatting artefact of FSC/SCP judgment headers, not the
    name. Fold it to title case so the same judge from two portals is one
    person downstream; leave mixed-case names exactly as published."""
    if name.isupper():
        return " ".join(
            part.capitalize() if part.isalpha() or part.endswith(".") else part
            for part in name.split()
        )
    return name


def split_parties(title: str | None) -> list[dict[str, str | None]]:
    """ "A (Petitioner) V/S B (Respondent)" -> two party dicts."""
    if not title:
        return []
    match = PARTIES_VS.match(title.strip())
    if not match:
        return []
    out: list[dict[str, str | None]] = []
    for side, role_key in (("left", "lrole"), ("right", "rrole")):
        name = (match.group(side) or "").strip(" .,-")
        role = (match.group(role_key) or "").strip().lower() or None
        if name:
            out.append({"name": name, "role": role})
    return out


def extract_case_number(text: str | None) -> str | None:
    if not text:
        return None
    match = CASE_NUMBER.search(text)
    return " ".join(match.group(1).split()) if match else None


def extract_cited_laws(text: str | None, limit: int = 40) -> list[str]:
    """Statutes referenced in the body, e.g. 'Income Tax Ordinance, 2001'."""
    if not text:
        return []
    pattern = re.compile(
        r"\b((?:[A-Z][\w'’\-]*\s+){1,8}"
        r"(?:Act|Ordinance|Code|Rules|Regulations|Constitution))"
        r"(?:,?\s*((?:1[89]|20)\d{2}))?"
    )
    found: list[str] = []
    for match in pattern.finditer(text):
        name = " ".join(match.group(1).split())
        if match.group(2):
            name = f"{name}, {match.group(2)}"
        if 10 < len(name) < 120 and name not in found:
            found.append(name)
        if len(found) >= limit:
            break
    return found


def guess_document_type(title: str | None, category: str | None = None) -> str:
    """Classify from the title wording. Returns 'unknown' when unsure."""
    haystack = f"{title or ''} {category or ''}".lower()
    if not haystack.strip():
        return "unknown"
    if "constitution" in haystack and "amendment" not in haystack:
        return "constitution"
    ordered = (
        ("amendment", "amendment"),
        ("ordinance", "ordinance"),
        (" bill", "bill"),
        ("regulation", "regulation"),
        (" rules", "rules"),
        (" code", "code"),
        ("judgment", "judgment"),
        ("judgement", "judgment"),
        ("order", "order"),
        (" act", "act"),
    )
    for needle, label in ordered:
        if needle in haystack:
            return label
    return "unknown"


def extract_case_status(text: str | None) -> str | None:
    if not text:
        return None
    lowered = text.lower()
    for word in sorted(DISPOSAL_WORDS, key=len, reverse=True):
        if word in lowered:
            return word
    return None


def first_date(*candidates: str | None) -> str | None:
    for candidate in candidates:
        normalised = normalise_date(candidate)
        if normalised:
            return normalised
    return None


def parse_labelled_line(line: str) -> tuple[str, str] | None:
    """'Order Date: 22-MAR-16' -> ('order date', '22-MAR-16')."""
    if ":" not in line:
        return None
    label, _, value = line.partition(":")
    label = label.strip().lower()
    value = value.strip()
    if not label or not value or len(label) > 40:
        return None
    return label, value
