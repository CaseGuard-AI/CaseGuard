"""Replace the local corpus with a published dump (#154, data-storage spec §4, §7).

    uv run python -m caseguard_ai.ingest.pull --dump latest|<date>[-N]|eval-frozen-<n> [--from DIR] [--yes]
    pnpm data:pull -- --dump latest

1. Download ``dumps/<folder>/`` from ``HF_CORPUS_REPO`` into the Hugging Face cache, or use a local
   folder (``--from``) holding ``manifest.json`` and ``corpus.dump``.
2. Check the SHA-256, and **refuse** a dump from another Alembic revision: run
   ``pnpm db:migrate:ai`` first.
3. Show the corpus loaded now next to the incoming one, and ask.
4. Truncate ``corpus`` and restore, in one transaction. ``app`` and ``ai`` are never touched.

``--snapshot`` (collector partitions) is #152's.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine

from caseguard_ai.config import DatabaseSettings
from caseguard_ai.ingest.dump import DumpRefused, Manifest, ask, describe, restore_dump


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Restore a published corpus dump (#154)")
    parser.add_argument(
        "--dump",
        required=True,
        metavar="latest|DATE|eval-frozen-N",
        help="which dump: latest, a folder date (2026-11-10 or 2026-11-10-2), or eval-frozen-<n>",
    )
    parser.add_argument(
        "--from",
        dest="source",
        type=Path,
        help="a local folder with manifest.json and corpus.dump (full path); skips the download",
    )
    parser.add_argument(
        "--yes", action="store_true", help="replace the local corpus without asking"
    )
    args = parser.parse_args([a for a in (sys.argv[1:] if argv is None else argv) if a != "--"])

    try:
        if args.source is not None:
            dump_dir: Path = args.source
            label = str(dump_dir)
        else:
            from huggingface_hub.errors import HfHubHTTPError

            from caseguard_ai.ingest.hub import CorpusHub

            hub = CorpusHub.from_settings()
            print(f"downloading {args.dump} from {hub.repo_id} ...", file=sys.stderr, flush=True)
            try:
                folder, dump_dir = hub.download(args.dump)
            except HfHubHTTPError as exc:  # no access, or no such dump
                print(f"Hugging Face refused the download: {exc}", file=sys.stderr)
                return 1
            label = f"dumps/{folder}"
    except DumpRefused as exc:
        print(f"refusing: {exc}", file=sys.stderr)
        return 2

    def confirm(current: dict[str, Any] | None, incoming: Manifest) -> bool:
        print(f"loaded now: {describe(current)}")
        print(f"{label}: {describe(incoming.data)}")
        if args.yes:
            return True
        return ask("Replace the local corpus with it?")

    engine = create_engine(DatabaseSettings().sqlalchemy_url)
    try:
        report = restore_dump(engine, dump_dir, confirm=confirm)
    except DumpRefused as exc:
        print(f"refusing: {exc}", file=sys.stderr)
        return 2
    finally:
        engine.dispose()
    if report is None:
        print("nothing changed")
        return 0
    print(report.line())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
