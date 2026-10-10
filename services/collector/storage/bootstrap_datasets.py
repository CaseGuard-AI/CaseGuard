"""Bootstrap corpora from third-party datasets (Hugging Face).

Why this is a separate module and not a scraper
-----------------------------------------------
These datasets are genuinely useful to an FYP:

  * **bootstrap** -- you can start building the chunker, embeddings and
    retriever today instead of waiting for a full crawl
  * **validation** -- if your own Pakistan Code run yields far fewer than ~969
    statutes, your discovery loop is broken. That is a real, cheap test.
  * **comparison** -- a baseline to measure your own extraction quality against

But they are **not** official sources. They carry no per-document source URL,
so a RAG answer built on them cannot cite anything, which is the one thing this
whole project exists to guarantee.

So every record loaded here:
  * gets a `source` key prefixed `hf_` -- never `pakistan_code` or a court key
  * has `source_url` set to the dataset page, not a government page
  * has `document_url` left EMPTY, because there isn't one
  * carries `is_official_source: false` and `provenance: third_party_dataset`
    in `raw`, plus a note saying it was not retrieved from the issuing authority

Keep that distinction all the way into your vector store. If a retrieved chunk
came from here, the answer must say "from a third-party dataset, verify against
the Pakistan Code" rather than citing a gov.pk URL it never saw.

Usage
-----
    pip install datasets
    python main.py --bootstrap pakistan_laws --limit 50
    python main.py --bootstrap scp_judgments
    python main.py --bootstrap-compare pakistan_laws     # coverage check
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

from extractors.metadata_extractor import (
    extract_citations,
    extract_document_number,
    guess_document_type,
)
from models.legal_document import ExtractionStatus, LegalDocument
from utils.dates import extract_year
from utils.logging_config import get_logger

log = get_logger("bootstrap")


@dataclass(frozen=True)
class BootstrapDataset:
    key: str
    repo_id: str
    description: str
    document_type: str
    court: str | None = None
    expected_rows: int | None = None
    split: str = "train"

    @property
    def source_key(self) -> str:
        return f"hf_{self.key}"

    @property
    def url(self) -> str:
        return f"https://huggingface.co/datasets/{self.repo_id}"


DATASETS: dict[str, BootstrapDataset] = {
    "pakistan_laws": BootstrapDataset(
        key="pakistan_laws",
        repo_id="AyeshaJadoon/Pakistan_Laws_Dataset",
        description=(
            "~969 federal laws and acts, originally PDFs from the "
            "Ministry of Law & Justice (Pakistan Code), converted to "
            "JSON with file_name + content."
        ),
        document_type="act",
        expected_rows=969,
    ),
    "pakistan_laws_mirror": BootstrapDataset(
        key="pakistan_laws_mirror",
        repo_id="MUHAMMADABDULLAHML/Pakistan_Laws_Dataset",
        description="Explicit duplicate of AyeshaJadoon/Pakistan_Laws_Dataset.",
        document_type="act",
        expected_rows=969,
    ),
    "scp_judgments": BootstrapDataset(
        key="scp_judgments",
        repo_id="Ibtehaj10/supreme-court-of-pak-judgments",
        description=(
            "1,414 Supreme Court of Pakistan judgments with text, "
            "case_details, citation_number and precomputed embeddings."
        ),
        document_type="judgment",
        court="Supreme Court of Pakistan",
        expected_rows=1414,
    ),
    "legal_uqa": BootstrapDataset(
        key="legal_uqa",
        repo_id="nlp-anonymous-researcher/LEGAL-UQA",
        description="English + Urdu legal Q&A pairs over Pakistani law.",
        document_type="unknown",
    ),
}

# Field names these datasets use, in preference order.
TEXT_FIELDS = ("content", "text", "full_text", "judgment", "body", "answer")
TITLE_FIELDS = ("file_name", "title", "case_title", "name", "question")
CITATION_FIELDS = ("citation_number", "citation", "citations")
META_FIELDS = ("case_details", "metadata", "details", "source_text")


def available() -> list[str]:
    return sorted(DATASETS)


def _first(row: dict, fields: tuple[str, ...]) -> Any:
    for field in fields:
        value = row.get(field)
        if value not in (None, "", [], {}):
            return value
    return None


def load_rows(dataset: BootstrapDataset, limit: int | None = None) -> Iterator[dict]:
    try:
        from datasets import load_dataset
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "The `datasets` package is required for bootstrap loading:\n    pip install datasets"
        ) from exc

    log.info("Loading %s (%s split)", dataset.repo_id, dataset.split)
    data = load_dataset(dataset.repo_id, split=dataset.split)
    for index, row in enumerate(data):
        if limit is not None and index >= limit:
            return
        yield dict(row)


def to_document(row: dict, dataset: BootstrapDataset, index: int) -> LegalDocument:
    """Convert one dataset row into a clearly-labelled third-party record."""
    title = _first(row, TITLE_FIELDS)
    if isinstance(title, str) and title.lower().endswith(".pdf"):
        title = title[:-4].replace("_", " ").strip()
    text = _first(row, TEXT_FIELDS)

    document = LegalDocument(
        source=dataset.source_key,
        source_website="https://huggingface.co",
        # Points at the dataset, NOT at any gov.pk page -- we never saw one.
        source_url=dataset.url,
        document_url=None,
        title=str(title) if title else f"{dataset.repo_id} row {index}",
        document_type=(guess_document_type(str(title) if title else None) or dataset.document_type),
        court=dataset.court,
        jurisdiction="Pakistan",
        full_text=str(text) if text else None,
        language="en",
        extraction_status=(ExtractionStatus.OK.value if text else ExtractionStatus.EMPTY.value),
    )
    if document.document_type == "unknown":
        document.document_type = dataset.document_type

    if title:
        document.document_number = extract_document_number(str(title))
        year = extract_year(str(title))
        if year:
            document.raw["year"] = year

    citation = _first(row, CITATION_FIELDS)
    if citation:
        document.citation = str(citation)[:255]
    details = _first(row, META_FIELDS)
    if details:
        document.raw["source_metadata"] = details
    if document.full_text:
        document.cited_cases = extract_citations(document.full_text)

    # The provenance flags that must survive into the vector store.
    document.raw.update(
        {
            "provenance": "third_party_dataset",
            "is_official_source": False,
            "dataset_repo": dataset.repo_id,
            "dataset_row_index": index,
        }
    )
    document.notes.append(
        "Third-party dataset record. NOT retrieved from the issuing authority "
        "and carries no original document URL. Verify against the official "
        "source before citing it in an answer."
    )
    document.compute_content_hash()
    return document


# ----------------------------------------------------------------------
def ingest(
    dataset_key: str,
    storage_factory: Callable[[str], Any],
    state,
    limit: int | None = None,
    dry_run: bool = False,
) -> dict[str, int]:
    """Load a dataset into its own JSONL file under an `hf_` source key."""
    dataset = DATASETS[dataset_key]
    storage = storage_factory(dataset.source_key)
    stats = {"rows": 0, "stored": 0, "duplicates": 0, "empty": 0}

    for index, row in enumerate(load_rows(dataset, limit)):
        stats["rows"] += 1
        document = to_document(row, dataset, index)
        if not document.full_text:
            stats["empty"] += 1
        duplicate = state.duplicate_of(document.content_hash)
        if duplicate and duplicate["document_id"] != document.id:
            stats["duplicates"] += 1
            continue
        if dry_run:
            continue
        storage.write(document)
        state.register_hash(
            document.content_hash, document.id, dataset.source_key, document.source_url
        )
        state.mark_seen(
            f"{dataset.url}#row={index}",
            dataset.source_key,
            document_id=document.id,
            content_hash=document.content_hash,
        )
        stats["stored"] += 1

    log.info("%s: %s", dataset.repo_id, stats)
    return stats


def compare_coverage(dataset_key: str, own_jsonl_path) -> dict[str, Any]:
    """Validation use: how does your own crawl compare with the dataset?

    A big shortfall usually means the discovery loop is missing index pages,
    not that the corpus is genuinely smaller.
    """
    from storage.jsonl_storage import JsonlStorage

    dataset = DATASETS[dataset_key]
    own_titles: set[str] = set()
    own_count = 0
    for row in JsonlStorage.read(own_jsonl_path):
        own_count += 1
        title = (row.get("title") or "").strip().lower()
        if title:
            own_titles.add(_canonical(title))

    result: dict[str, Any] = {
        "dataset": dataset.repo_id,
        "dataset_expected_rows": dataset.expected_rows,
        "own_documents": own_count,
        "own_unique_titles": len(own_titles),
    }
    if dataset.expected_rows:
        result["coverage_vs_expected"] = round(100.0 * own_count / dataset.expected_rows, 1)
        if own_count < dataset.expected_rows * 0.8:
            result["warning"] = (
                f"Your crawl has {own_count} documents against roughly "
                f"{dataset.expected_rows} in {dataset.repo_id}. Check that "
                "discovery is walking every index page before you treat the "
                "corpus as complete."
            )
    return result


def _canonical(title: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "", title.lower())
