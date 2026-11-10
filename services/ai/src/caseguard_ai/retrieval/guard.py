"""Refuse to search a corpus with a different embedding model than the query's (#19).

A query vector from one model compared with chunk vectors from another gives meaningless
neighbours that look fine, so this is checked before every search, not assumed
(data-storage spec §4; the embed job records the model in ``corpus.corpus_meta``).
"""

from __future__ import annotations

from sqlalchemy import Connection, select

from caseguard_ai.db.tables import corpus_meta
from caseguard_ai.ingest.embedder import Embedder


class CorpusNotReady(Exception):
    """No embedded corpus yet: run ``pnpm data:embed`` (or restore a dump, #154)."""


class EmbeddingMismatch(Exception):
    """The corpus was embedded with another model or revision than the one embedding queries."""


def check_corpus(conn: Connection, embedder: Embedder) -> None:
    meta = conn.execute(select(corpus_meta)).mappings().first()
    if meta is None or meta["embedding_model"] is None:
        raise CorpusNotReady("the corpus has not been embedded: run pnpm data:embed")
    built = (meta["embedding_model"], meta["embedding_revision"])
    if built != (embedder.model_id, embedder.revision):
        raise EmbeddingMismatch(
            f"the corpus was embedded with {built[0]}@{built[1]}, but queries would use "
            f"{embedder.model_id}@{embedder.revision}. Set EMBEDDING_MODEL / EMBEDDING_REVISION "
            "to match, or rebuild the corpus."
        )
