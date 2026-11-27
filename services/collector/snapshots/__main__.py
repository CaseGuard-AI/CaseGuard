"""``python -m snapshots push|pull|status`` (#152). See the package docstring and
docs/engineering/data-storage.md §3, §7. Exit codes: 0 done, 1 Hugging Face error, 2 refused."""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

from snapshots import SnapshotRefused, check_partition_name
from snapshots.manifest import COLLECTOR_DIR, describe

STAGING = COLLECTOR_DIR / ".snapshots"  # git-ignored


def default_partitions_dir() -> Path:
    from config import Settings

    return Settings().output_dir / "partitions"


def ask(question: str) -> bool:
    try:
        # A BOM can lead piped stdin on Windows (PowerShell), so strip it with the whitespace.
        answer = input(f"{question} [y/N] ").strip().lstrip("﻿").strip().lower()
        return answer in {"y", "yes"}
    except EOFError:
        return False


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m snapshots", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    push = sub.add_parser("push", help="pack a partition, check it, publish it")
    push.add_argument("--snapshot", required=True, metavar="PARTITION")
    push.add_argument("--dir", type=Path, help="the partition dir, a full path (default data/partitions/<p>)")
    push.add_argument("--date", help="the folder's day (default today)")
    push.add_argument("--out", type=Path, help=f"where to pack it, a full path (default {STAGING}/<p>/<folder>)")
    push.add_argument("--no-upload", action="store_true", help="pack and check only")
    push.add_argument("--yes", action="store_true", help="publish without asking")

    pull = sub.add_parser("pull", help="download a snapshot into data/partitions/<p>")
    pull.add_argument("--snapshot", required=True, metavar="PARTITION")
    pull.add_argument("--date", help="latest (default), a day, or a folder like 2026-11-10-2")
    pull.add_argument("--with-files", action="store_true", help="also files.tar (raw/ + text/)")
    pull.add_argument("--into", type=Path, help="the partition dir, a full path (default data/partitions/<p>)")
    pull.add_argument("--from", dest="source", type=Path, help="a local snapshot folder (full path) instead")
    pull.add_argument("--yes", action="store_true", help="replace an existing partition")

    sub.add_parser("status", help="list snapshots and dumps, and the repo's size")
    return parser


def _push(args: argparse.Namespace) -> int:
    from snapshots.gate import problems
    from snapshots.pack import pack

    partition = check_partition_name(args.snapshot)
    partition_dir: Path = args.dir or default_partitions_dir() / partition
    day = args.date or date.today().isoformat()
    hub = None
    if args.no_upload:
        folder = day
    else:
        from snapshots.hub import SnapshotHub

        hub = SnapshotHub.from_env()
        folder = hub.next_folder(partition, day)
    out_dir: Path = args.out or STAGING / partition / folder
    print(f"packing {partition_dir} into {out_dir} ...", file=sys.stderr, flush=True)
    packed = pack(partition_dir, out_dir, partition=partition, folder=folder)
    print(describe(packed.manifest))
    if packed.duplicates:
        print(f"note: {packed.duplicates} older lines replaced by a newer line for the same id")

    found = problems(partition_dir, out_dir)
    if found:
        verb = "would refuse to publish" if args.no_upload else "not publishing"
        print(f"{verb}:", file=sys.stderr)
        for problem in found:
            print(f"  - {problem}", file=sys.stderr)
        return 0 if args.no_upload else 2
    if hub is None:
        print(f"packed and checked; nothing published. The files are in {out_dir}")
        return 0

    from huggingface_hub.errors import HfHubHTTPError

    if not args.yes and not ask(
        f"Publish snapshots/{partition}/{folder}/ to {hub.repo_id}? "
        "A published snapshot can never be changed or deleted."
    ):
        print("not published; the files stay in", out_dir)
        return 0
    try:
        name = hub.publish(out_dir)
    except HfHubHTTPError as exc:  # no write access, repo missing, someone published meanwhile
        print(f"Hugging Face refused the upload: {exc}", file=sys.stderr)
        return 1
    print(f"published snapshots/{partition}/{name}/ (tag snap/{partition}/{name})")
    print(f"Put {partition}@{name} in services/collector/PARTITIONS.md's Latest snapshot column.")
    return 0


def _pull(args: argparse.Namespace) -> int:
    from snapshots.pull import pull

    partition = check_partition_name(args.snapshot)
    partition_dir: Path = args.into or default_partitions_dir() / partition
    hub = None
    if args.source is None:
        from snapshots.hub import SnapshotHub

        hub = SnapshotHub.from_env()
        print(
            f"downloading {partition}@{args.date or 'latest'} from {hub.repo_id} ...",
            file=sys.stderr,
            flush=True,
        )
    from huggingface_hub.errors import HfHubHTTPError

    try:
        pulled = pull(
            partition,
            partition_dir,
            hub=hub,
            date=args.date,
            source_dir=args.source,
            with_files=args.with_files,
            yes=args.yes,
        )
    except HfHubHTTPError as exc:  # no access, or no such snapshot
        print(f"Hugging Face refused the download: {exc}", file=sys.stderr)
        return 1
    print(f"unpacked {describe(pulled.manifest)} into {partition_dir}")
    if not pulled.with_files:
        print("files.tar (raw/ + text/) skipped: pass --with-files to fetch it")
    print(f"load it with: pnpm data:load -- {partition_dir} --snapshot {pulled.manifest.snapshot}")
    return 0


def _status() -> int:
    from huggingface_hub.errors import HfHubHTTPError

    from snapshots.hub import SnapshotHub
    from snapshots.status import report

    hub = SnapshotHub.from_env()
    try:
        inventory = hub.inventory()
    except HfHubHTTPError as exc:
        print(f"Hugging Face refused the listing: {exc}", file=sys.stderr)
        return 1
    print(report(hub.repo_id, inventory, default_partitions_dir()))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args([a for a in (sys.argv[1:] if argv is None else argv) if a != "--"])
    try:
        if args.command == "push":
            return _push(args)
        if args.command == "pull":
            return _pull(args)
        return _status()
    except SnapshotRefused as exc:
        print(f"refusing: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
