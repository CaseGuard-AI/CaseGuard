"""document ingestions (#253, ADR-0010)

ai.ingestions: one row per uploaded document, holding its current attempt, state, stage log and
flags, so a restart of services/ai loses nothing (ai.v1 getIngestion). The chunks themselves go
to ai.case_chunks.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-28 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ingestions",
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("case_id", sa.UUID(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("media_type", sa.Text(), nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), server_default=sa.text("'queued'"), nullable=False),
        sa.Column(
            "stages",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "flags",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("retryable", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("pages", sa.Integer(), nullable=True),
        sa.Column("chunk_count", sa.Integer(), nullable=True),
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
        sa.CheckConstraint("attempt >= 1", name="ingestions_attempt_check"),
        sa.CheckConstraint(
            "state IN ('queued', 'running', 'done', 'flagged', 'failed')",
            name="ingestions_state_check",
        ),
        sa.PrimaryKeyConstraint("document_id"),
        schema="ai",
    )
    op.create_index(
        "ingestions_state_idx", "ingestions", ["state", "created_at"], unique=False, schema="ai"
    )


def downgrade() -> None:
    op.drop_index("ingestions_state_idx", table_name="ingestions", schema="ai")
    op.drop_table("ingestions", schema="ai")
