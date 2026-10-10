"""Hashing + content-hash behaviour."""

from models.legal_document import LegalDocument
from utils.hashing import normalise_text, safe_filename, sha256_text, url_key


def test_whitespace_and_case_do_not_change_the_hash():
    a = sha256_text("The  Pakistan   Penal Code,\n1860")
    b = sha256_text("the pakistan penal code, 1860")
    assert a == b


def test_different_text_gives_different_hash():
    assert sha256_text("section 302") != sha256_text("section 303")


def test_normalise_text_collapses_runs():
    assert normalise_text("  a \n\t b  ") == "a b"


def test_url_key_is_stable_and_short():
    url = "https://pakistancode.gov.pk/english/abc-sg-jjj"
    assert url_key(url) == url_key(url)
    assert len(url_key(url)) == 20


def test_safe_filename_strips_path_characters():
    assert "/" not in safe_filename("Civil/Criminal Act, 1908")
    assert safe_filename("   ") == "document"


def test_document_id_is_stable_across_runs():
    kwargs = dict(
        source="pakistan_code",
        source_website="https://pakistancode.gov.pk",
        source_url="https://pakistancode.gov.pk/x",
    )
    assert LegalDocument(**kwargs).id == LegalDocument(**kwargs).id


def test_document_id_differs_per_url():
    base = dict(source="pakistan_code", source_website="https://x")
    one = LegalDocument(source_url="https://x/a", **base)
    two = LegalDocument(source_url="https://x/b", **base)
    assert one.id != two.id


def test_compute_content_hash_returns_none_without_text():
    doc = LegalDocument(source="s", source_website="https://x", source_url="https://x/a")
    assert doc.compute_content_hash() is None
