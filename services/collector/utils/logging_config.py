"""Logging: human-readable console + rotating file + a machine-readable JSONL
event log that the validation report reads back."""

from __future__ import annotations

import json
import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path
from datetime import datetime, timezone

_CONFIGURED = False


class JsonlEventLogger:
    """Append-only structured event log (one JSON object per line)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, event: str, **fields) -> None:
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "event": event,
            **fields,
        }
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")

    def read(self) -> list[dict]:
        if not self.path.exists():
            return []
        out = []
        with self.path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        return out


def setup_logging(log_dir: Path, level: str = "INFO", run_id: str = "") -> logging.Logger:
    global _CONFIGURED
    log_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger("pklegal")
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    if not _CONFIGURED:
        fmt = logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%H:%M:%S"
        )
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(fmt)
        root.addHandler(console)

        file_handler = RotatingFileHandler(
            log_dir / "scraper.log", maxBytes=10 * 1024 * 1024,
            backupCount=5, encoding="utf-8",
        )
        file_handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
        ))
        root.addHandler(file_handler)

        # third-party noise
        for noisy in ("httpx", "httpcore", "urllib3", "pdfminer"):
            logging.getLogger(noisy).setLevel(logging.WARNING)
        _CONFIGURED = True

    if run_id:
        root.info("run_id=%s", run_id)
    return root


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"pklegal.{name}")
