"""Reading users' uploaded documents (#253, FR-DOC-2): open, OCR, extract, clean, structure, chunk.

Pure functions, no database: ``ingest/ingestion.py`` runs them as the stages of an attempt and
records each outcome. Everything runs locally (ADR-0008); nothing is sent to a model provider.

- **PDF** through PyMuPDF. A page with no text layer (a scan) needs OCR.
- **DOCX** through python-docx: paragraphs and table rows in document order. No pages.
- **PNG, JPEG, TIFF** are scans: every page (TIFF frame) needs OCR.
- **OCR** uses Tesseract (English, P1) when the optional ``ocr`` extra and the ``tesseract``
  binary are installed. Without them a scanned page is flagged ``unreadable_page`` and the rest
  of the document is still indexed.

Flags (ai.v1 DocumentFlag) are for the user: they say what is uncertain, never how the pipeline
failed, and never include paths or stack traces.
"""

from __future__ import annotations

import io
import re
import unicodedata
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from caseguard_ai.ingest.chunker import Chunk, ChunkerSettings, chunk_document

PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
IMAGE_TYPES = ("image/png", "image/jpeg", "image/tiff")
MEDIA_TYPES = (PDF, DOCX, *IMAGE_TYPES)  # ai.v1 DocumentMediaType
STAGES = ("ocr", "extract", "clean", "structure", "chunk", "embed", "index")  # DocumentStage

# A PDF page with fewer characters than this in its text layer is treated as a scan.
MIN_TEXT_LAYER_CHARS = 20
OCR_DPI = 300
LOW_OCR_CONFIDENCE = 60.0  # Tesseract's mean word confidence (0-100) below which a page is flagged
NOT_ENGLISH_SHARE = 0.3  # share of Arabic-script letters above which a document is flagged


def flag(stage: str, code: str, message: str, page: int | None = None) -> dict[str, Any]:
    """An ai.v1 DocumentFlag."""
    return {"stage": stage, "code": code, "message": message[:500], "page": page}


class DocumentError(Exception):
    """The document cannot be processed. ``message`` is for the user (IngestionStatus.error)."""

    def __init__(
        self,
        stage: str,
        message: str,
        *,
        retryable: bool = False,
        code: str | None = None,
        page: int | None = None,
    ) -> None:
        super().__init__(message)
        self.stage, self.message, self.retryable = stage, message, retryable
        self.flags = [flag(stage, code, message, page)] if code else []


# ── opening ─────────────────────────────────────────────────────────────────────────────────


def sniff(data: bytes) -> str | None:
    """The media type from the file's first bytes, or None if it is none of ours."""
    if data.startswith(b"%PDF-"):
        return PDF
    if data.startswith(b"PK\x03\x04"):
        return DOCX  # a zip; python-docx checks it is a Word document
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "image/tiff"
    return None


@dataclass
class Page:
    """One page: its text layer, or a way to render it for OCR when it has none."""

    number: int | None  # 1-based; None for a DOCX, which has no pages
    text: str = ""
    # Renders the page as PNG bytes when OCR reaches it. Pages are rendered one at a time, so a
    # long scan never holds more than one 300 DPI image in memory.
    render: Callable[[], bytes] | None = None
    needs_ocr: bool = False


@dataclass
class Opened:
    pages: list[Page]
    page_count: int | None  # IngestionStatus.pages; None for a DOCX
    close: Callable[[], None] = lambda: None  # releases the open file once OCR is done

    def __enter__(self) -> Opened:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def open_document(data: bytes, media_type: str) -> Opened:
    """Read the file into pages. Raises DocumentError (stage ``extract``) for a bad file.
    Close the result (it is a context manager): a PDF or image stays open for OCR."""
    found = sniff(data)
    if found != media_type:
        raise DocumentError("extract", "The file is damaged or is not the type it was uploaded as.")
    if media_type == PDF:
        return _open_pdf(data)
    if media_type == DOCX:
        return _open_docx(data)
    return _open_image(data, media_type)


