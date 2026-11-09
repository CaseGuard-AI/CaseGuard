"""corpus and ai tables (#15)

corpus: documents, chunks (bge-m3 vector(1024) + HNSW, generated tsvector + GIN), corpus_meta.
ai: answer_traces, citations, verifications (the single trust store) and case_chunks.
The schemas, roles and the vector extension come from infra/db/sql/bootstrap.sql.

Revision ID: 0001
Revises:
Create Date: 2026-11-09 23:28:43.931054
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "answer_traces",
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("answerable", sa.Boolean(), nullable=False),
        sa.Column(
            "dense",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "sparse",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "fused",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "reranked",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "models",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("provider", sa.Text(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("request_id"),
        schema="ai",
    )
    op.create_table(
        "case_chunks",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("case_id", sa.UUID(), nullable=False),
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("locator", sa.Text(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        sa.Column("chunker_version", sa.Text(), nullable=False),
        sa.Column("embedding", Vector(1024), nullable=True),
        sa.Column(
            "tsv",
            postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('english'::regconfig, text)", persisted=True),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("document_id", "ordinal", name="case_chunks_document_ordinal_key"),
        schema="ai",
    )
    op.create_index(
        "case_chunks_embedding_hnsw_idx",
        "case_chunks",
        ["embedding"],
        unique=False,
        schema="ai",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )
    op.create_index(
        "case_chunks_scope_idx", "case_chunks", ["user_id", "case_id"], unique=False, schema="ai"
    )
    op.create_index(
        "case_chunks_tsv_idx",
        "case_chunks",
        ["tsv"],
        unique=False,
        schema="ai",
        postgresql_using="gin",
    )
    op.create_table(
        "corpus_meta",
        sa.Column("id", sa.SmallInteger(), server_default=sa.text("1"), nullable=False),
        sa.Column("embedding_model", sa.Text(), nullable=True),
        sa.Column("embedding_revision", sa.Text(), nullable=True),
        sa.Column("embedding_dims", sa.Integer(), server_default=sa.text("1024"), nullable=False),
        sa.Column("embedding_normalized", sa.Boolean(), nullable=True),
        sa.Column("chunker_version", sa.Text(), nullable=True),
        sa.Column(
            "chunker_settings",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("fts_config", sa.Text(), server_default=sa.text("'english'"), nullable=False),
        sa.Column(
            "input_snapshots",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("built_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.CheckConstraint("id = 1", name="corpus_meta_single_row"),
        sa.PrimaryKeyConstraint("id"),
        schema="corpus",
    )
    op.create_table(
        "documents",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("collector_id", sa.Text(), nullable=False),
        sa.Column("source_key", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("citation", sa.Text(), nullable=True),
        sa.Column("case_number", sa.Text(), nullable=True),
        sa.Column("court", sa.Text(), nullable=True),
        sa.Column("matter_type", sa.Text(), nullable=True),
        sa.Column("decided_on", sa.Date(), nullable=True),
        sa.Column("language", sa.Text(), server_default=sa.text("'en'"), nullable=False),
        sa.Column("official_url", sa.Text(), nullable=False),
        sa.Column("document_file_url", sa.Text(), nullable=True),
        sa.Column("retrieved_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("source_tier", sa.SmallInteger(), server_default=sa.text("1"), nullable=False),
        sa.Column("third_party", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("headnote_only", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("snapshot", sa.Text(), nullable=True),
        sa.Column("extraction_status", sa.Text(), nullable=True),
        sa.Column("full_text", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("content_hash", sa.Text(), nullable=False),
        sa.Column("area", sa.Text(), nullable=True),
        sa.Column("subcategory", sa.Text(), nullable=True),
        sa.Column("proceeding_type", sa.Text(), nullable=True),
        sa.Column(
            "raw",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('statute', 'judgment', 'rule', 'other')", name="documents_kind_check"
        ),
        sa.CheckConstraint("source_tier IN (1, 2)", name="documents_source_tier_check"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("collector_id"),
        sa.UniqueConstraint("content_hash"),
        schema="corpus",
    )
    op.create_index(
        "documents_source_key_idx", "documents", ["source_key"], unique=False, schema="corpus"
    )
    op.create_table(
        "citations",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("source_id", sa.UUID(), nullable=False),
        sa.Column("chunk_id", sa.UUID(), nullable=True),
        sa.Column("claim", sa.Text(), nullable=False),
        sa.Column("locator", sa.Text(), nullable=True),
        sa.Column("quote", sa.Text(), nullable=True),
        sa.Column("quote_language", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["request_id"], ["ai.answer_traces.request_id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        schema="ai",
    )
    op.create_index(
        "citations_request_id_idx", "citations", ["request_id"], unique=False, schema="ai"
    )
    op.create_table(
        "chunks",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("locator", sa.Text(), nullable=True),
        sa.Column("section_id", sa.Text(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        sa.Column("headnote_only", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("third_party", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("chunker_version", sa.Text(), nullable=False),
        sa.Column("embedding", Vector(1024), nullable=True),
        sa.Column(
            "tsv",
            postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('english'::regconfig, text)", persisted=True),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["document_id"], ["corpus.documents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("document_id", "ordinal", name="chunks_document_ordinal_key"),
        schema="corpus",
    )
    op.create_index(
        "chunks_document_id_idx", "chunks", ["document_id"], unique=False, schema="corpus"
    )
    op.create_index(
        "chunks_embedding_hnsw_idx",
        "chunks",
        ["embedding"],
        unique=False,
        schema="corpus",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )
    op.create_index(
        "chunks_tsv_idx", "chunks", ["tsv"], unique=False, schema="corpus", postgresql_using="gin"
    )
    op.create_table(
        "verifications",
        sa.Column("citation_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "flags",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'::text[]"),
            nullable=False,
        ),
        sa.Column(
            "checks",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "last_verified_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("verifier_version", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "flags <@ ARRAY['overruled', 'repealed', 'superseded_version', 'conflict', 'stale', 'third_party_source', 'headnote_only', 'amended_since']::text[]",
            name="verifications_flags_check",
        ),
        sa.CheckConstraint(
            "status IN ('verified', 'needs_review', 'unverified')",
            name="verifications_status_check",
        ),
        sa.ForeignKeyConstraint(["citation_id"], ["ai.citations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("citation_id"),
        schema="ai",
    )


def downgrade() -> None:
    op.drop_table("verifications", schema="ai")
    op.drop_index("chunks_tsv_idx", table_name="chunks", schema="corpus", postgresql_using="gin")
    op.drop_index(
        "chunks_embedding_hnsw_idx",
        table_name="chunks",
        schema="corpus",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )
    op.drop_index("chunks_document_id_idx", table_name="chunks", schema="corpus")
    op.drop_table("chunks", schema="corpus")
    op.drop_index("citations_request_id_idx", table_name="citations", schema="ai")
    op.drop_table("citations", schema="ai")
    op.drop_index("documents_source_key_idx", table_name="documents", schema="corpus")
    op.drop_table("documents", schema="corpus")
    op.drop_table("corpus_meta", schema="corpus")
    op.drop_index(
        "case_chunks_tsv_idx", table_name="case_chunks", schema="ai", postgresql_using="gin"
    )
    op.drop_index("case_chunks_scope_idx", table_name="case_chunks", schema="ai")
    op.drop_index(
        "case_chunks_embedding_hnsw_idx",
        table_name="case_chunks",
        schema="ai",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )
    op.drop_table("case_chunks", schema="ai")
    op.drop_table("answer_traces", schema="ai")
