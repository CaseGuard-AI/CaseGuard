"""Third-party dataset loading.

The point of these tests is the provenance boundary: a record that came from a
Hugging Face dataset must never be able to masquerade as one scraped from an
official source, because a RAG answer citing a gov.pk URL it never fetched is
exactly the failure this project exists to prevent.

These tests do not need the `datasets` package -- they exercise the row ->
document conversion directly.
"""

import pytest

from storage.bootstrap_datasets import (
    DATASETS,
    available,
    compare_coverage,
    to_document,
)


@pytest.fixture
def laws():
    return DATASETS["pakistan_laws"]


@pytest.fixture
def judgments():
    return DATASETS["scp_judgments"]


def test_available_lists_the_registered_datasets():
    assert "pakistan_laws" in available()
    assert "scp_judgments" in available()


# ---- the provenance boundary ----------------------------------------
def test_source_key_is_prefixed_so_it_can_never_collide_with_a_scraper(laws):
    doc = to_document(
        {"file_name": "Constitution_of_Pakistan.pdf", "content": "Whereas sovereignty..."}, laws, 0
    )
    assert doc.source == "hf_pakistan_laws"
    assert doc.source != "pakistan_code"


def test_document_url_is_empty_because_there_is_none(laws):
    doc = to_document({"file_name": "X.pdf", "content": "text"}, laws, 0)
    assert doc.document_url is None
    assert "document_url" not in doc.to_dict()


def test_source_url_points_at_the_dataset_not_a_government_page(laws):
    doc = to_document({"file_name": "X.pdf", "content": "text"}, laws, 0)
    assert doc.source_url == "https://huggingface.co/datasets/AyeshaJadoon/Pakistan_Laws_Dataset"
    assert "gov.pk" not in doc.source_url


def test_records_are_flagged_as_unofficial(laws):
    doc = to_document({"file_name": "X.pdf", "content": "text"}, laws, 3)
    assert doc.raw["is_official_source"] is False
    assert doc.raw["provenance"] == "third_party_dataset"
    assert doc.raw["dataset_row_index"] == 3
    assert any("Verify against the official source" in n for n in doc.notes)


# ---- field mapping ---------------------------------------------------
def test_pdf_filename_becomes_a_readable_title(laws):
    doc = to_document(
        {"file_name": "National_Archives_Act_1993.pdf", "content": "An Act..."}, laws, 0
    )
    assert doc.title == "National Archives Act 1993"
    assert doc.raw["year"] == 1993


def test_document_type_is_guessed_from_the_title(laws):
    ordinance = to_document(
        {"file_name": "National_Accountability_Ordinance_1999.pdf", "content": "x"}, laws, 0
    )
    assert ordinance.document_type == "ordinance"


def test_unguessable_title_falls_back_to_the_dataset_default(laws):
    doc = to_document({"file_name": "misc_document.pdf", "content": "x"}, laws, 0)
    assert doc.document_type == "act"


def test_judgment_dataset_maps_its_own_field_names(judgments):
    doc = to_document(
        {
            "text": "IN THE SUPREME COURT OF PAKISTAN. Relied on 2019 SCMR 984.",
            "citation_number": "2020 SCMR 1",
            "case_details": {"bench": "three members"},
        },
        judgments,
        7,
    )
    assert doc.court == "Supreme Court of Pakistan"
    assert doc.citation == "2020 SCMR 1"
    assert doc.raw["source_metadata"] == {"bench": "three members"}
    assert "2019 SCMR 984" in doc.cited_cases


def test_missing_text_is_recorded_not_faked(laws):
    doc = to_document({"file_name": "X.pdf"}, laws, 0)
    assert doc.full_text is None
    assert doc.extraction_status == "empty"


def test_content_hash_enables_dedup_against_scraped_records(laws):
    a = to_document({"file_name": "A.pdf", "content": "Same statute text here."}, laws, 0)
    b = to_document({"file_name": "B.pdf", "content": "same  STATUTE   text here."}, laws, 1)
    assert a.content_hash == b.content_hash


# ---- coverage comparison --------------------------------------------
def test_coverage_warns_when_your_crawl_is_short(tmp_path):
    from models.legal_document import LegalDocument
    from storage.jsonl_storage import JsonlStorage

    storage = JsonlStorage(tmp_path, "pakistan_code")
    for i in range(10):
        storage.write(
            LegalDocument(
                source="pakistan_code",
                source_website="https://pakistancode.gov.pk",
                source_url=f"https://pakistancode.gov.pk/{i}",
                title=f"Act {i}",
                full_text="x" * 60,
            )
        )
    result = compare_coverage("pakistan_laws", storage.path)
    assert result["own_documents"] == 10
    assert result["dataset_expected_rows"] == 969
    assert "warning" in result
    assert result["coverage_vs_expected"] < 5


def test_coverage_is_quiet_when_the_crawl_looks_complete(tmp_path):
    from models.legal_document import LegalDocument
    from storage.jsonl_storage import JsonlStorage

    storage = JsonlStorage(tmp_path, "pakistan_code")
    for i in range(950):
        storage.write(
            LegalDocument(
                source="pakistan_code",
                source_website="https://pakistancode.gov.pk",
                source_url=f"https://pakistancode.gov.pk/{i}",
                title=f"Act {i}",
                full_text="x" * 60,
            )
        )
    result = compare_coverage("pakistan_laws", storage.path)
    assert "warning" not in result
