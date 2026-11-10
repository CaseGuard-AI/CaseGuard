"""Text embedders (#18, ADR-0008: in-process, not through the model gateway).

- ``BgeM3Embedder``: BAAI/bge-m3 dense vectors (1,024 dims, normalised) with sentence-transformers,
  pinned to a model revision. It runs on CPU by default, or on CUDA when torch has a GPU.
- ``HashEmbedder``: a deterministic bag-of-words embedder (feature hashing). Tests and CI use it so
  nothing is downloaded. It is not a semantic model; never build a real corpus with it.

Whatever built the corpus is recorded in ``corpus.corpus_meta``. The embed job refuses a different
model or revision, and retrieval must embed queries with the same one (#19).
"""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Sequence
from typing import Any, Protocol

from caseguard_ai.db.tables import EMBEDDING_DIMS


class Embedder(Protocol):
    model_id: str
    revision: str
    dims: int
    normalized: bool

    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


class HashEmbedder:
    """Feature hashing of lower-cased words into ``dims`` buckets, L2-normalised."""

    model_id = "caseguard/hash-bow"
    revision = "1"
    normalized = True

    def __init__(self, dims: int = EMBEDDING_DIMS) -> None:
        self.dims = dims

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._one(t) for t in texts]

    def _one(self, text: str) -> list[float]:
        vector = [0.0] * self.dims
        for word in re.findall(r"\w+", text.lower()):
            digest = hashlib.blake2b(word.encode(), digest_size=8).digest()
            bucket = int.from_bytes(digest[:4], "little") % self.dims
            vector[bucket] += 1.0 if digest[4] & 1 else -1.0
        norm = math.sqrt(sum(v * v for v in vector))
        if norm == 0:
            vector[0] = 1.0  # an empty text still gets a valid unit vector
            return vector
        return [v / norm for v in vector]


class BgeM3Embedder:
    """BAAI/bge-m3 dense embeddings, loaded once per process."""

    normalized = True

    def __init__(
        self,
        model_id: str,
        revision: str,
        *,
        device: str | None = None,
        batch_size: int = 16,
        max_seq_length: int = 1024,
    ) -> None:
        from sentence_transformers import SentenceTransformer  # heavy: only when used

        self.model_id = model_id
        self.revision = revision
        self.batch_size = batch_size
        self._model: Any = SentenceTransformer(
            model_id, revision=revision, device=device or default_device()
        )
        # Chunks are about 500 estimated tokens (chunker.py); 1,024 leaves room for subwords
        # and keeps CPU memory and time in check. bge-m3 itself reads up to 8,192.
        self._model.max_seq_length = max_seq_length
        dims = self._model.get_sentence_embedding_dimension()
        self.dims = int(dims) if dims is not None else 0
        if self.dims != EMBEDDING_DIMS:
            raise ValueError(
                f"{model_id} gives {self.dims} dims; corpus.chunks holds {EMBEDDING_DIMS}"
            )

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        vectors = self._model.encode(
            list(texts),
            batch_size=self.batch_size,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        return [list(map(float, v)) for v in vectors]


def default_device() -> str:
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


def get_embedder(name: str, model_id: str, revision: str, **kwargs: Any) -> Embedder:
    if name == "hash":
        return HashEmbedder()  # model_id and revision are fixed for the test embedder
    if name == "bge-m3":
        return BgeM3Embedder(model_id, revision, **kwargs)
    raise ValueError(f"unknown embedder {name!r} (bge-m3 or hash)")
