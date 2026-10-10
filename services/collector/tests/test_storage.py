import json

from models.legal_document import LegalDocument
from storage.file_storage import FileStorage
from storage.jsonl_storage import JsonlStorage


def make_doc(**overrides):
    base = dict(
        source="pakistan_code",
        source_website="https://pakistancode.gov.pk",
        source_url="https://pakistancode.gov.pk/english/x-sg-jjj",
        title="National Archives Act, 1993",
        document_type="act",
        full_text="An Act to provide for the preservation of archival material." * 3,
    )
    base.update(overrides)
    return LegalDocument(**base)


def test_jsonl_round_trip(tmp_path):
    storage = JsonlStorage(tmp_path, "pakistan_code", run_id="test")
    storage.write(make_doc())
    storage.write(make_doc(source_url="https://pakistancode.gov.pk/english/y-sg-jjj"))
    rows = list(JsonlStorage.read(storage.path))
    assert len(rows) == 2
    assert rows[0]["title"] == "National Archives Act, 1993"
    assert storage.count == 2


def test_combined_file_accumulates_across_runs(tmp_path):
    JsonlStorage(tmp_path, "src", run_id="r1").write(make_doc())
    JsonlStorage(tmp_path, "src", run_id="r2").write(make_doc())
    combined = list(JsonlStorage.read(tmp_path / "src.jsonl"))
    assert len(combined) == 2


def test_empty_fields_are_dropped_not_written_as_null(tmp_path):
    storage = JsonlStorage(tmp_path, "src")
    storage.write(make_doc())
    row = next(iter(JsonlStorage.read(storage.path)))
    assert "case_number" not in row  # never provided -> absent
    assert "judges" not in row


def test_sample_export(tmp_path):
    storage = JsonlStorage(tmp_path, "src")
    storage.write(make_doc())
    out = JsonlStorage.export_sample(storage.path, tmp_path / "sample.json", n=5)
    assert json.loads(out.read_text())[0]["source"] == "pakistan_code"


def test_file_storage_paths_include_url_key(tmp_path):
    files = FileStorage(tmp_path / "raw", tmp_path / "text")
    a = files.raw_path("src", "Same Title", "https://x/a.pdf", 1999)
    b = files.raw_path("src", "Same Title", "https://x/b.pdf", 1999)
    assert a != b  # identical titles must not collide
    assert "1999" in str(a)


def test_file_storage_writes_and_reads(tmp_path):
    files = FileStorage(tmp_path / "raw", tmp_path / "text")
    path = files.save_binary(b"%PDF-1.4", "src", "Act", "https://x/a.pdf", 2020)
    assert path.read_bytes() == b"%PDF-1.4"
    assert files.exists("src", "Act", "https://x/a.pdf", 2020)
    text_path = files.save_text("hello", "src", "Act", "https://x/a.pdf", 2020)
    assert text_path.read_text() == "hello"


def test_undated_documents_go_to_an_undated_folder(tmp_path):
    files = FileStorage(tmp_path / "raw", tmp_path / "text")
    assert "undated" in str(files.raw_path("src", "Act", "https://x/a.pdf", None))


def test_validation_flags_missing_pieces():
    doc = LegalDocument(source="s", source_website="https://x", source_url="https://x/a")
    problems = doc.validate()
    assert any("full_text" in p for p in problems)
    assert doc.is_valid is False
    assert make_doc().is_valid is True
