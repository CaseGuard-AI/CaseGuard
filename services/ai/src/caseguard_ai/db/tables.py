"""Table definitions for the schemas services/ai owns: ``corpus`` and ``ai`` (ADR-0002).

The Alembic migrations in ``services/ai/migrations`` create these tables. This module is the
SQLAlchemy Core view of them for the loader, ingestion and retrieval. ``tests/test_migrations.py``
checks that the two never drift apart.

- ``corpus`` is the shared, public legal corpus. It is what a corpus dump contains (#154).
- ``ai`` is private to each machine: answer traces, citations and the trust store, and the
  chunks of users' case files (#145). It is never dumped or shared.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    Computed,
    Date,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    SmallInteger,
    Table,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TSVECTOR, UUID
from sqlalchemy.types import TIMESTAMP

EMBEDDING_DIMS = 1024  # bge-m3 (PRD §8.2)
FTS_CONFIG = "english"  # M1 questions are English; recorded in corpus_meta (#154)

STATUSES = ("verified", "needs_review", "unverified")  # PRD §7.2
FLAGS = (
    # blocking
    "overruled",
    "repealed",
    "superseded_version",
    "conflict",
    # non-blocking
    "stale",
    "third_party_source",
    "headnote_only",
    "amended_since",
)
DOCUMENT_KINDS = ("statute", "judgment", "rule", "other")  # ai.v1 Source.kind

metadata = MetaData()


def _id() -> Column[uuid.UUID]:
    return Column(
        "id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )


def _now() -> Column[datetime]:
    return Column(
        "created_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
    )


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _tsv() -> Column[Any]:
    return Column(
        "tsv",
        TSVECTOR,
        Computed(f"to_tsvector('{FTS_CONFIG}'::regconfig, text)", persisted=True),
        nullable=False,
    )


# ── corpus ──────────────────────────────────────────────────────────────────────────────────

documents = Table(
    "documents",
    metadata,
    # The ai.v1 Source.id. The collector's own id stays unique alongside it.
    _id(),
    Column("collector_id", Text, nullable=False, unique=True),
    Column("source_key", Text, nullable=False),
    Column("kind", Text, nullable=False),
    Column("title", Text, nullable=False),
    Column("citation", Text),
    Column("case_number", Text),
    Column("court", Text),
    Column("matter_type", Text),
    Column("decided_on", Date),
    Column("language", Text, nullable=False, server_default=text("'en'")),
    # Provenance (NFR-1): every record traces to a real source URL.
    Column("official_url", Text, nullable=False),
    Column("document_file_url", Text),
    Column("retrieved_at", TIMESTAMP(timezone=True)),
    Column("source_tier", SmallInteger, nullable=False, server_default=text("1")),
    Column("third_party", Boolean, nullable=False, server_default=text("false")),
    Column("headnote_only", Boolean, nullable=False, server_default=text("false")),
    Column("snapshot", Text),  # "<partition>@<date>" it was loaded from (#152)
    Column("extraction_status", Text),
    Column("full_text", Text, nullable=False),
    Column("summary", Text),
    Column("content_hash", Text, nullable=False, unique=True),
    # Case taxonomy, filled once the supervisor agrees the labels (handoff §3).
    Column("area", Text),
    Column("subcategory", Text),
    Column("proceeding_type", Text),
    Column("raw", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    _now(),
    Column("updated_at", TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")),
    CheckConstraint(_in("kind", DOCUMENT_KINDS), name="documents_kind_check"),
    CheckConstraint("source_tier IN (1, 2)", name="documents_source_tier_check"),
    Index("documents_source_key_idx", "source_key"),
    schema="corpus",
)

chunks = Table(
    "chunks",
    metadata,
    _id(),
    Column(
        "document_id",
        UUID(as_uuid=True),
        ForeignKey("corpus.documents.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("ordinal", Integer, nullable=False),
    Column("locator", Text),  # "s. 302", "s. 497(2)", "para 14"
    Column("section_id", Text),  # chunks never cross a section (PRD §8.2)
    Column("text", Text, nullable=False),
    Column("token_count", Integer, nullable=False),
    # Copied from the document so retrieval can filter and label without a join (PRD §8.2).
    Column("headnote_only", Boolean, nullable=False, server_default=text("false")),
    Column("third_party", Boolean, nullable=False, server_default=text("false")),
    Column("chunker_version", Text, nullable=False),
    Column("embedding", Vector(EMBEDDING_DIMS)),  # filled by ingestion (#18)
    _tsv(),
    _now(),
    UniqueConstraint("document_id", "ordinal", name="chunks_document_ordinal_key"),
    Index("chunks_document_id_idx", "document_id"),
    Index(
        "chunks_embedding_hnsw_idx",
        "embedding",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    ),
    Index("chunks_tsv_idx", "tsv", postgresql_using="gin"),
    schema="corpus",
)

# One row: the settings the embedded corpus was built with. Retrieval refuses a query-side model
# that differs (data-storage spec §4), and a dump's manifest copies this row.
corpus_meta = Table(
    "corpus_meta",
    metadata,
    Column("id", SmallInteger, primary_key=True, server_default=text("1")),
    Column("embedding_model", Text),
    Column("embedding_revision", Text),
    Column("embedding_dims", Integer, nullable=False, server_default=text(str(EMBEDDING_DIMS))),
    Column("embedding_normalized", Boolean),
    Column("chunker_version", Text),
    Column("chunker_settings", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    Column("fts_config", Text, nullable=False, server_default=text(f"'{FTS_CONFIG}'")),
    Column("input_snapshots", JSONB, nullable=False, server_default=text("'[]'::jsonb")),
    Column("built_at", TIMESTAMP(timezone=True)),
    CheckConstraint("id = 1", name="corpus_meta_single_row"),
    schema="corpus",
)

# ── ai ──────────────────────────────────────────────────────────────────────────────────────

# What retrieval saw for one question (FR-RES-2): both ranked lists before fusion, and after.
# Never the question text: apps/api keeps the audit record (FR-TRUST-12).
answer_traces = Table(
    "answer_traces",
    metadata,
    Column("request_id", UUID(as_uuid=True), primary_key=True),
    Column("answerable", Boolean, nullable=False),
    Column("dense", JSONB, nullable=False, server_default=text("'[]'::jsonb")),
    Column("sparse", JSONB, nullable=False, server_default=text("'[]'::jsonb")),
    Column("fused", JSONB, nullable=False, server_default=text("'[]'::jsonb")),
    Column("reranked", JSONB, nullable=False, server_default=text("'[]'::jsonb")),
    Column("models", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    Column("provider", Text),
    Column("latency_ms", Integer),
    _now(),
    schema="ai",
)

# No foreign key into corpus: restoring a corpus dump truncates corpus (#154), and the existence
# check (FR-TRUST-9) already proved the source existed when the citation was written.
citations = Table(
    "citations",
    metadata,
    _id(),
    Column(
        "request_id",
        UUID(as_uuid=True),
        ForeignKey("ai.answer_traces.request_id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("source_id", UUID(as_uuid=True), nullable=False),
    Column("chunk_id", UUID(as_uuid=True)),
    Column("claim", Text, nullable=False),
    Column("locator", Text),
    Column("quote", Text),  # verbatim, in the source's language (FR-RES-10)
    Column("quote_language", Text),
    _now(),
    Index("citations_request_id_idx", "request_id"),
    schema="ai",
)

# The single trust store (FR-TRUST-10): one current verification per citation. Every reader
# takes the status from here and never recomputes or caches it.
verifications = Table(
    "verifications",
    metadata,
    Column(
        "citation_id",
        UUID(as_uuid=True),
        ForeignKey("ai.citations.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("status", Text, nullable=False),
    Column("flags", ARRAY(Text), nullable=False, server_default=text("'{}'::text[]")),
    Column("checks", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    Column(
        "last_verified_at",
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=text("now()"),
    ),
    Column("verifier_version", Text, nullable=False),
    CheckConstraint(_in("status", STATUSES), name="verifications_status_check"),
    CheckConstraint(
        f"flags <@ ARRAY[{', '.join(repr(f) for f in FLAGS)}]::text[]",
        name="verifications_flags_check",
    ),
    schema="ai",
)

# Chunks of a user's own case files (#145, data-storage spec §6). They live in ai, never in
# corpus, so a corpus dump can never contain them. Filled once uploads exist (#101).
case_chunks = Table(
    "case_chunks",
    metadata,
    _id(),
    Column("user_id", UUID(as_uuid=True), nullable=False),
    Column("case_id", UUID(as_uuid=True), nullable=False),
    Column("document_id", UUID(as_uuid=True), nullable=False),  # app.documents, owned by apps/api
    Column("ordinal", Integer, nullable=False),
    Column("locator", Text),
    Column("text", Text, nullable=False),
    Column("token_count", Integer, nullable=False),
    Column("chunker_version", Text, nullable=False),
    Column("embedding", Vector(EMBEDDING_DIMS)),
    _tsv(),
    _now(),
    UniqueConstraint("document_id", "ordinal", name="case_chunks_document_ordinal_key"),
    # Scope is applied in SQL on these two columns (FR-CASE-6).
    Index("case_chunks_scope_idx", "user_id", "case_id"),
    Index(
        "case_chunks_embedding_hnsw_idx",
        "embedding",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    ),
    Index("case_chunks_tsv_idx", "tsv", postgresql_using="gin"),
    schema="ai",
)
