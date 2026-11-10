"""SQLite crawl state: the thing that makes re-runs cheap and resumable.

Three tables:
  seen      one row per URL we have processed, with content hash + HTTP
            validators, so we can (a) skip, (b) detect change, (c) send
            conditional requests.
  hashes    content_hash -> first document id that carried it, for
            cross-URL duplicate detection (same judgment under two URLs).
  failures  URLs that blew up, with attempt counts, so `--retry-failed`
            can pick them up without re-walking the whole site.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS seen (
    url            TEXT PRIMARY KEY,
    source         TEXT NOT NULL,
    document_id    TEXT,
    content_hash   TEXT,
    etag           TEXT,
    last_modified  TEXT,
    first_seen     TEXT NOT NULL,
    last_seen      TEXT NOT NULL,
    revision       INTEGER NOT NULL DEFAULT 1,
    status         TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS idx_seen_source ON seen(source);
CREATE INDEX IF NOT EXISTS idx_seen_hash   ON seen(content_hash);

CREATE TABLE IF NOT EXISTS hashes (
    content_hash TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL,
    source       TEXT NOT NULL,
    url          TEXT NOT NULL,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS failures (
    url          TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    error        TEXT,
    attempts     INTEGER NOT NULL DEFAULT 1,
    first_failed TEXT NOT NULL,
    last_failed  TEXT NOT NULL,
    resolved     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS runs (
    run_id     TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    sources    TEXT,
    summary    TEXT
);
"""

# What a partition run records for the snapshot manifest (#152, #153).
RUN_PARTITION_COLUMNS = ("partition", "selection_file", "selection_sha256", "source_snapshot")


def _now() -> str:
    return datetime.now(UTC).isoformat()


class StateStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        with self._connect() as conn:
            conn.executescript(SCHEMA)
            # Columns added after the first release; older state.db files gain them here.
            have = {r["name"] for r in conn.execute("PRAGMA table_info(runs)")}
            for column in RUN_PARTITION_COLUMNS:
                if column not in have:
                    conn.execute(f"ALTER TABLE runs ADD COLUMN {column} TEXT")

    # -----------------------------------------------------------------
    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            self._local.conn = conn
        return conn

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = self._conn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    # --- seen ---------------------------------------------------------
    def get_seen(self, url: str) -> dict | None:
        row = self._conn().execute("SELECT * FROM seen WHERE url = ?", (url,)).fetchone()
        return dict(row) if row else None

    def is_seen(self, url: str) -> bool:
        return self.get_seen(url) is not None

    def validators_for(self, url: str) -> tuple[str | None, str | None]:
        """(etag, last_modified) for a conditional GET."""
        row = self.get_seen(url)
        if not row:
            return None, None
        return row.get("etag"), row.get("last_modified")

    def mark_seen(
        self,
        url: str,
        source: str,
        *,
        document_id: str | None = None,
        content_hash: str | None = None,
        etag: str | None = None,
        last_modified: str | None = None,
        status: str = "ok",
    ) -> str:
        """Record a processed URL. Returns 'new', 'unchanged' or 'changed'."""
        existing = self.get_seen(url)
        now = _now()
        if existing is None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO seen (url, source, document_id, content_hash, etag,"
                    " last_modified, first_seen, last_seen, revision, status)"
                    " VALUES (?,?,?,?,?,?,?,?,1,?)",
                    (url, source, document_id, content_hash, etag, last_modified, now, now, status),
                )
            return "new"

        changed = (
            content_hash is not None
            and existing["content_hash"] is not None
            and content_hash != existing["content_hash"]
        )
        with self._connect() as conn:
            conn.execute(
                "UPDATE seen SET document_id=COALESCE(?, document_id),"
                " content_hash=COALESCE(?, content_hash), etag=COALESCE(?, etag),"
                " last_modified=COALESCE(?, last_modified), last_seen=?,"
                " revision=revision + ?, status=? WHERE url=?",
                (
                    document_id,
                    content_hash,
                    etag,
                    last_modified,
                    now,
                    1 if changed else 0,
                    status,
                    url,
                ),
            )
        return "changed" if changed else "unchanged"

    def should_process(self, url: str, *, force: bool = False) -> bool:
        if force:
            return True
        row = self.get_seen(url)
        return row is None or row["status"] != "ok"

    # --- content hashes ----------------------------------------------
    def duplicate_of(self, content_hash: str | None) -> dict | None:
        """Has this exact text already been stored under a different URL?"""
        if not content_hash:
            return None
        row = (
            self._conn()
            .execute("SELECT * FROM hashes WHERE content_hash = ?", (content_hash,))
            .fetchone()
        )
        return dict(row) if row else None

    def register_hash(
        self, content_hash: str | None, document_id: str, source: str, url: str
    ) -> bool:
        """True if newly registered, False if it was already known."""
        if not content_hash:
            return False
        if self.duplicate_of(content_hash):
            return False
        with self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO hashes"
                " (content_hash, document_id, source, url, created_at)"
                " VALUES (?,?,?,?,?)",
                (content_hash, document_id, source, url, _now()),
            )
        return True

    # --- failures -----------------------------------------------------
    def record_failure(self, url: str, source: str, error: str) -> None:
        now = _now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO failures (url, source, error, attempts, first_failed,"
                " last_failed, resolved) VALUES (?,?,?,1,?,?,0)"
                " ON CONFLICT(url) DO UPDATE SET attempts = attempts + 1,"
                " error = excluded.error, last_failed = excluded.last_failed,"
                " resolved = 0",
                (url, source, str(error)[:1000], now, now),
            )

    def clear_failure(self, url: str) -> None:
        with self._connect() as conn:
            conn.execute("UPDATE failures SET resolved=1 WHERE url=?", (url,))

    def open_failures(self, source: str | None = None, max_attempts: int = 5) -> list[dict]:
        sql = "SELECT * FROM failures WHERE resolved=0 AND attempts < ?"
        params: list = [max_attempts]
        if source:
            sql += " AND source = ?"
            params.append(source)
        return [dict(r) for r in self._conn().execute(sql, params).fetchall()]

    # --- runs ---------------------------------------------------------
    def start_run(
        self,
        run_id: str,
        sources: str,
        *,
        partition: str | None = None,
        selection_file: str | None = None,
        selection_sha256: str | None = None,
        source_snapshot: str | None = None,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO runs (run_id, started_at, sources, partition,"
                " selection_file, selection_sha256, source_snapshot) VALUES (?,?,?,?,?,?,?)",
                (
                    run_id,
                    _now(),
                    sources,
                    partition,
                    selection_file,
                    selection_sha256,
                    source_snapshot,
                ),
            )

    def runs(self) -> list[dict]:
        rows = self._conn().execute("SELECT * FROM runs ORDER BY started_at").fetchall()
        return [dict(r) for r in rows]

    def finish_run(self, run_id: str, summary: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE runs SET ended_at=?, summary=? WHERE run_id=?", (_now(), summary, run_id)
            )

    # --- introspection -------------------------------------------------
    def counts(self, source: str | None = None) -> dict[str, int]:
        conn = self._conn()
        where, params = ("WHERE source = ?", (source,)) if source else ("", ())
        seen = conn.execute(f"SELECT COUNT(*) c FROM seen {where}", params).fetchone()["c"]
        fails = conn.execute(
            f"SELECT COUNT(*) c FROM failures {where + (' AND' if where else 'WHERE')} resolved=0",
            params,
        ).fetchone()["c"]
        hashes = conn.execute(f"SELECT COUNT(*) c FROM hashes {where}", params).fetchone()["c"]
        return {"seen": seen, "open_failures": fails, "unique_hashes": hashes}
