"""knowledge graph tables (#210, PRD §9.1, ADR-0003)

corpus.graph_entities and corpus.graph_edges, with the P0 taxonomy (§9.2) as check constraints,
provenance on every edge (FR-GRAPH-1) and the unique keys that make the graph build idempotent.
caseguard_app reads them through the default privileges of infra/db/sql/bootstrap.sql.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-21 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "graph_entities",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("ref_table", sa.Text(), nullable=True),
        sa.Column("ref_id", sa.UUID(), nullable=True),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "type IN ('statute', 'section', 'judgment', 'court', 'amendment_act')",
            name="graph_entities_type_check",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("type", "key", name="graph_entities_type_key_key"),
        schema="corpus",
    )
    op.create_index(
        "graph_entities_ref_id_idx", "graph_entities", ["ref_id"], unique=False, schema="corpus"
    )
    op.create_table(
        "graph_edges",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("src_entity", sa.UUID(), nullable=False),
        sa.Column("dst_entity", sa.UUID(), nullable=False),
        sa.Column("valid_from", sa.Date(), nullable=True),
        sa.Column("valid_to", sa.Date(), nullable=True),
        sa.Column(
            "recorded_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("provenance_doc_id", sa.UUID(), nullable=True),
        sa.Column("extraction_method", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Double(), nullable=False),
        sa.Column("human_confirmed", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "verification_status",
            sa.Text(),
            server_default=sa.text("'unverified'"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "type IN ('CITES_SECTION', 'CITES_JUDGMENT', 'AMENDS', 'SUBSTITUTES', 'INSERTS', "
            "'OMITS', 'REPEALS', 'OVERRULES', 'CONNECTED_CASE')",
            name="graph_edges_type_check",
        ),
        sa.CheckConstraint(
            "extraction_method IN ('metadata', 'regex', 'human')",
            name="graph_edges_extraction_method_check",
        ),
        sa.CheckConstraint(
            "confidence >= 0 AND confidence <= 1", name="graph_edges_confidence_check"
        ),
        sa.CheckConstraint(
            "verification_status IN ('verified', 'needs_review', 'unverified')",
            name="graph_edges_verification_status_check",
        ),
        sa.ForeignKeyConstraint(["src_entity"], ["corpus.graph_entities.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["dst_entity"], ["corpus.graph_entities.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["provenance_doc_id"], ["corpus.documents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "type",
            "src_entity",
            "dst_entity",
            "provenance_doc_id",
            name="graph_edges_identity_key",
        ),
        schema="corpus",
    )
    op.create_index(
        "graph_edges_src_entity_idx", "graph_edges", ["src_entity"], unique=False, schema="corpus"
    )
    op.create_index(
        "graph_edges_dst_entity_idx", "graph_edges", ["dst_entity"], unique=False, schema="corpus"
    )
    op.create_index("graph_edges_type_idx", "graph_edges", ["type"], unique=False, schema="corpus")


def downgrade() -> None:
    op.drop_index("graph_edges_type_idx", table_name="graph_edges", schema="corpus")
    op.drop_index("graph_edges_dst_entity_idx", table_name="graph_edges", schema="corpus")
    op.drop_index("graph_edges_src_entity_idx", table_name="graph_edges", schema="corpus")
    op.drop_table("graph_edges", schema="corpus")
    op.drop_index("graph_entities_ref_id_idx", table_name="graph_entities", schema="corpus")
    op.drop_table("graph_entities", schema="corpus")
