"""PDF text extraction.

Rules the pipeline depends on:
  * a PDF whose text extraction fails is NEVER silently dropped -- it is
    persisted with extraction_status=failed and the error text, so it can be
    re-processed later (e.g. once OCR is switched on).
  * we distinguish "born-digital but empty" from "scanned image" so you can
    decide whether OCR is worth running.
  * OCR is optional and off by default; it needs system binaries that a
    university lab machine may not have.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from models.legal_document import ExtractionStatus
from utils.logging_config import get_logger

log = get_logger("pdf")

# Below this many characters per page we assume the page carries no real text.
MIN_CHARS_PER_PAGE = 40


@dataclass
class PdfExtraction:
    text: str = ""
    page_count: int | None = None
    status: str = ExtractionStatus.NOT_ATTEMPTED.value
    error: str | None = None
    engine: str | None = None
    is_scanned: bool = False
    chars_per_page: float = 0.0
    metadata: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == ExtractionStatus.OK.value


def extract_pdf(path: str | Path, *, ocr: bool = False,
                ocr_language: str = "eng") -> PdfExtraction:
    """Try PyMuPDF, then pdfplumber, then (optionally) OCR."""
    path = Path(path)
    if not path.exists():
        return PdfExtraction(status=ExtractionStatus.FAILED.value,
                             error=f"file not found: {path}")

    result = _extract_pymupdf(path)
    if not result.ok:
        fallback = _extract_pdfplumber(path)
        if fallback.ok or result.status == ExtractionStatus.FAILED.value:
            # keep the better outcome
            if fallback.ok or not result.text:
                result = fallback

    if result.is_scanned and ocr:
        ocr_result = _extract_ocr(path, ocr_language)
        if ocr_result.ok:
            ocr_result.metadata = result.metadata
            return ocr_result
        result.error = (result.error or "") + f" | OCR failed: {ocr_result.error}"

    if result.is_scanned and not ocr:
        result.status = ExtractionStatus.SCANNED_NO_OCR.value
        result.error = result.error or (
            "PDF appears to be a scan; enable --ocr (needs tesseract) to read it"
        )
    return result


# ----------------------------------------------------------------------
def _finalise(text: str, pages: int, engine: str,
              metadata: dict | None = None) -> PdfExtraction:
    text = _tidy(text)
    per_page = (len(text) / pages) if pages else 0.0
    scanned = pages > 0 and per_page < MIN_CHARS_PER_PAGE
    if not text.strip():
        status = ExtractionStatus.EMPTY.value
    elif scanned:
        status = ExtractionStatus.EMPTY.value
    else:
        status = ExtractionStatus.OK.value
    return PdfExtraction(
        text=text, page_count=pages, status=status, engine=engine,
        is_scanned=scanned, chars_per_page=round(per_page, 1),
        metadata=metadata or {},
    )


def _extract_pymupdf(path: Path) -> PdfExtraction:
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return PdfExtraction(status=ExtractionStatus.FAILED.value,
                             error="PyMuPDF not installed", engine="pymupdf")
    try:
        with fitz.open(path) as doc:
            if doc.needs_pass:
                return PdfExtraction(status=ExtractionStatus.FAILED.value,
                                     error="PDF is password protected",
                                     engine="pymupdf")
            pages = doc.page_count
            meta = {k: v for k, v in (doc.metadata or {}).items() if v}
            chunks = [page.get_text("text") or "" for page in doc]
        return _finalise("\n".join(chunks), pages, "pymupdf", meta)
    except Exception as exc:                            # noqa: BLE001
        log.debug("PyMuPDF failed on %s: %s", path.name, exc)
        return PdfExtraction(status=ExtractionStatus.FAILED.value,
                             error=f"pymupdf: {exc}", engine="pymupdf")


def _extract_pdfplumber(path: Path) -> PdfExtraction:
    try:
        import pdfplumber
    except ImportError:
        return PdfExtraction(status=ExtractionStatus.FAILED.value,
                             error="pdfplumber not installed", engine="pdfplumber")
    try:
        chunks: list[str] = []
        with pdfplumber.open(str(path)) as pdf:
            pages = len(pdf.pages)
            meta = {k: str(v) for k, v in (pdf.metadata or {}).items() if v}
            for page in pdf.pages:
                chunks.append(page.extract_text() or "")
        return _finalise("\n".join(chunks), pages, "pdfplumber", meta)
    except Exception as exc:                            # noqa: BLE001
        return PdfExtraction(status=ExtractionStatus.FAILED.value,
                             error=f"pdfplumber: {exc}", engine="pdfplumber")


def _extract_ocr(path: Path, language: str) -> PdfExtraction:
    """Rasterise then OCR. Requires `pytesseract` + the tesseract binary."""
    try:
        import fitz
        import pytesseract
        from PIL import Image
    except ImportError as exc:
        return PdfExtraction(status=ExtractionStatus.FAILED.value,
                             error=f"OCR dependencies missing: {exc}", engine="ocr")
    try:
        import io
        chunks: list[str] = []
        with fitz.open(path) as doc:
            pages = doc.page_count
            for page in doc:
                pix = page.get_pixmap(dpi=300)
                image = Image.open(io.BytesIO(pix.tobytes("png")))
                chunks.append(pytesseract.image_to_string(image, lang=language))
        result = _finalise("\n".join(chunks), pages, "ocr")
        result.is_scanned = True
        if result.text.strip():
            result.status = ExtractionStatus.OK.value
        return result
    except Exception as exc:                            # noqa: BLE001
        return PdfExtraction(status=ExtractionStatus.FAILED.value,
                             error=f"ocr: {exc}", engine="ocr")


def _tidy(text: str) -> str:
    import re
    text = (text or "").replace("\x00", "").replace("\ufeff", "")
    text = re.sub(r"[ \t\xa0]+", " ", text)
    text = re.sub(r"-\n(?=[a-z])", "", text)      # de-hyphenate line breaks
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def looks_like_pdf(data: bytes) -> bool:
    return data[:5] == b"%PDF-"
