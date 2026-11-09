"""SQLAlchemy engines for the corpus and ai schemas."""

from __future__ import annotations

from sqlalchemy import Engine, create_engine, pool


def migration_engine(url: str) -> Engine:
    """An engine for Alembic, with ``search_path`` pinned to ``public`` at connect time.

    caseguard_ai's own search_path starts with ``corpus``. SQLAlchemy records the default schema
    when it first connects, and would then reflect ``corpus`` tables as schema-less, so autogenerate
    would see them as missing. Pinning the path in the connection options (not with a ``SET``,
    which would open a transaction Alembic then never commits) keeps ``corpus`` and ``ai`` named.
    ``public`` holds the extensions (``vector``), which migrations use but never create.
    """
    return create_engine(
        url,
        poolclass=pool.NullPool,
        connect_args={"options": "-c search_path=public"},
    )
