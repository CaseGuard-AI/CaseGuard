"""Date normalisation.

Pakistani court and legislative portals use many formats. We normalise to
ISO-8601 (YYYY-MM-DD) when confident and return None otherwise -- guessing a
date is worse than having no date, because a RAG answer may cite it.
"""

from __future__ import annotations

import re
from datetime import date, datetime

_FORMATS = (
    "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y",
    "%d-%b-%y", "%d-%b-%Y", "%d %b %Y", "%d %B %Y",
    "%B %d %Y", "%B %d, %Y", "%b %d %Y", "%b %d, %Y",
    "%Y/%m/%d", "%d-%B-%Y",
)

_ORDINAL = re.compile(r"\b(\d{1,2})(st|nd|rd|th)\b", re.I)
_CLEAN = re.compile(r"[,\s]+")
_YEAR_ONLY = re.compile(r"^\s*(1[89]\d{2}|20\d{2})\s*$")


def normalise_date(value: str | None) -> str | None:
    """Return an ISO date string, or None if the input cannot be trusted."""
    if not value:
        return None
    raw = str(value).strip()
    if not raw or raw.lower() in {"n/a", "na", "nil", "-", "--", "december ."}:
        return None

    raw = _ORDINAL.sub(r"\1", raw)
    raw = re.sub(r"\bSept\b", "Sep", raw)   # not "September"
    raw = _CLEAN.sub(" ", raw).strip(" .")

    for fmt in _FORMATS:
        try:
            parsed = datetime.strptime(raw, fmt)
        except ValueError:
            continue
        # two-digit years: 26 -> 2026, 98 -> 1998
        if "%y" in fmt and parsed.year > date.today().year + 1:
            parsed = parsed.replace(year=parsed.year - 100)
        return parsed.date().isoformat()

    # bare "1973" -> not a full date; caller may still want the year
    return None


def extract_year(value: str | None) -> int | None:
    if not value:
        return None
    text = str(value)
    if _YEAR_ONLY.match(text):
        return int(text.strip())
    match = re.search(r"\b(1[89]\d{2}|20\d{2})\b", text)
    return int(match.group(1)) if match else None


def in_year_range(iso_or_year: str | int | None,
                  start: int | None, end: int | None) -> bool:
    """Filter helper. Documents with an unknown year are kept -- dropping them
    would silently lose records whose date the source simply did not publish."""
    if start is None and end is None:
        return True
    year = iso_or_year if isinstance(iso_or_year, int) else extract_year(iso_or_year)
    if year is None:
        return True
    if start is not None and year < start:
        return False
    if end is not None and year > end:
        return False
    return True
