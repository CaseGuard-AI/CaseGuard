"""Document ingestion attempts (#253, ADR-0010): their persisted state, the pipeline that runs
them, and the background worker.

apps/api submits an attempt (``submit``) and polls it (``status``); services/ai never calls back.
The state lives in ``ai.ingestions`` so a restart loses nothing:

- ``submit`` is idempotent per ``(documentId, attempt)``. A higher attempt overwrites the row
  and goes back to ``queued``; the running attempt notices at its next stage and stops, dropping
  its partial output. A lower attempt is refused (``StaleAttempt``, a 409).
- The worker claims one ``queued`` row at a time with ``FOR UPDATE SKIP LOCKED``, so several
  processes could share the queue, and runs the stages in a thread.
- ``index`` replaces the document's chunks and finishes the attempt in one transaction that
  first locks the row and checks the attempt is still current. A newer attempt or a purge can
  therefore never be overwritten, and the old chunks stay retrievable until then.
- On start-up, attempts left ``running`` by a previous process are marked ``failed`` and
  ``retryable`` (the contract's restart rule). This assumes one worker process per database.
"""

from __future__ import annotations

import asyncio
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import structlog
from sqlalchemy import Engine, delete, insert, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError, OperationalError

from caseguard_ai.config import DocumentSettings
from caseguard_ai.db.tables import case_chunks, ingestions
from caseguard_ai.ingest import documents
from caseguard_ai.ingest.chunker import CHUNKER_VERSION
from caseguard_ai.ingest.embedder import Embedder

log = structlog.get_logger("ingestion")

EMBED_BATCH = 32
INTERRUPTED = "Processing was interrupted by a restart."
UNEXPECTED = "The document could not be processed."
MISSING = "The uploaded file could not be found."


class StaleAttempt(Exception):
    """A lower attempt than the current one was submitted (409)."""


class Superseded(Exception):
    """The attempt being run is no longer current: a newer one was submitted, or it was purged."""


@dataclass(frozen=True)
class Submission:
    document_id: uuid.UUID
    attempt: int
    user_id: uuid.UUID
    case_id: uuid.UUID
    storage_key: str
    media_type: str
    filename: str


def now() -> str:
    return datetime.now(UTC).isoformat()


def pending_stages() -> list[dict[str, Any]]:
    return [
        {"stage": s, "state": "pending", "startedAt": None, "finishedAt": None, "flags": []}
        for s in documents.STAGES
    ]


def as_status(row: Any) -> dict[str, Any]:
    """An ai.v1 IngestionStatus from an ``ai.ingestions`` row."""
    return {
        "documentId": str(row.document_id),
        "attempt": row.attempt,
        "state": row.state,
        "stages": row.stages,
        "flags": row.flags,
        "error": row.error,
        "retryable": row.retryable,
        "pages": row.pages,
        "chunkCount": row.chunk_count,
    }


def blob_path(uploads: Path, storage_key: str) -> Path:
    """The file for a blob key, refusing any key that would leave the uploads folder."""
    base = uploads.resolve()
    path = base.joinpath(*storage_key.split("/")).resolve()
    if not path.is_relative_to(base) or path == base:
        raise ValueError("invalid blob key")
    return path


# ── the store ───────────────────────────────────────────────────────────────────────────────


