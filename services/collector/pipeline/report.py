"""Validation / run report.

Built from the JSONL event log plus the per-scraper counters, so it reflects
what actually happened rather than what the code intended.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from utils.logging_config import JsonlEventLogger


@dataclass
class RunReport:
    run_id: str
    started_at: str
    sources: dict[str, dict[str, int]] = field(default_factory=dict)
    finished_at: str | None = None
    errors: list[dict[str, Any]] = field(default_factory=list)

    # ------------------------------------------------------------------
    def add_source(self, key: str, stats: dict[str, int]) -> None:
        self.sources[key] = stats

    def totals(self) -> dict[str, int]:
        total: Counter = Counter()
        for stats in self.sources.values():
            total.update(stats)
        return dict(total)

    # ------------------------------------------------------------------
    @classmethod
    def from_events(cls, run_id: str, started_at: str,
                    events: JsonlEventLogger) -> "RunReport":
        report = cls(run_id=run_id, started_at=started_at)
        for event in events.read():
            if event.get("event") in {"fetch_failed", "document_failed",
                                      "robots_blocked", "pdf_extract_failed"}:
                report.errors.append(event)
        return report

    # ------------------------------------------------------------------
    def render(self) -> str:
        totals = self.totals()
        lines = [
            "=" * 66,
            f" INGESTION REPORT   run {self.run_id}",
            f" started {self.started_at}",
            f" finished {self.finished_at or '(in progress)'}",
            "=" * 66,
            "",
            f"  Total discovered        : {totals.get('discovered', 0)}",
            f"  Total fetched           : {totals.get('fetched', 0)}",
            f"  Total parsed            : {totals.get('parsed', 0)}",
            f"  Total stored            : {totals.get('stored', 0)}",
            f"  Total duplicates        : {totals.get('duplicates', 0)}",
            f"  Total failed            : {totals.get('failed', 0)}",
            f"  Skipped (already seen)  : {totals.get('skipped_seen', 0)}",
            f"  Skipped (304 unchanged) : {totals.get('skipped_unchanged', 0)}",
            f"  Changed since last run  : {totals.get('changed', 0)}",
            "",
            f"  PDF documents           : {totals.get('pdfs', 0)}",
            f"  HTML documents          : {totals.get('html_docs', 0)}",
            f"  PDF extraction failures : {totals.get('pdf_extract_failed', 0)}",
            f"  Scanned PDFs (need OCR) : {totals.get('scanned_pdfs', 0)}",
            "",
            f"  Failed validation       : {totals.get('invalid', 0)}",
            f"  Missing title or date   : {totals.get('missing_metadata', 0)}",
            "",
            "-" * 66,
            " Per source",
            "-" * 66,
        ]
        for key, stats in sorted(self.sources.items()):
            lines.append(f"  {key}")
            lines.append(
                "     discovered={discovered}  stored={stored}  "
                "duplicates={duplicates}  failed={failed}  invalid={invalid}".format(
                    **{k: stats.get(k, 0) for k in
                       ("discovered", "stored", "duplicates", "failed", "invalid")}
                )
            )

        if self.errors:
            lines += ["", "-" * 66, f" First 15 of {len(self.errors)} errors",
                      "-" * 66]
            for event in self.errors[:15]:
                lines.append(
                    f"  [{event.get('event')}] {event.get('url', '')[:88]}"
                )
                if event.get("error"):
                    lines.append(f"      {str(event['error'])[:100]}")
        lines.append("")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    def save(self, directory: Path) -> tuple[Path, Path]:
        directory.mkdir(parents=True, exist_ok=True)
        self.finished_at = self.finished_at or datetime.now(timezone.utc).isoformat()
        text_path = directory / f"report_{self.run_id}.txt"
        json_path = directory / f"report_{self.run_id}.json"
        text_path.write_text(self.render(), encoding="utf-8")
        json_path.write_text(json.dumps({
            "run_id": self.run_id,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "totals": self.totals(),
            "sources": self.sources,
            "error_count": len(self.errors),
            "errors": self.errors[:200],
        }, indent=2, default=str), encoding="utf-8")
        return text_path, json_path
