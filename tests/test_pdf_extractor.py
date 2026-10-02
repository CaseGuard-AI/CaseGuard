"""PDF extraction, including the failure paths that must never be silent."""

import pytest

from extractors.pdf_extractor import extract_pdf, looks_like_pdf
from models.legal_document import ExtractionStatus

fitz = pytest.importorskip("fitz", reason="PyMuPDF not installed")


@pytest.fixture
def text_pdf(tmp_path):
    path = tmp_path / "statute.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), "THE NATIONAL ARCHIVES ACT, 1993")
    page.insert_text((72, 130), "1. Short title, extent and commencement.")
    page.insert_text((72, 160), "It extends to the whole of Pakistan.")
    doc.save(path)
    doc.close()
    return path


@pytest.fixture
def blank_pdf(tmp_path):
    path = tmp_path / "scan.pdf"
    doc = fitz.open()
    doc.new_page()
    doc.new_page()
    doc.save(path)
    doc.close()
    return path


def test_text_pdf_extracts(text_pdf):
    result = extract_pdf(text_pdf)
    assert result.ok
    assert "NATIONAL ARCHIVES ACT" in result.text
    assert result.page_count == 1
    assert result.engine in {"pymupdf", "pdfplumber"}


def test_blank_pdf_is_flagged_as_scanned_not_ok(blank_pdf):
    result = extract_pdf(blank_pdf, ocr=False)
    assert result.is_scanned is True
    assert result.status == ExtractionStatus.SCANNED_NO_OCR.value
    assert result.error                      # a reason is always recorded
    assert not result.ok


def test_missing_file_fails_loudly(tmp_path):
    result = extract_pdf(tmp_path / "nope.pdf")
    assert result.status == ExtractionStatus.FAILED.value
    assert "not found" in result.error


def test_corrupt_file_is_reported_not_swallowed(tmp_path):
    path = tmp_path / "broken.pdf"
    path.write_bytes(b"%PDF-1.4 this is not really a pdf")
    result = extract_pdf(path)
    assert result.status == ExtractionStatus.FAILED.value
    assert result.error


def test_looks_like_pdf():
    assert looks_like_pdf(b"%PDF-1.7 ...") is True
    assert looks_like_pdf(b"<!DOCTYPE html>") is False