def submit(engine: Engine, sub: Submission) -> dict[str, Any]:
    """Queue an attempt (or return the current one's status). Raises StaleAttempt."""
    fresh = {
        "attempt": sub.attempt,
        "user_id": sub.user_id,
        "case_id": sub.case_id,
        "storage_key": sub.storage_key,
        "media_type": sub.media_type,
        "filename": sub.filename,
        "state": "queued",
        "stages": pending_stages(),
        "flags": [],
        "error": None,
        "retryable": False,
        "pages": None,
        "chunk_count": None,
    }
    upsert = (
        pg_insert(ingestions)
        .values(document_id=sub.document_id, **fresh)
        .on_conflict_do_update(
            index_elements=[ingestions.c.document_id],
            # created_at is kept: it is the document's place in the queue (``claim``), so a
            # retry never goes to the back while apps/api's deadline runs.
            set_={**fresh, "updated_at": text("now()")},
            where=ingestions.c.attempt < sub.attempt,
        )
        .returning(*ingestions.c)
    )
    with engine.begin() as conn:
        row = conn.execute(upsert).first()
        if row is None:  # a row with this attempt or a later one already exists
            row = conn.execute(
                select(ingestions).where(ingestions.c.document_id == sub.document_id)
            ).one()
    if row.attempt > sub.attempt:
        raise StaleAttempt
    return as_status(row)


def status(engine: Engine, document_id: uuid.UUID) -> dict[str, Any] | None:
    with engine.connect() as conn:
        row = conn.execute(
            select(ingestions).where(ingestions.c.document_id == document_id)
        ).first()
    return as_status(row) if row else None


def purge(engine: Engine, document_id: uuid.UUID) -> None:
    """Delete the document's ingestion record and chunks. A running attempt stops at its next
    stage, and its index transaction finds the row gone."""
    with engine.begin() as conn:
        conn.execute(delete(ingestions).where(ingestions.c.document_id == document_id))
        conn.execute(delete(case_chunks).where(case_chunks.c.document_id == document_id))


def recover(engine: Engine) -> int:
    """Mark attempts a previous process left ``running`` as failed and retryable."""
    with engine.begin() as conn:
        rows = conn.execute(
            select(ingestions.c.document_id, ingestions.c.stages)
            .where(ingestions.c.state == "running")
            .with_for_update(skip_locked=True)
        ).all()
        for row in rows:
            stages = [
                {**s, "state": "failed", "finishedAt": now()} if s["state"] == "running" else s
                for s in row.stages
            ]
            conn.execute(
                update(ingestions)
                .where(ingestions.c.document_id == row.document_id)
                .values(
                    state="failed",
                    retryable=True,
                    error=INTERRUPTED,
                    stages=stages,
                    updated_at=text("now()"),
                )
            )
    return len(rows)


def claim(engine: Engine) -> Any | None:
    """Take the queued attempt of the document submitted first and mark it running, or None if
    there is none. Ordered by the first submission, not the latest attempt's."""
    oldest = (
        select(ingestions.c.document_id)
        .where(ingestions.c.state == "queued")
        .order_by(ingestions.c.created_at, ingestions.c.document_id)
        .limit(1)
        .with_for_update(skip_locked=True)
        .scalar_subquery()
    )
    with engine.begin() as conn:
        return conn.execute(
            update(ingestions)
            .where(ingestions.c.document_id == oldest)
            .values(state="running", updated_at=text("now()"))
            .returning(*ingestions.c)
        ).first()


# ── one attempt ─────────────────────────────────────────────────────────────────────────────


