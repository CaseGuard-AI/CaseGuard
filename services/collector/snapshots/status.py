"""What the corpus repo holds, and how full it is (data-storage spec §5, §7).

Lists every partition's snapshots and every dump, with ``LATEST``, and shows the repo's size
against the 100 GB limit. At 75 GB it says to start ``caseguard/corpus-v2``. It also lists the
local partitions and the snapshot each was pulled from. The loaded corpus dump lives in the AI
database: ``pnpm data:status`` (scripts/data.mjs) asks services/ai for it after this.
"""

from __future__ import annotations

import json
from pathlib import Path

from snapshots import folder_key
from snapshots.hub import Inventory

GB = 10**9
LIMIT_BYTES = 100 * GB
WARN_BYTES = 75 * GB


def _size(n: int) -> str:
    if n >= GB:
        return f"{n / GB:.2f} GB"
    return f"{n / 1e6:.1f} MB"


def usage_lines(total: int) -> list[str]:
    lines = [f"usage: {_size(total)} of 100 GB ({100 * total / LIMIT_BYTES:.1f}%)"]
    if total >= WARN_BYTES:
        lines.append(
            "WARNING: the repo is past 75 GB. Start caseguard/corpus-v2, seeded with the latest "
            "snapshot of each partition and every dump/eval-frozen-* (data-storage.md §5)"
        )
    return lines


def local_lines(partitions_dir: Path) -> list[str]:
    if not partitions_dir.is_dir():
        return [f"local partitions: none ({partitions_dir})"]
    lines = [f"local partitions ({partitions_dir}):"]
    found = False
    for folder in sorted(p for p in partitions_dir.iterdir() if p.is_dir()):
        found = True
        origin = "crawled here"
        marker = folder / "snapshot.json"
        if marker.is_file():
            try:
                data = json.loads(marker.read_text(encoding="utf-8"))
                origin = f"pulled {data.get('partition')}@{data.get('folder')}"
            except ValueError:
                origin = "snapshot.json unreadable"
        lines.append(f"  {folder.name:<16} {origin}")
    if not found:
        lines.append("  none")
    return lines


def report(repo_id: str, inv: Inventory, partitions_dir: Path | None = None) -> str:
    lines = [f"{repo_id}"]
    lines.append("snapshots:")
    if not inv.snapshots:
        lines.append("  none yet")
    for partition, folders in sorted(inv.snapshots.items()):
        ordered = sorted(folders, key=folder_key)
        real = [f for f in ordered if (partition, f) in inv.with_manifest]
        listed = ", ".join(
            f"{f} ({_size(folders[f])}"
            + ("" if f in real else ", no manifest: uploaded by hand, not pullable")
            + ")"
            for f in ordered
        )
        lines.append(f"  {partition:<16} {listed}  latest {real[-1] if real else 'none'}")
    lines.append("dumps:")
    if not inv.dumps:
        lines.append("  none yet")
    else:
        ordered = sorted(inv.dumps, key=folder_key)
        lines.append("  " + ", ".join(f"{f} ({_size(inv.dumps[f])})" for f in ordered))
        lines.append(f"  LATEST = {inv.latest_dump or 'unknown'}")
    lines.extend(usage_lines(inv.total_bytes))
    if partitions_dir is not None:
        lines.extend(local_lines(partitions_dir))
    return "\n".join(lines)
