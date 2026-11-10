"""Configuration.

Everything tunable lives here. Values come from (lowest to highest priority):
    dataclass defaults  ->  environment variables  ->  CLI flags

Secrets (DB password etc.) come from the environment only, never from code.
Copy .env.example to .env and edit it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

try:  # optional convenience
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover
    pass


PROJECT_ROOT = Path(__file__).resolve().parent


def _env_bool(key: str, default: bool) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.getenv(key, default))
    except (TypeError, ValueError):
        return default


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, default))
    except (TypeError, ValueError):
        return default


# ----------------------------------------------------------------------
# Per-source access policy
# ----------------------------------------------------------------------
@dataclass(frozen=True)
class SourceConfig:
    """One entry per target website.

    status:
        "verified"        structure confirmed against the live site (see README)
        "needs_probe"     site blocked automated inspection; run `--probe` first
        "blocked_by_robots"  robots.txt disallows; scraper ships disabled

    requires_permission:
        True  -> refuses to run unless --i-have-permission is passed AND
                 PKLEGAL_PERMISSION_<KEY>=1 is set in the environment.
    """

    key: str
    name: str
    base_url: str
    enabled_by_default: bool = False
    status: str = "needs_probe"
    requires_permission: bool = False
    min_delay_seconds: float = 2.0
    notes: str = ""


SOURCES: dict[str, SourceConfig] = {
    "pakistan_code": SourceConfig(
        key="pakistan_code",
        name="The Pakistan Code (Ministry of Law & Justice)",
        base_url="https://pakistancode.gov.pk",
        enabled_by_default=True,
        status="verified",
        min_delay_seconds=2.0,
        notes=(
            "Plain server-rendered HTML. Listing pages are paginated by query "
            "string. Statute text itself is only in the linked PDF."
        ),
    ),
    "shc_caselaw": SourceConfig(
        key="shc_caselaw",
        name="Sindh High Court - Caselaw portal",
        base_url="https://caselaw.shc.gov.pk",
        enabled_by_default=True,
        status="verified",
        min_delay_seconds=3.0,
        notes=(
            "Richest free case-law source in Pakistan. A judge index at "
            "/caselaw/public/rpt-afr links to per-judge HTML tables (~70k "
            "judgments) with case no., type, parties, bench, judges, citation, "
            "head-note, connected SCP matters and a direct download link per "
            "judgment. Set PKLEGAL_SHC_SCOPE=all for everything, not just "
            "judgments approved for reporting."
        ),
    ),
    "federal_shariat_court": SourceConfig(
        key="federal_shariat_court",
        name="Federal Shariat Court",
        base_url="https://www.federalshariatcourt.gov.pk",
        enabled_by_default=True,
        status="verified",
        min_delay_seconds=3.0,
        notes=(
            "Reachable and serves judgment PDFs directly from /Judgments/. "
            "Leading-judgements table (~70 landmark cases back to 1980, several "
            "with PLD FSC citations) is verified; the bulk /judgement.php "
            "listing is read with a plain GET only -- its paging parameters "
            "were not inspected."
        ),
    ),
    "supreme_court": SourceConfig(
        key="supreme_court",
        name="Supreme Court of Pakistan",
        base_url="https://www.supremecourt.gov.pk",
        enabled_by_default=False,
        status="needs_probe",
        min_delay_seconds=4.0,
        notes=(
            "Sits behind bot protection that rejected inspection from a "
            "datacentre IP. Judgment PDFs are served from "
            "https://scp.gov.pk/files/judgments/<CASE>.pdf . Run "
            "`python main.py --source supreme_court --probe` from your own "
            "network before trusting the parser."
        ),
    ),
    "lahore_high_court": SourceConfig(
        key="lahore_high_court",
        name="Lahore High Court",
        base_url="https://data.lhc.gov.pk",
        enabled_by_default=False,
        status="blocked_by_robots",
        requires_permission=True,
        min_delay_seconds=6.0,
        notes=(
            "robots.txt disallows automated access, and the site carries an "
            "explicit notice that content may not be downloaded without prior "
            "permission. Ships DISABLED. Write to the LHC IT/Registrar office "
            "and only enable after you hold written permission."
        ),
    ),
}

# Courts not yet implemented. Each needs the 6-step study in README §"Adding
# a source" before a parser is written. Listed here so --list-sources is honest.
PLANNED_SOURCES: dict[str, str] = {
    "islamabad_high_court": "https://www.ihc.gov.pk",
    "peshawar_high_court": "https://www.peshawarhighcourt.gov.pk",
    "balochistan_high_court": "https://www.balochistanhighcourt.gov.pk",
    "federal_constitutional_court": "https://www.fccp.gov.pk",
    "national_assembly": "https://na.gov.pk",
    "senate": "https://senate.gov.pk",
    "punjab_laws": "http://punjablaws.gov.pk",
}


# ----------------------------------------------------------------------
# Runtime settings
# ----------------------------------------------------------------------
@dataclass
class Settings:
    # output
    output_dir: Path = field(
        default_factory=lambda: Path(os.getenv("PKLEGAL_OUTPUT_DIR", PROJECT_ROOT / "data"))
    )
    # networking
    user_agent: str = os.getenv(
        "PKLEGAL_USER_AGENT",
        "PKLegalFYP-Research-Crawler/0.1 (university FYP; contact: you@example.edu)",
    )
    request_delay: float = _env_float("PKLEGAL_REQUEST_DELAY", 2.0)
    timeout: float = _env_float("PKLEGAL_TIMEOUT", 45.0)
    retry_count: int = _env_int("PKLEGAL_RETRY_COUNT", 4)
    backoff_base: float = _env_float("PKLEGAL_BACKOFF_BASE", 2.0)
    backoff_cap: float = _env_float("PKLEGAL_BACKOFF_CAP", 60.0)
    max_concurrency: int = _env_int("PKLEGAL_MAX_CONCURRENCY", 2)
    respect_robots: bool = _env_bool("PKLEGAL_RESPECT_ROBOTS", True)
    verify_tls: bool = _env_bool("PKLEGAL_VERIFY_TLS", True)

    # crawl scope
    max_pages: int | None = None
    limit: int | None = None
    start_year: int | None = None
    end_year: int | None = None

    # behaviour
    download_pdfs: bool = _env_bool("PKLEGAL_DOWNLOAD_PDFS", True)
    ocr_enabled: bool = _env_bool("PKLEGAL_OCR_ENABLED", False)
    ocr_language: str = os.getenv("PKLEGAL_OCR_LANG", "eng")
    force: bool = False  # re-fetch even if already seen
    dry_run: bool = False  # discover + log, write nothing
    i_have_permission: bool = False

    # partitions (#153): set by --partition, see partitions.py
    partition: str | None = None
    shc_scope: str | None = None  # overrides PKLEGAL_SHC_SCOPE
    selection: Any = None  # partitions.Selection: only these discovered items are processed

    # storage
    database_url: str | None = os.getenv("PKLEGAL_DATABASE_URL")  # postgresql+psycopg://...
    log_level: str = os.getenv("PKLEGAL_LOG_LEVEL", "INFO")

    # ---- derived paths ------------------------------------------------
    @property
    def raw_dir(self) -> Path:
        return self.output_dir / "raw"

    @property
    def text_dir(self) -> Path:
        return self.output_dir / "text"

    @property
    def jsonl_dir(self) -> Path:
        return self.output_dir / "documents"

    @property
    def state_db(self) -> Path:
        return self.output_dir / "state" / "state.db"

    @property
    def log_dir(self) -> Path:
        return self.output_dir / "logs"

    @property
    def report_dir(self) -> Path:
        return self.output_dir / "reports"

    def ensure_dirs(self) -> None:
        for path in (
            self.raw_dir,
            self.text_dir,
            self.jsonl_dir,
            self.state_db.parent,
            self.log_dir,
            self.report_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)

    def delay_for(self, source_key: str) -> float:
        """Politeness delay: the stricter of the global and per-source value."""
        src = SOURCES.get(source_key)
        return max(self.request_delay, src.min_delay_seconds if src else 0.0)

    def with_overrides(self, **kwargs) -> Settings:
        clean = {k: v for k, v in kwargs.items() if v is not None}
        return replace(self, **clean)


def default_enabled_sources() -> list[str]:
    return [k for k, s in SOURCES.items() if s.enabled_by_default]
