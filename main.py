#!/usr/bin/env python3
"""Pakistani legal-data ingestion pipeline -- command line entry point.

Examples
--------
    python main.py --list-sources
    python main.py --source pakistan_code --limit 10          # test run
    python main.py --source pakistan_code --max-pages 2 --dry-run
    python main.py --source shc_caselaw --limit 25
    python main.py --source all --start-year 2020 --end-year 2026
    python main.py --source supreme_court --probe
    python main.py --source supreme_court --ingest-dir ./manual_pdfs
    python main.py --source shc_caselaw --no-pdfs --limit 500 # metadata-first pass
    python main.py --retry-failed --source pakistan_code      # re-attempt failures
    python main.py --list-bootstrap
    python main.py --bootstrap pakistan_laws --limit 50       # third-party corpus
    python main.py --bootstrap-compare pakistan_laws          # coverage check
    python main.py --report                                   # last run summary
    python main.py --load-db --source pakistan_code           # JSONL -> Postgres
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from config import PLANNED_SOURCES, SOURCES, Settings, default_enabled_sources
from pipeline.runner import Runner


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="main.py",
        description="Provenance-tracked ingestion of Pakistani legal documents.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    what = parser.add_argument_group("what to scrape")
    what.add_argument("--source", default=None,
                      help="source key, comma-separated list, or 'all'")
    what.add_argument("--start-year", type=int)
    what.add_argument("--end-year", type=int)
    what.add_argument("--limit", type=int,
                      help="stop after N stored documents (test mode)")
    what.add_argument("--max-pages", type=int,
                      help="cap listing pages per index")

    how = parser.add_argument_group("how to behave")
    how.add_argument("--delay", type=float, dest="request_delay",
                     help="minimum seconds between requests to one host")
    how.add_argument("--timeout", type=float)
    how.add_argument("--retries", type=int, dest="retry_count")
    how.add_argument("--concurrency", type=int, dest="max_concurrency")
    how.add_argument("--no-pdfs", action="store_true",
                     help="skip PDF download and text extraction")
    how.add_argument("--ocr", action="store_true",
                     help="OCR scanned PDFs (needs tesseract installed)")
    how.add_argument("--force", action="store_true",
                     help="re-fetch documents already recorded as seen")
    how.add_argument("--dry-run", action="store_true",
                     help="discover and parse, write nothing")
    how.add_argument("--ignore-robots", action="store_true",
                     help=argparse.SUPPRESS)   # intentionally undocumented
    how.add_argument("--i-have-permission", action="store_true",
                     help="unlock a permission-gated source (see README)")
    how.add_argument("--output-dir", type=Path)
    how.add_argument("--log-level", default=None,
                     choices=["DEBUG", "INFO", "WARNING", "ERROR"])

    tools = parser.add_argument_group("tools")
    tools.add_argument("--list-sources", action="store_true")
    tools.add_argument("--probe", action="store_true",
                       help="save what a source's endpoints return, for inspection")
    tools.add_argument("--ingest-dir", type=Path,
                       help="ingest PDFs you downloaded by hand into a source")
    tools.add_argument("--report", action="store_true",
                       help="print the most recent run report")
    tools.add_argument("--status", action="store_true",
                       help="show crawl-state counts")
    tools.add_argument("--load-db", action="store_true",
                       help="load a source's JSONL into PKLEGAL_DATABASE_URL")
    tools.add_argument("--sample", type=int, metavar="N",
                       help="write a pretty-printed N-record sample JSON")
    tools.add_argument("--retry-failed", action="store_true",
                       help="re-attempt URLs that failed in earlier runs")
    tools.add_argument("--bootstrap", metavar="DATASET",
                       help="load a third-party HF dataset (see --list-bootstrap)")
    tools.add_argument("--bootstrap-compare", metavar="DATASET",
                       help="compare your crawl's coverage against a dataset")
    tools.add_argument("--list-bootstrap", action="store_true",
                       help="list available bootstrap datasets")
    return parser


# ----------------------------------------------------------------------
def resolve_sources(value: str | None) -> list[str]:
    if not value:
        return default_enabled_sources()
    if value.strip().lower() == "all":
        return list(SOURCES)
    keys = [k.strip() for k in value.split(",") if k.strip()]
    unknown = [k for k in keys if k not in SOURCES]
    if unknown:
        raise SystemExit(
            f"Unknown source(s): {', '.join(unknown)}\n"
            f"Known: {', '.join(SOURCES)}\n"
            "Run --list-sources for details."
        )
    return keys


def print_sources() -> None:
    print("\nImplemented sources")
    print("-" * 78)
    for key, source in SOURCES.items():
        default = "on " if source.enabled_by_default else "off"
        gate = "  [PERMISSION REQUIRED]" if source.requires_permission else ""
        print(f"  {key:<22} {source.status:<18} default:{default}{gate}")
        print(f"  {'':<22} {source.base_url}")
        for line in _wrap(source.notes, 72):
            print(f"  {'':<22} {line}")
        print()
    print("Planned (config + registry entry needed -- see scrapers/_template.py)")
    print("-" * 78)
    for key, url in PLANNED_SOURCES.items():
        print(f"  {key:<32} {url}")
    print()


def _wrap(text: str, width: int) -> list[str]:
    import textwrap
    return textwrap.wrap(text or "", width)


def settings_from_args(args: argparse.Namespace) -> Settings:
    settings = Settings()
    overrides = {
        "limit": args.limit,
        "max_pages": args.max_pages,
        "start_year": args.start_year,
        "end_year": args.end_year,
        "request_delay": args.request_delay,
        "timeout": args.timeout,
        "retry_count": args.retry_count,
        "max_concurrency": args.max_concurrency,
        "output_dir": args.output_dir,
        "log_level": args.log_level,
    }
    settings = settings.with_overrides(**overrides)
    if args.no_pdfs:
        settings.download_pdfs = False
    if args.ocr:
        settings.ocr_enabled = True
    if args.force:
        settings.force = True
    if args.dry_run:
        settings.dry_run = True
    if args.i_have_permission:
        settings.i_have_permission = True
    if args.ignore_robots:
        print("Refusing --ignore-robots. If a site disallows crawling, ask its "
              "owner for permission instead.", file=sys.stderr)
        raise SystemExit(2)
    return settings


# ----------------------------------------------------------------------
def cmd_report(settings: Settings) -> int:
    reports = sorted(settings.report_dir.glob("report_*.txt"),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    if not reports:
        print("No reports yet. Run a scrape first.")
        return 1
    print(reports[0].read_text(encoding="utf-8"))
    return 0


def cmd_status(settings: Settings) -> int:
    from storage.state_store import StateStore
    if not settings.state_db.exists():
        print("No crawl state yet.")
        return 1
    state = StateStore(settings.state_db)
    print(f"\nCrawl state: {settings.state_db}\n" + "-" * 50)
    print(f"  {'ALL':<22} {state.counts()}")
    for key in SOURCES:
        counts = state.counts(key)
        if counts["seen"] or counts["open_failures"]:
            print(f"  {key:<22} {counts}")
    state.close()
    print()
    return 0


def cmd_load_db(settings: Settings, sources: list[str]) -> int:
    if not settings.database_url:
        print("Set PKLEGAL_DATABASE_URL first, e.g.\n"
              "  export PKLEGAL_DATABASE_URL="
              "'postgresql+psycopg://user:pass@localhost:5432/pklegal'",
              file=sys.stderr)
        return 2
    from storage.database import load_jsonl
    total = {"inserted": 0, "updated": 0}
    for key in sources:
        path = settings.jsonl_dir / f"{key}.jsonl"
        if not path.exists():
            print(f"  {key}: nothing at {path}, skipping")
            continue
        result = load_jsonl(settings.database_url, path)
        print(f"  {key}: {result}")
        total["inserted"] += result["inserted"]
        total["updated"] += result["updated"]
    print(f"Done: {total}")
    return 0


def cmd_list_bootstrap() -> int:
    from storage.bootstrap_datasets import DATASETS
    print("\nThird-party bootstrap datasets")
    print("-" * 78)
    print("These are NOT official sources. Records load under an `hf_` source")
    print("key with no document_url, flagged is_official_source=false. Keep that")
    print("distinction all the way into your vector store.\n")
    for key, dataset in DATASETS.items():
        print(f"  {key:<24} {dataset.repo_id}")
        for line in _wrap(dataset.description, 70):
            print(f"  {'':<24} {line}")
        if dataset.expected_rows:
            print(f"  {'':<24} ~{dataset.expected_rows} rows")
        print()
    return 0


def cmd_bootstrap(settings: Settings, key: str) -> int:
    from storage.bootstrap_datasets import DATASETS, ingest
    from storage.jsonl_storage import JsonlStorage
    from storage.state_store import StateStore
    if key not in DATASETS:
        print(f"Unknown dataset {key!r}. Run --list-bootstrap.", file=sys.stderr)
        return 2
    state = StateStore(settings.state_db)
    try:
        stats = ingest(
            key,
            lambda source: JsonlStorage(settings.jsonl_dir, source),
            state, limit=settings.limit, dry_run=settings.dry_run,
        )
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 2
    finally:
        state.close()
    print(f"\n{DATASETS[key].repo_id}: {stats}")
    print("Loaded under source key "
          f"{DATASETS[key].source_key!r} -- third-party provenance, not official.")
    return 0


def cmd_bootstrap_compare(settings: Settings, key: str, sources: list[str]) -> int:
    import json as _json
    from storage.bootstrap_datasets import DATASETS, compare_coverage
    if key not in DATASETS:
        print(f"Unknown dataset {key!r}. Run --list-bootstrap.", file=sys.stderr)
        return 2
    own = sources[0] if sources else "pakistan_code"
    path = settings.jsonl_dir / f"{own}.jsonl"
    if not path.exists():
        print(f"No corpus at {path}. Run a scrape first.", file=sys.stderr)
        return 1
    print(_json.dumps(compare_coverage(key, path), indent=2))
    return 0


def cmd_retry_failed(settings: Settings, sources: list[str]) -> int:
    """Re-attempt URLs recorded as failures, without re-walking the site."""
    from pipeline.runner import Runner
    from storage.state_store import StateStore

    state = StateStore(settings.state_db)
    total = 0
    with Runner(settings) as runner:
        for key in sources:
            failures = state.open_failures(key)
            if not failures:
                print(f"  {key}: no open failures")
                continue
            print(f"  {key}: retrying {len(failures)} URL(s)")
            scraper = runner.build(key)
            for failure in failures:
                url = failure["url"]
                try:
                    response = scraper.client.get(url)
                except Exception as exc:                    # noqa: BLE001
                    state.record_failure(url, key, str(exc))
                    print(f"     still failing: {url[:70]} ({exc})")
                    continue
                state.clear_failure(url)
                total += 1
                print(f"     recovered ({response.status_code}): {url[:70]}")
    state.close()
    print(f"\n{total} URL(s) recovered. Re-run the scraper to ingest them.")
    return 0


def cmd_sample(settings: Settings, sources: list[str], n: int) -> int:
    from storage.jsonl_storage import JsonlStorage
    for key in sources:
        path = settings.jsonl_dir / f"{key}.jsonl"
        if not path.exists():
            continue
        out = settings.report_dir / f"sample_{key}.json"
        JsonlStorage.export_sample(path, out, n)
        print(f"  wrote {out}")
    return 0


# ----------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.list_sources:
        print_sources()
        return 0
    if args.list_bootstrap:
        return cmd_list_bootstrap()

    settings = settings_from_args(args)
    settings.ensure_dirs()

    if args.report:
        return cmd_report(settings)
    if args.status:
        return cmd_status(settings)

    if args.bootstrap:
        return cmd_bootstrap(settings, args.bootstrap)

    sources = resolve_sources(args.source)

    if args.bootstrap_compare:
        return cmd_bootstrap_compare(settings, args.bootstrap_compare, sources)
    if args.retry_failed:
        return cmd_retry_failed(settings, sources)
    if args.load_db:
        return cmd_load_db(settings, sources)
    if args.sample:
        return cmd_sample(settings, sources, args.sample)

    with Runner(settings) as runner:
        if args.probe:
            for key in sources:
                print(f"\n--- probe: {key} ---")
                print(json.dumps(runner.probe(key), indent=2, default=str))
            return 0

        if args.ingest_dir:
            if len(sources) != 1:
                print("--ingest-dir needs exactly one --source", file=sys.stderr)
                return 2
            scraper = runner.build(sources[0])
            ingest = getattr(scraper, "ingest_directory", None)
            if ingest is None:
                print(f"{sources[0]} does not support manual ingestion",
                      file=sys.stderr)
                return 2
            count = ingest(args.ingest_dir)
            print(f"Ingested {count} file(s) into {sources[0]}")
            return 0

        report = runner.run(sources)
        print(report.render())
        totals = report.totals()
        return 0 if totals.get("stored", 0) or settings.dry_run else 1


if __name__ == "__main__":
    raise SystemExit(main())