def _open_pdf(data: bytes) -> Opened:
    import pymupdf

    try:
        doc: Any = pymupdf.open(stream=data, filetype="pdf")  # type: ignore[no-untyped-call]
    except Exception as exc:  # PyMuPDF raises its own types for a broken file
        raise DocumentError("extract", "The PDF is damaged and could not be read.") from exc
    try:
        if doc.needs_pass:
            raise DocumentError(
                "extract",
                "The PDF is password-protected. Upload a copy without a password.",
                code="encrypted_file",
            )

        def renderer(index: int) -> Callable[[], bytes]:
            return lambda: bytes(doc[index].get_pixmap(dpi=OCR_DPI).tobytes("png"))

        pages: list[Page] = []
        for index, page in enumerate(doc):
            text = page.get_text("text") or ""
            if len(text.strip()) >= MIN_TEXT_LAYER_CHARS:
                pages.append(Page(index + 1, text))
            else:
                pages.append(Page(index + 1, text, renderer(index), needs_ocr=True))
    except BaseException:
        doc.close()
        raise
    return Opened(pages, len(pages), doc.close)


def _open_docx(data: bytes) -> Opened:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    try:
        document: Any = Document(io.BytesIO(data))
    except Exception as exc:  # a zip that is not a Word document, or a broken one
        raise DocumentError("extract", "The Word file is damaged and could not be read.") from exc
    lines: list[str] = []
    for element in document.element.body.iterchildren():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "p":
            lines.append(Paragraph(element, document).text)
        elif tag == "tbl":
            for row in Table(element, document).rows:
                # A merged cell repeats in every column it spans, as the same <w:tc> element;
                # keep it once. Two cells that merely hold the same text are both kept.
                seen: set[int] = set()
                texts: list[str] = []
                for cell in row.cells:
                    if id(cell._tc) in seen:
                        continue
                    seen.add(id(cell._tc))
                    if cell.text.strip():
                        texts.append(cell.text.strip())
                if texts:
                    lines.append(" | ".join(texts))
            lines.append("")
    return Opened([Page(None, "\n".join(lines))], None)


def _open_image(data: bytes, media_type: str) -> Opened:
    if not ocr_available():
        return Opened([Page(1, needs_ocr=True)], 1)
    from PIL import Image

    try:
        image = Image.open(io.BytesIO(data))
        frames = int(getattr(image, "n_frames", 1))
    except Exception as exc:  # Pillow raises many types for a broken image
        raise DocumentError("extract", "The image is damaged and could not be read.") from exc

    def renderer(index: int) -> Callable[[], bytes]:
        def render() -> bytes:
            image.seek(index)  # one TIFF frame at a time
            out = io.BytesIO()
            image.convert("RGB").save(out, format="PNG")
            return out.getvalue()

        return render

    pages = [Page(i + 1, render=renderer(i), needs_ocr=True) for i in range(frames)]
    return Opened(pages, frames, image.close)


# ── OCR ─────────────────────────────────────────────────────────────────────────────────────


@lru_cache(maxsize=1)
def ocr_available() -> bool:
    """True when pytesseract, Pillow and the tesseract binary are all installed (checked once)."""
    try:
        import pytesseract

        pytesseract.get_tesseract_version()
    except Exception:  # not installed, or no binary on PATH
        return False
    return True


def ocr_page(image: bytes) -> tuple[str, float]:
    """(text, mean word confidence 0-100) of one page image, English only (P1)."""
    import pytesseract
    from PIL import Image

    data = pytesseract.image_to_data(
        Image.open(io.BytesIO(image)), lang="eng", output_type=pytesseract.Output.DICT
    )
    lines: dict[tuple[int, int, int], list[str]] = {}
    confidences: list[float] = []
    for i, word in enumerate(data["text"]):
        conf = float(data["conf"][i])
        if not word.strip() or conf < 0:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        lines.setdefault(key, []).append(word)
        confidences.append(conf)
    text, last_par = [], None
    for (block, par, _), words in lines.items():
        if last_par is not None and (block, par) != last_par:
            text.append("")  # a blank line between paragraphs, as the chunker expects
        text.append(" ".join(words))
        last_par = (block, par)
    mean = sum(confidences) / len(confidences) if confidences else 0.0
    return "\n".join(text), mean


