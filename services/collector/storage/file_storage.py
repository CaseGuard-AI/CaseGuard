"""Where original PDFs and extracted text land on disk.

Layout:
    data/raw/<source>/<yyyy>/<slug>_<urlkey>.pdf     original bytes, untouched
    data/text/<source>/<yyyy>/<slug>_<urlkey>.txt    extracted text

The URL key in the filename means a file can always be traced back to the
exact URL it came from, and two documents with the same title never collide.
"""

from __future__ import annotations

from pathlib import Path

from utils.hashing import safe_filename, url_key


class FileStorage:
    def __init__(self, raw_dir: str | Path, text_dir: str | Path) -> None:
        self.raw_dir = Path(raw_dir)
        self.text_dir = Path(text_dir)

    # -----------------------------------------------------------------
    def _target(self, base: Path, source: str, name: str, url: str,
                year: int | str | None, extension: str) -> Path:
        folder = base / source / (str(year) if year else "undated")
        folder.mkdir(parents=True, exist_ok=True)
        stem = f"{safe_filename(name)[:90]}_{url_key(url)}"
        return folder / f"{stem}{extension}"

    def raw_path(self, source: str, name: str, url: str,
                 year: int | str | None = None, extension: str = ".pdf") -> Path:
        return self._target(self.raw_dir, source, name, url, year, extension)

    def text_path(self, source: str, name: str, url: str,
                  year: int | str | None = None) -> Path:
        return self._target(self.text_dir, source, name, url, year, ".txt")

    # -----------------------------------------------------------------
    def save_binary(self, data: bytes, source: str, name: str, url: str,
                    year: int | str | None = None,
                    extension: str = ".pdf") -> Path:
        path = self.raw_path(source, name, url, year, extension)
        if not path.exists() or path.stat().st_size != len(data):
            path.write_bytes(data)
        return path

    def save_text(self, text: str, source: str, name: str, url: str,
                  year: int | str | None = None) -> Path:
        path = self.text_path(source, name, url, year)
        path.write_text(text or "", encoding="utf-8")
        return path

    def exists(self, source: str, name: str, url: str,
               year: int | str | None = None, extension: str = ".pdf") -> bool:
        return self.raw_path(source, name, url, year, extension).exists()
