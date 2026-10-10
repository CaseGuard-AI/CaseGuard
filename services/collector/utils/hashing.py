"""Hashing helpers for dedup and change detection."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

_WS = re.compile(r"\s+")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str | Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalise_text(text: str) -> str:
    """Collapse whitespace and case so trivial reformatting does not look
    like a new version of the document."""
    return _WS.sub(" ", text or "").strip().lower()


def sha256_text(text: str) -> str:
    return hashlib.sha256(normalise_text(text).encode("utf-8")).hexdigest()


def url_key(url: str) -> str:
    """Stable short key for a URL, safe to use as a filename."""
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:20]


def safe_filename(name: str, max_len: int = 120) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", (name or "").strip())
    cleaned = re.sub(r"_+", "_", cleaned).strip("._-")
    return (cleaned or "document")[:max_len]