def run_ocr(
    opened: Opened, check: Callable[[], None] = lambda: None
) -> tuple[str, list[dict[str, Any]]]:
    """OCR every page that needs it, rendering one page at a time. ``check`` runs before each
    page and raises to stop (a newer attempt, a purge, or shutdown). Returns the stage state
    and its flags."""
    needed = [p for p in opened.pages if p.needs_ocr]
    if not needed:
        return "skipped", []
    flags: list[dict[str, Any]] = []
    available = ocr_available()
    for page in needed:
        if not available or page.render is None:
            flags.append(
                flag(
                    "ocr",
                    "unreadable_page",
                    _page_phrase(page.number, "is a scanned image")
                    + " and could not be read, so its text is not searchable.",
                    page.number,
                )
            )
            continue
        check()
        image = page.render()
        text, confidence = ocr_page(image)
        del image  # freed before the next page is rendered
        page.text = text
        if not text.strip():
            flags.append(
                flag(
                    "ocr",
                    "unreadable_page",
                    _page_phrase(page.number, "could not be read") + ".",
                    page.number,
                )
            )
        elif confidence < LOW_OCR_CONFIDENCE:
            flags.append(
                flag(
                    "ocr",
                    "low_ocr_confidence",
                    _page_phrase(page.number, "was hard to read")
                    + "; check the text against the original.",
                    page.number,
                )
            )
    return ("flagged" if flags else "done"), flags


def _page_phrase(number: int | None, rest: str) -> str:
    return f"Page {number} {rest}" if number else f"The document {rest}"


# ── extract and clean ───────────────────────────────────────────────────────────────────────


@dataclass
class Text:
    """The document's text, page by page (one entry for a DOCX)."""

    pages: list[tuple[int | None, str]]
    flags: list[dict[str, Any]] = field(default_factory=list)

    @property
    def full(self) -> str:
        return "\n\n".join(t for _, t in self.pages if t)


def extract(opened: Opened) -> Text:
    text = Text([(p.number, p.text) for p in opened.pages])
    if not any(t.strip() for _, t in text.pages):
        scanned = any(p.needs_ocr for p in opened.pages)
        raise DocumentError(
            "extract",
            "No text could be read from this document."
            + (
                " It looks like a scan, and text recognition is off."
                if scanned and not ocr_available()
                else ""
            ),
            code="no_text",
        )
    return text


_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​﻿]")
# A word broken across lines: lower-case on both sides ("ar-\nrested") is joined without the
# hyphen. Anything else ("2019-\n2020", "Anti-\nTerrorism") keeps the hyphen and loses only the
# line break. "self-\nemployed" can't be told from "ar-\nrested" by its letters, so it joins.
_SOFT_HYPHEN_BREAK = re.compile(r"(?<=[a-z])-\n(?=[a-z])")
_HARD_HYPHEN_BREAK = re.compile(r"(?<=\w)-\n(?=\w)")
_SPACES = re.compile(r"[ \t ]+")
_BLANKS = re.compile(r"\n{3,}")
_DIGITS = re.compile(r"\d+")