class Attempt:
    """Runs the stages of one claimed attempt and records each outcome on its row."""

    def __init__(
        self,
        engine: Engine,
        embedder: Embedder,
        settings: DocumentSettings,
        row: Any,
        stop: threading.Event | None = None,
    ) -> None:
        self.engine, self.embedder, self.settings, self.row = engine, embedder, settings, row
        self.stop = stop or threading.Event()
        self.stages = {s["stage"]: dict(s) for s in pending_stages()}
        self.pages: int | None = None

    # The row is only ever written WHERE the attempt is still this one.
    def _current(self) -> Any:
        return (ingestions.c.document_id == self.row.document_id) & (
            ingestions.c.attempt == self.row.attempt
        )

    def _flags(self) -> list[dict[str, Any]]:
        return [f for s in documents.STAGES for f in self.stages[s]["flags"]]

    def _save(self, **values: Any) -> None:
        with self.engine.begin() as conn:
            moved = conn.execute(
                update(ingestions)
                .where(self._current())
                .values(
                    stages=[self.stages[s] for s in documents.STAGES],
                    flags=self._flags(),
                    pages=self.pages,
                    updated_at=text("now()"),
                    **values,
                )
            ).rowcount
        if not moved:
            raise Superseded

    def _start(self, stage: str) -> None:
        if self.stop.is_set():
            raise Superseded  # shutting down: the restart rule reports it
        self.stages[stage].update(state="running", startedAt=now())
        self._save()

    def _finish(self, stage: str, flags: list[dict[str, Any]], state: str | None = None) -> None:
        self.stages[stage].update(
            state=state or ("flagged" if flags else "done"), finishedAt=now(), flags=flags
        )

    def run(self) -> None:
        bound = log.bind(document_id=str(self.row.document_id), attempt=self.row.attempt)
        stage = "extract"
        try:
            try:
                data = blob_path(self.settings.uploads_path, self.row.storage_key).read_bytes()
            except FileNotFoundError as exc:
                raise documents.DocumentError("extract", MISSING) from exc
            with documents.open_document(data, self.row.media_type) as opened:
                del data
                self.pages = opened.page_count

                stage = "ocr"
                self._start(stage)
                state, flags = documents.run_ocr(opened, self._check)
                self._finish(stage, flags, state)

                stage = "extract"
                self._start(stage)
                extracted = documents.extract(opened)
                self._finish(stage, [])

            stage = "clean"
            self._start(stage)
            cleaned = documents.clean(extracted, self.settings.ingest_max_chars)
            self._finish(stage, cleaned.flags)

            stage = "structure"
            self._start(stage)
            self._finish(stage, documents.structure(cleaned))

            stage = "chunk"
            self._start(stage)
            pieces = documents.chunk(cleaned, self.row.filename)
            if not pieces:
                raise documents.DocumentError(
                    "chunk", "No text could be read from this document.", code="no_text"
                )
            self._finish(stage, [])

            stage = "embed"
            self._start(stage)
            vectors: list[list[float]] = []
            for i in range(0, len(pieces), EMBED_BATCH):
                if i:
                    self._check()  # a newer attempt, a purge or shutdown stops it here
                vectors.extend(self.embedder.embed([p.text for p in pieces[i : i + EMBED_BATCH]]))
            self._finish(stage, [])

            stage = "index"
            self._start(stage)
            self._index(pieces, vectors)
            bound.info("ingestion_done", chunks=len(pieces), flags=len(self._flags()))
        except Superseded:
            bound.info("ingestion_superseded", stage=stage)
        except documents.DocumentError as exc:
            bound.warning("ingestion_failed", stage=exc.stage, reason=exc.message)
            self._fail(exc.stage, exc.message, exc.retryable, exc.flags)
        except (OperationalError, OSError) as exc:  # the database or the disk, for a moment
            bound.warning("ingestion_failed", stage=stage, reason=type(exc).__name__)
            self._fail(stage, UNEXPECTED, True)
        except Exception as exc:
            bound.exception("ingestion_error", stage=stage, reason=type(exc).__name__)
            self._fail(stage, UNEXPECTED, False)

    def _check(self) -> None:
        with self.engine.connect() as conn:
            attempt = conn.execute(
                select(ingestions.c.attempt).where(ingestions.c.document_id == self.row.document_id)
            ).scalar()
        if attempt != self.row.attempt or self.stop.is_set():
            raise Superseded

    def _index(self, pieces: list[Any], vectors: list[list[float]]) -> None:
        self._finish("index", [])
        flags = self._flags()
        with self.engine.begin() as conn:
            current = conn.execute(
                select(ingestions.c.attempt).where(self._current()).with_for_update()
            ).first()
            if current is None:
                raise Superseded
            conn.execute(
                delete(case_chunks).where(case_chunks.c.document_id == self.row.document_id)
            )
            conn.execute(
                insert(case_chunks),
                [
                    {
                        "user_id": self.row.user_id,
                        "case_id": self.row.case_id,
                        "document_id": self.row.document_id,
                        "ordinal": p.ordinal,
                        "locator": p.locator,
                        "text": p.text,
                        "token_count": p.token_count,
                        "chunker_version": CHUNKER_VERSION,
                        "embedding": v,
                    }
                    for p, v in zip(pieces, vectors, strict=True)
                ],
            )
            conn.execute(
                update(ingestions)
                .where(self._current())
                .values(
                    state="flagged" if flags else "done",
                    stages=[self.stages[s] for s in documents.STAGES],
                    flags=flags,
                    pages=self.pages,
                    chunk_count=len(pieces),
                    error=None,
                    retryable=False,
                    updated_at=text("now()"),
                )
            )

    def _fail(
        self, stage: str, message: str, retryable: bool, flags: list[dict[str, Any]] | None = None
    ) -> None:
        entry = self.stages[stage]
        entry.update(
            state="failed",
            startedAt=entry["startedAt"] or now(),
            finishedAt=now(),
            flags=[*entry["flags"], *(flags or [])],
        )
        try:
            self._save(state="failed", error=message[:500], retryable=retryable)
        except Superseded:
            pass
        except DBAPIError:
            # Still `running`: the next start-up reports it failed and retryable.
            log.warning("ingestion_state_lost", document_id=str(self.row.document_id))


