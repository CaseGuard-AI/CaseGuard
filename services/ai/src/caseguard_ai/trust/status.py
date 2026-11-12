"""Citation status from the checks (PRD §7.2, FR-TRUST-4, FR-TRUST-8, FR-TRUST-9).

| Status       | Rule                                                                         |
|--------------|------------------------------------------------------------------------------|
| verified     | existence passes and support passes and there is no blocking flag            |
| needs_review | existence passes but support is not "pass", or a blocking flag is present    |
| unverified   | existence fails                                                              |

The deterministic existence check decides first: no model check can lift a failed existence
(FR-TRUST-9). The support check (``trust.support``, FR-TRUST-3) runs only on citations that
passed existence; it is ``not_run`` otherwise. Only a support ``pass`` can make a citation
``verified``: ``uncertain``, ``fail`` and ``not_run`` all leave it ``needs_review`` (FR-TRUST-8).
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Literal

Status = Literal["verified", "needs_review", "unverified"]
Existence = Literal["pass", "fail"]
Support = Literal["pass", "uncertain", "fail", "not_run"]

VERIFIER_VERSION = "m2-support-1"

BLOCKING_FLAGS = frozenset({"overruled", "repealed", "superseded_version", "conflict"})
NON_BLOCKING_FLAGS = frozenset({"stale", "third_party_source", "headnote_only", "amended_since"})


def decide(existence: Existence, support: Support, flags: Iterable[str] = ()) -> Status:
    unknown = set(flags) - BLOCKING_FLAGS - NON_BLOCKING_FLAGS
    if unknown:
        raise ValueError(f"unknown flag(s): {sorted(unknown)}")
    if existence != "pass":
        return "unverified"
    if support != "pass" or BLOCKING_FLAGS.intersection(flags):
        return "needs_review"
    return "verified"


def is_stale(retrieved_at: datetime | None, now: datetime, stale_days: int) -> bool:
    """FR-TRUST-6: older than the review window, or never dated (unknown age is not current)."""
    return retrieved_at is None or now - retrieved_at > timedelta(days=stale_days)


def source_flags(
    *,
    headnote_only: bool,
    third_party: bool,
    retrieved_at: datetime | None = None,
    now: datetime | None = None,
    stale_days: int | None = None,
) -> list[str]:
    """Non-blocking flags that come from the source itself (PRD §7.2, collector README §10.4).

    ``stale`` is only considered when ``stale_days`` is given, so case material (which has no
    retrieval date) is never flagged.
    """
    flags: list[str] = []
    if headnote_only:
        flags.append("headnote_only")
    if third_party:
        flags.append("third_party_source")
    if stale_days is not None and is_stale(retrieved_at, now or datetime.now(UTC), stale_days):
        flags.append("stale")
    return flags
