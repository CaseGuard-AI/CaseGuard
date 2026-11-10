"""Wires configuration, shared services and scrapers together for one run."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from config import PROJECT_ROOT, SOURCES, Settings, SourceConfig
from models.legal_document import new_run_id
from pipeline.report import RunReport
from scrapers.base_scraper import BaseScraper, ScraperError
from scrapers.registry import get_scraper
from storage.file_storage import FileStorage
from storage.jsonl_storage import JsonlStorage
from storage.state_store import StateStore
from utils.http_client import HttpClient
from utils.logging_config import JsonlEventLogger, get_logger, setup_logging
from utils.rate_limiter import RateLimiter


class Runner:
    def __init__(self, settings: Settings, run_id: str | None = None) -> None:
        self.settings = settings
        self.settings.ensure_dirs()
        self.run_id = run_id or new_run_id()
        setup_logging(settings.log_dir, settings.log_level, self.run_id)
        self.log = get_logger("runner")
        self.started_at = datetime.now(UTC).isoformat()

        self.state = StateStore(settings.state_db)
        self.files = FileStorage(settings.raw_dir, settings.text_dir)
        self.events = JsonlEventLogger(settings.log_dir / f"events_{self.run_id}.jsonl")
        self.rate_limiter = RateLimiter(settings.request_delay, settings.max_concurrency)
        self.client = HttpClient(
            user_agent=settings.user_agent,
            timeout=settings.timeout,
            retry_count=settings.retry_count,
            backoff_base=settings.backoff_base,
            backoff_cap=settings.backoff_cap,
            respect_robots=settings.respect_robots,
            verify_tls=settings.verify_tls,
            rate_limiter=self.rate_limiter,
        )
        self.report = RunReport(self.run_id, self.started_at)

    # ------------------------------------------------------------------
    def build(self, source_key: str) -> BaseScraper:
        source_config: SourceConfig = SOURCES[source_key]
        storage = JsonlStorage(self.settings.jsonl_dir, source_key, self.run_id)
        scraper_class = get_scraper(source_key)
        return scraper_class(
            settings=self.settings,
            client=self.client,
            state=self.state,
            files=self.files,
            storage=storage,
            events=self.events,
            source_config=source_config,
        )

    # ------------------------------------------------------------------
    def run(self, source_keys: list[str]) -> RunReport:
        selection = self.settings.selection
        self.state.start_run(
            self.run_id,
            ",".join(source_keys),
            partition=self.settings.partition,
            selection_file=_relative(selection.path) if selection else None,
            selection_sha256=selection.sha256 if selection else None,
            source_snapshot=selection.source_snapshot if selection else None,
        )
        self.log.info("Run %s over: %s", self.run_id, ", ".join(source_keys))

        for key in source_keys:
            if key not in SOURCES:
                self.log.error("Unknown source %r -- skipping", key)
                continue
            try:
                scraper = self.build(key)
                stats = scraper.run()
                self.report.add_source(key, stats.as_dict())
            except ScraperError as exc:
                # A gated or unreachable source must not stop the others.
                self.log.error("%s not run: %s", key, exc)
                self.report.add_source(key, {"skipped": 1})
                self.events.emit("source_skipped", source=key, reason=str(exc))
            except Exception as exc:  # noqa: BLE001
                self.log.exception("%s crashed: %s", key, exc)
                self.report.add_source(key, {"crashed": 1})
                self.events.emit("source_crashed", source=key, error=str(exc))

        if selection is not None:
            missing = selection.missing()
            if missing:
                self.log.warning(
                    "%d selected item(s) were not found, e.g. %s",
                    len(missing),
                    ", ".join(missing[:3]),
                )
                self.events.emit("selection_missing", count=len(missing), sample=missing[:20])

        self.report.errors = RunReport.from_events(self.run_id, self.started_at, self.events).errors
        self.report.finished_at = datetime.now(UTC).isoformat()
        text_path, json_path = self.report.save(self.settings.report_dir)
        self.state.finish_run(self.run_id, str(self.report.totals()))
        self.log.info("HTTP stats: %s", self.client.stats)
        self.log.info("Report written to %s", text_path)
        return self.report

    # ------------------------------------------------------------------
    def probe(self, source_key: str) -> dict:
        scraper = self.build(source_key)
        probe_fn = getattr(scraper, "probe", None)
        out_dir = self.settings.output_dir / "probe"
        if probe_fn is None:
            from urllib.parse import urljoin

            url = urljoin(SOURCES[source_key].base_url, "/")
            response = self.client.get(url)
            out_dir.mkdir(parents=True, exist_ok=True)
            target = out_dir / f"{source_key}_root.html"
            target.write_text(response.text, encoding="utf-8")
            return {"url": url, "status": response.status_code, "saved_to": str(target)}
        return probe_fn(out_dir)

    def close(self) -> None:
        self.client.close()
        self.state.close()

    def __enter__(self) -> Runner:
        return self

    def __exit__(self, *exc) -> bool:
        self.close()
        return False


def _relative(path: Path) -> str:
    """The selection file as recorded in run metadata: relative to the collector when inside it."""
    try:
        return path.resolve().relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        return str(path)
