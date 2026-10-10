"""Per-host politeness limiter: a minimum gap between requests to one host,
plus a global cap on how many requests may be in flight at once."""

from __future__ import annotations

import threading
import time
from urllib.parse import urlparse


class RateLimiter:
    def __init__(self, default_delay: float = 2.0, max_concurrency: int = 2) -> None:
        self.default_delay = default_delay
        self._per_host_delay: dict[str, float] = {}
        self._last_request: dict[str, float] = {}
        self._lock = threading.Lock()
        self._slots = threading.Semaphore(max(1, max_concurrency))

    def set_host_delay(self, url_or_host: str, delay: float) -> None:
        host = self._host(url_or_host)
        with self._lock:
            self._per_host_delay[host] = delay

    def wait(self, url: str) -> float:
        """Block until this host may be hit again. Returns seconds slept."""
        host = self._host(url)
        with self._lock:
            delay = self._per_host_delay.get(host, self.default_delay)
            last = self._last_request.get(host)
            now = time.monotonic()
            sleep_for = 0.0 if last is None else max(0.0, delay - (now - last))
            self._last_request[host] = now + sleep_for
        if sleep_for:
            time.sleep(sleep_for)
        return sleep_for

    def penalise(self, url: str, factor: float = 2.0, cap: float = 60.0) -> float:
        """Back off this host after a 429/503. Returns the new delay."""
        host = self._host(url)
        with self._lock:
            current = self._per_host_delay.get(host, self.default_delay)
            new = min(cap, max(current, 1.0) * factor)
            self._per_host_delay[host] = new
        return new

    def slot(self):
        return _Slot(self._slots)

    @staticmethod
    def _host(url_or_host: str) -> str:
        parsed = urlparse(url_or_host)
        return (parsed.netloc or url_or_host).lower()


class _Slot:
    def __init__(self, sem: threading.Semaphore) -> None:
        self._sem = sem

    def __enter__(self):
        self._sem.acquire()
        return self

    def __exit__(self, *exc):
        self._sem.release()
        return False
