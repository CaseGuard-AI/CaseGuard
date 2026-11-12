"""Alembic environment for the corpus and ai schemas (ADR-0002).

The schemas themselves, the roles and the pgvector extension come from infra/db/sql/bootstrap.sql,
run as a superuser. Migrations only create and drop tables inside corpus and ai, as caseguard_ai.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import Connection

from caseguard_ai.config import DatabaseSettings
from caseguard_ai.db.engine import migration_engine
from caseguard_ai.db.tables import metadata

if context.config.config_file_name is not None and not context.config.attributes.get("url"):
    # CLI runs log "Running upgrade ..." lines; tests pass a URL and keep their own logging.
    fileConfig(context.config.config_file_name, disable_existing_loggers=False)

OWNED_SCHEMAS = {"corpus", "ai"}
VERSION_SCHEMA = "ai"  # ai.alembic_version: the revision a corpus dump is checked against (#154)


def _url() -> str:
    # tests and tools may pass the URL explicitly; otherwise AI_DATABASE_URL.
    explicit = context.config.attributes.get("url")
    return str(explicit) if explicit else DatabaseSettings().sqlalchemy_url


def _include_name(name: str | None, type_: str, parent_names: object) -> bool:
    if type_ == "schema":
        return name in OWNED_SCHEMAS
    return True


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=metadata,
        include_schemas=True,
        include_name=_include_name,
        version_table_schema=VERSION_SCHEMA,
        literal_binds=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connection = context.config.attributes.get("connection")
    if connection is not None:
        _run(connection)
        return
    engine = migration_engine(_url())
    with engine.connect() as conn:
        _run(conn)


def _run(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=metadata,
        include_schemas=True,
        include_name=_include_name,
        version_table_schema=VERSION_SCHEMA,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
