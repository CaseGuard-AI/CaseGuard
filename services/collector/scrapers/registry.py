"""Maps a source key to its scraper class. Adding a court = one line here."""

from __future__ import annotations

from scrapers.base_scraper import BaseScraper
from scrapers.federal_shariat_court import FederalShariatCourtScraper
from scrapers.lahore_high_court import LahoreHighCourtScraper
from scrapers.pakistan_code import PakistanCodeScraper
from scrapers.shc_caselaw import SindhHighCourtScraper
from scrapers.supreme_court import SupremeCourtScraper

SCRAPERS: dict[str, type[BaseScraper]] = {
    PakistanCodeScraper.source_key: PakistanCodeScraper,
    SindhHighCourtScraper.source_key: SindhHighCourtScraper,
    FederalShariatCourtScraper.source_key: FederalShariatCourtScraper,
    SupremeCourtScraper.source_key: SupremeCourtScraper,
    LahoreHighCourtScraper.source_key: LahoreHighCourtScraper,
}


def get_scraper(key: str) -> type[BaseScraper]:
    try:
        return SCRAPERS[key]
    except KeyError:
        raise KeyError(
            f"unknown source {key!r}; available: {', '.join(sorted(SCRAPERS))}"
        ) from None


def available() -> list[str]:
    return sorted(SCRAPERS)
