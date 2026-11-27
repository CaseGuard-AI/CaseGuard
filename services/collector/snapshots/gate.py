"""The publish checks: what ``data:push`` refuses to upload (data-storage spec §3).

- a file that doesn't match its manifest checksum, or records that don't match its counts;
- uncommitted changes in ``services/collector`` (the manifest's commit must be the code that made
  the data), or no git at all;
- anything that looks like a user upload, an ``.env`` file, a key or a token;
- third-party (``hf_*``) records in a normal partition, or normal records in a bootstrap one;
- an empty partition.

Every problem is reported, not only the first.
"""

from __future__ import annotations

import gzip
import re
from pathlib import Path, PurePosixPath

from snapshots import FILES_TAR, MANIFEST_FILE, RECORDS_FILE, SnapshotRefused, is_bootstrap
from snapshots.manifest import Manifest, verify_snapshot
from snapshots.pack import DOCUMENTS, FILE_DIRS

# Files that are secrets, whatever folder they are in.
SECRET_NAME = re.compile(
    r"^(\.env(\..*)?|.*\.(pem|key|p12|pfx|token)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?"
    r"|credentials.*\.json|.*secrets?\.(json|ya?ml|txt)|(hf_|\.)?token(s)?(\.txt)?)$",
    re.I,
)
# What the collector itself writes: originals under raw/, extracted text under text/.
RAW_SUFFIXES = {".pdf", ".html", ".htm", ".doc", ".docx", ".rtf", ".txt", ".json", ".xml"}
TEXT_SUFFIXES = {".txt"}
# Token shapes, matched inside the records (full_text included). Never printed.
TOKEN = re.compile(
    r"\bhf_[A-Za-z0-9]{30,}\b|\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_\w{40,}"
    r"|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}|\bnvapi-[A-Za-z0-9_-]{32,}|\bAKIA[0-9A-Z]{16}\b"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
)


def secret_files(partition_dir: Path) -> list[str]:
    """Secret-looking files anywhere in the parts of the partition that get packed."""
    found: list[str] = []
    for name in (DOCUMENTS, "state", *FILE_DIRS):
        base = partition_dir / name
        if base.is_dir():
            found.extend(
                p.relative_to(partition_dir).as_posix()
                for p in sorted(base.rglob("*"))
                if SECRET_NAME.match(p.name)
            )
    return found


def upload_like_files(partition_dir: Path, sources: set[str]) -> list[str]:
    """Files under raw/ or text/ that the collector would not have written."""
    odd: list[str] = []
    for name, allowed in (("raw", RAW_SUFFIXES), ("text", TEXT_SUFFIXES)):
        base = partition_dir / name
        if not base.is_dir():
            continue
        for path in sorted(p for p in base.rglob("*") if p.is_file()):
            rel = PurePosixPath(path.relative_to(base).as_posix())
            if (
                len(rel.parts) < 2
                or rel.parts[0] not in sources
                or "uploads" in (p.lower() for p in rel.parts)
                or path.suffix.lower() not in allowed
            ):
                odd.append(f"{name}/{rel}")
    for path in partition_dir.rglob("*"):
        if path.is_dir() and path.name.lower() == "uploads":
            odd.append(path.relative_to(partition_dir).as_posix() + "/")
    return odd


def token_lines(records_gz: Path) -> list[int]:
    hits: list[int] = []
    with gzip.open(records_gz, "rt", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            if TOKEN.search(line):
                hits.append(line_no)
    return hits


def _sample(items: list[str], n: int = 5) -> str:
    more = f" and {len(items) - n} more" if len(items) > n else ""
    return ", ".join(items[:n]) + more


def problems(partition_dir: Path, snapshot_dir: Path) -> list[str]:
    """Everything that stops this snapshot being published; empty when it may go up."""
    found: list[str] = []
    try:
        manifest = verify_snapshot(snapshot_dir)
    except SnapshotRefused as exc:
        found.append(f"checksum or count mismatch: {exc}")
        try:
            manifest = Manifest.read(snapshot_dir / MANIFEST_FILE)
        except SnapshotRefused:
            return found

    git = manifest.data.get("git") or {}
    if git.get("commit") is None:
        found.append("no git commit recorded: run data:push from a git checkout")
    elif git.get("dirty") is not False:
        found.append(
            "services/collector has uncommitted changes: commit them first, so the manifest's "
            f"commit ({str(git.get('commit'))[:12]}) is the code that made this data"
        )

    counts = manifest.counts
    if not counts.get("records"):
        found.append("the partition has no records")
    sources = set(counts.get("by_source", {}))
    third = sorted(s for s in sources if s.startswith("hf_"))
    if is_bootstrap(manifest.partition):
        own = sorted(sources - set(third))
        if own:
            found.append(
                f"bootstrap partition {manifest.partition} holds non-hf_ records ({_sample(own)})"
            )
    elif third or counts.get("third_party"):
        found.append(
            f"third-party records ({_sample(third) or 'raw.provenance=third_party_dataset'}) "
            f"in normal partition {manifest.partition}: bootstrap data gets its own partition"
        )

    secrets = secret_files(partition_dir)
    if secrets:
        found.append(f"secret-looking files (.env, keys, tokens): {_sample(secrets)}")
    if FILES_TAR in manifest.files:
        odd = upload_like_files(partition_dir, sources)
        if odd:
            found.append(
                "files the collector didn't write (user uploads? stray files?) under "
                f"raw/ or text/: {_sample(odd)}"
            )
    if (snapshot_dir / RECORDS_FILE).is_file():
        lines = token_lines(snapshot_dir / RECORDS_FILE)
        if lines:
            found.append(
                f"something that looks like an API token or private key in {RECORDS_FILE} "
                f"(record lines {_sample([str(n) for n in lines])})"
            )
    return found


def check_publishable(partition_dir: Path, snapshot_dir: Path) -> Manifest:
    found = problems(partition_dir, snapshot_dir)
    if found:
        raise SnapshotRefused(
            "not publishing:\n" + "\n".join(f"  - {problem}" for problem in found)
        )
    return Manifest.read(snapshot_dir / MANIFEST_FILE)