def _furniture(pages: list[str]) -> set[str]:
    """First or last lines repeated on most pages (running headers, footers, page numbers),
    compared with their digits removed. Needs at least three pages to tell."""
    if len(pages) < 3:
        return set()
    counts: Counter[str] = Counter()
    for page in pages:
        lines = [_SPACES.sub(" ", line).strip() for line in page.split("\n") if line.strip()]
        edge = {_DIGITS.sub("#", line) for line in lines[:1] + lines[-1:]}
        counts.update(edge)
    return {line for line, n in counts.items() if n >= max(3, len(pages) // 2 + 1)}


def clean(text: Text, max_chars: int) -> Text:
    """Normalise characters and whitespace, join words hyphenated across lines, drop running
    headers and footers, and cut an over-long text (flagged ``truncated``)."""
    pages = [
        _CONTROL.sub("", unicodedata.normalize("NFKC", t)).replace("\r", "") for _, t in text.pages
    ]
    furniture = _furniture(pages)
    cleaned: list[tuple[int | None, str]] = []
    total = 0
    flags: list[dict[str, Any]] = []
    for (number, _), page in zip(text.pages, pages, strict=True):
        lines = [_SPACES.sub(" ", line).strip() for line in page.split("\n")]
        # Furniture only ever sits at a page's edges: a bare "12" mid-page is a paragraph number.
        filled = [i for i, line in enumerate(lines) if line]
        drop = {i for i in filled[:1] + filled[-1:] if _DIGITS.sub("#", lines[i]) in furniture}
        joined = "\n".join(line for i, line in enumerate(lines) if i not in drop)
        joined = _HARD_HYPHEN_BREAK.sub("-", _SOFT_HYPHEN_BREAK.sub("", joined))
        body = _BLANKS.sub("\n\n", joined).strip()
        if total + len(body) > max_chars:
            body = body[: max(0, max_chars - total)]
            flags.append(
                flag(
                    "clean",
                    "truncated",
                    "The document is very long; only its first part is searchable.",
                    number,
                )
            )
            cleaned.append((number, body))
            break
        total += len(body)
        cleaned.append((number, body))
    return Text(cleaned, flags)


# ── structure and chunk ─────────────────────────────────────────────────────────────────────

_ARABIC = re.compile(r"[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]")
_LETTER = re.compile(r"[^\W\d_]")


def structure(text: Text) -> list[dict[str, Any]]:
    """Checks on the whole text before chunking. P1 handles English only (FR-DOC-2), so a mostly
    Urdu document is flagged, though it is still indexed."""
    full = text.full
    letters = len(_LETTER.findall(full))
    if letters and len(_ARABIC.findall(full)) / letters > NOT_ENGLISH_SHARE:
        return [
            flag(
                "structure",
                "not_english",
                "Much of this document is not in English; search and answers may miss parts of it.",
            )
        ]
    return []


def _flat(text: str) -> str:
    return " ".join(text.split())


def _page_locator(first: int | None, last: int | None) -> str | None:
    if first is None:
        return None
    if last is None or last == first:
        return f"p. {first}"
    return f"pp. {first}-{last}"


def chunk(text: Text, title: str, settings: ChunkerSettings | None = None) -> list[Chunk]:
    """Paragraph windows (the chunker's judgment path), each located by page and paragraph,
    e.g. "p. 3, para 4" or "pp. 3-4". A user's file is rarely a statute, and a statute's
    sections would be found anyway: chunk_document falls back to paragraphs."""
    pieces = chunk_document(
        kind="other", title=title, full_text=text.full, headnote_only=False, settings=settings
    )
    numbered = [(n, _flat(t)) for n, t in text.pages if t]
    flat = " ".join(t for _, t in numbered)
    starts: list[tuple[int, int | None]] = []
    offset = 0
    for number, page in numbered:
        starts.append((offset, number))
        offset += len(page) + 1

    def page_at(position: int) -> int | None:
        found: int | None = None
        for start, number in starts:
            if start > position:
                break
            found = number
        return found

    out: list[Chunk] = []
    cursor = 0
    for piece in pieces:
        body = _flat(piece.text)
        head, tail = body[:60], body[-60:]
        # Only forward from the last chunk: searching from the start again could match an
        # earlier repeat of the same text and give the wrong page. Not found = no page locator.
        begin = flat.find(head, cursor)
        pages: tuple[int | None, int | None] = (None, None)
        if begin >= 0:
            end = flat.find(tail, begin)
            end = end + len(tail) - 1 if end >= 0 else begin
            pages = (page_at(begin), page_at(end))
            cursor = begin + 1
        parts = [p for p in (_page_locator(*pages), piece.locator) if p]
        locator = ", ".join(parts) or None
        out.append(Chunk(piece.ordinal, piece.text, piece.token_count, locator, piece.section_id))
    return out
