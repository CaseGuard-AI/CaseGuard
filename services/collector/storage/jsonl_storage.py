"""JSONL output: one file per source per run, plus a stable combined file.

JSONL is the right first target -- streamable, appendable, diff-able, and
trivially loadable into pandas / HuggingFace datasets / a Postgres COPY later.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator
from datetime import date
from pathlib import Path

from models.legal_document import LegalDocument


class JsonlStorage:
    def __init__(
        self, directory: str | Path, source: str, run_id: str = "", drop_empty_fields: bool = True
    ) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.source = source
        self.drop_empty_fields = drop_empty_fields
        stamp = date.today().isoformat()
        suffix = f"_{run_id}" if run_id else ""
        self.path = self.directory / f"{source}_{stamp}{suffix}.jsonl"
        self.combined_path = self.directory / f"{source}.jsonl"
        self._count = 0

    def write(self, document: LegalDocument) -> None:
        payload = json.dumps(
            document.to_dict(drop_empty=self.drop_empty_fields),
            ensure_ascii=False,
            default=str,
        )
        for path in (self.path, self.combined_path):
            with path.open("a", encoding="utf-8") as fh:
                fh.write(payload + "\n")
        self._count += 1

    def write_many(self, documents: Iterable[LegalDocument]) -> int:
        for document in documents:
            self.write(document)
        return self._count

    @property
    def count(self) -> int:
        return self._count

    # ---- reading back -------------------------------------------------
    @staticmethod
    def read(path: str | Path) -> Iterator[dict]:
        path = Path(path)
        if not path.exists():
            return
        with path.open(encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"{path}:{line_no} is not valid JSON: {exc}") from exc

    @staticmethod
    def export_sample(path: str | Path, out_path: str | Path, n: int = 5) -> Path:
        """Pretty-printed sample, handy for the FYP report appendix."""
        rows = []
        for i, row in enumerate(JsonlStorage.read(path)):
            if i >= n:
                break
            rows.append(row)
        out = Path(out_path)
        out.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
        return out