def run_once(
    engine: Engine,
    embedder: Callable[[], Embedder],
    settings: DocumentSettings,
    stop: threading.Event | None = None,
) -> bool:
    """Claim and run one queued attempt. False when the queue is empty."""
    row = claim(engine)
    if row is None:
        return False
    Attempt(engine, embedder(), settings, row, stop).run()
    return True


def run_queue(engine: Engine, embedder: Callable[[], Embedder], settings: DocumentSettings) -> int:
    """Run every queued attempt now, in this thread (tests and one-off use)."""
    count = 0
    while run_once(engine, embedder, settings):
        count += 1
    return count


# ── the worker ──────────────────────────────────────────────────────────────────────────────


class Worker:
    """One background loop per process: recover, then claim and run attempts until stopped."""

    def __init__(
        self,
        engine: Callable[[], Engine],
        embedder: Callable[[], Embedder],
        settings: DocumentSettings,
    ) -> None:
        self.engine, self.embedder, self.settings = engine, embedder, settings
        self.stop = threading.Event()
        self._wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(self._loop())

    async def close(self) -> None:
        """Ask the in-flight attempt to stop (it checks between stages, OCR pages and embedding
        batches) and wait for its thread, at most INGEST_SHUTDOWN_SECONDS. An attempt still
        running after that stays `running` and the next start-up reports it failed and
        retryable."""
        self.stop.set()
        self._wake.set()
        if not self._task:
            return
        try:
            await asyncio.wait_for(self._task, timeout=self.settings.ingest_shutdown_seconds)
        except TimeoutError:
            log.warning("ingestion_worker_shutdown_timeout")
        except asyncio.CancelledError:
            pass

    async def _idle(self) -> None:
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=self.settings.ingest_poll_seconds)
        except TimeoutError:
            pass

    async def _loop(self) -> None:
        recovered = False
        while not self.stop.is_set():
            busy = False
            try:
                engine = self.engine()
                if not recovered:
                    count = await asyncio.to_thread(recover, engine)
                    recovered = True
                    if count:
                        log.warning("ingestions_interrupted", count=count)
                busy = await asyncio.to_thread(
                    run_once, engine, self.embedder, self.settings, self.stop
                )
            except DBAPIError as exc:
                log.warning("ingestion_worker_db_unavailable", reason=type(exc).__name__)
            except Exception:
                log.exception("ingestion_worker_error")
            if not busy and not self.stop.is_set():
                await self._idle()
