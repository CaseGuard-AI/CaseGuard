"""The single door through which every outbound request passes.

Responsibilities:
  * robots.txt check before the request is made
  * per-host politeness delay + global concurrency cap
  * retries with exponential backoff + jitter on transient failures
  * honouring Retry-After on 429/503
  * conditional requests (ETag / Last-Modified) for incremental re-crawls
  * never retrying a 4xx that will never succeed (403/404/410)

Why sync httpx rather than async: we are deliberately hitting a handful of
government hosts at ~1 request every 2-6 seconds. Concurrency is not the
bottleneck, and a sequential client is far easier to reason about, test and
resume. The concurrency knob exists for parallel PDF downloads only.
"""

from __future__ import annotations

import random
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from utils.logging_config import get_logger
from utils.rate_limiter import RateLimiter
from utils.robots import RobotsCache

log = get_logger("http")

RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504, 522, 524}
FATAL_STATUS = {400, 401, 403, 404, 405, 410, 451}


class RobotsDisallowed(Exception):
    """Raised when robots.txt forbids the URL. Never retried."""


class FetchError(Exception):
    def __init__(self, url: str, message: str, status: int | None = None) -> None:
        super().__init__(f"{url}: {message}")
        self.url = url
        self.status = status
        self.message = message


@dataclass
class Response:
    url: str  # final URL after redirects
    requested_url: str
    status_code: int
    content: bytes
    headers: Mapping[str, str]
    elapsed: float
    from_cache: bool = False
    not_modified: bool = False

    @property
    def text(self) -> str:
        encoding = None
        ctype = self.headers.get("content-type", "")
        if "charset=" in ctype:
            encoding = ctype.split("charset=")[-1].split(";")[0].strip()
        for candidate in (encoding, "utf-8", "cp1252", "latin-1"):
            if not candidate:
                continue
            try:
                return self.content.decode(candidate)
            except (UnicodeDecodeError, LookupError):
                continue
        return self.content.decode("utf-8", errors="replace")

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "").split(";")[0].strip().lower()

    @property
    def is_pdf(self) -> bool:
        return self.content_type == "application/pdf" or self.content[:5] == b"%PDF-"

    @property
    def etag(self) -> str | None:
        return self.headers.get("etag")

    @property
    def last_modified(self) -> str | None:
        return self.headers.get("last-modified")


class HttpClient:
    def __init__(
        self,
        user_agent: str,
        timeout: float = 45.0,
        retry_count: int = 4,
        backoff_base: float = 2.0,
        backoff_cap: float = 60.0,
        respect_robots: bool = True,
        verify_tls: bool = True,
        rate_limiter: RateLimiter | None = None,
    ) -> None:
        self.user_agent = user_agent
        self.retry_count = retry_count
        self.backoff_base = backoff_base
        self.backoff_cap = backoff_cap
        self.rate_limiter = rate_limiter or RateLimiter()
        self.robots = RobotsCache(user_agent, enabled=respect_robots)
        self.stats = {
            "requests": 0,
            "retries": 0,
            "bytes": 0,
            "robots_blocked": 0,
            "not_modified": 0,
        }
        self._client = httpx.Client(
            headers={
                "User-Agent": user_agent,
                "Accept": "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9,ur;q=0.6",
                "Connection": "keep-alive",
            },
            timeout=httpx.Timeout(timeout, connect=min(timeout, 20.0)),
            follow_redirects=True,
            verify=verify_tls,
            # Some PK government hosts run older TLS stacks and dislike HTTP/2.
            http2=False,
        )

    # -----------------------------------------------------------------
    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> HttpClient:
        return self

    def __exit__(self, *exc) -> bool:
        self.close()
        return False

    # -----------------------------------------------------------------
    def get(
        self,
        url: str,
        *,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        etag: str | None = None,
        last_modified: str | None = None,
        allow_robots_check: bool = True,
    ) -> Response:
        return self._request(
            "GET",
            url,
            params=params,
            headers=headers,
            etag=etag,
            last_modified=last_modified,
            allow_robots_check=allow_robots_check,
        )

    def post(
        self,
        url: str,
        *,
        data: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        allow_robots_check: bool = True,
    ) -> Response:
        return self._request(
            "POST", url, data=data, headers=headers, allow_robots_check=allow_robots_check
        )

    # -----------------------------------------------------------------
    def _request(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, Any] | None = None,
        data: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        etag: str | None = None,
        last_modified: str | None = None,
        allow_robots_check: bool = True,
    ) -> Response:
        if allow_robots_check and not self.robots.allowed(url):
            self.stats["robots_blocked"] += 1
            raise RobotsDisallowed(f"robots.txt disallows {url}")

        crawl_delay = self.robots.crawl_delay(url)
        if crawl_delay:
            self.rate_limiter.set_host_delay(url, crawl_delay)

        request_headers = dict(headers or {})
        if etag:
            request_headers["If-None-Match"] = etag
        if last_modified:
            request_headers["If-Modified-Since"] = last_modified

        last_error: Exception | None = None
        for attempt in range(self.retry_count + 1):
            with self.rate_limiter.slot():
                self.rate_limiter.wait(url)
                started = time.monotonic()
                try:
                    self.stats["requests"] += 1
                    raw = self._client.request(
                        method,
                        url,
                        params=params,
                        data=data,
                        headers=request_headers or None,
                    )
                except (httpx.TimeoutException, httpx.TransportError, httpx.ProtocolError) as exc:
                    last_error = exc
                    log.warning(
                        "%s %s -> %s (attempt %d/%d)",
                        method,
                        url,
                        type(exc).__name__,
                        attempt + 1,
                        self.retry_count + 1,
                    )
                    if attempt < self.retry_count:
                        self.stats["retries"] += 1
                        self._sleep_backoff(attempt)
                        continue
                    raise FetchError(url, f"transport error: {exc}") from exc

                elapsed = time.monotonic() - started

            if raw.status_code == 304:
                self.stats["not_modified"] += 1
                return Response(
                    str(raw.url), url, 304, b"", raw.headers, elapsed, not_modified=True
                )

            if raw.status_code in FATAL_STATUS:
                raise FetchError(url, f"HTTP {raw.status_code} (not retryable)", raw.status_code)

            if raw.status_code in RETRYABLE_STATUS:
                last_error = FetchError(url, f"HTTP {raw.status_code}", raw.status_code)
                if raw.status_code in (429, 503):
                    new_delay = self.rate_limiter.penalise(url, cap=self.backoff_cap)
                    log.warning(
                        "%s throttled us (HTTP %d); host delay now %.1fs",
                        url,
                        raw.status_code,
                        new_delay,
                    )
                if attempt < self.retry_count:
                    self.stats["retries"] += 1
                    self._sleep_backoff(attempt, raw.headers.get("retry-after"))
                    continue
                raise last_error

            if raw.status_code >= 400:
                raise FetchError(url, f"HTTP {raw.status_code}", raw.status_code)

            self.stats["bytes"] += len(raw.content)
            return Response(str(raw.url), url, raw.status_code, raw.content, raw.headers, elapsed)

        raise FetchError(url, f"exhausted retries: {last_error}")

    # -----------------------------------------------------------------
    def _sleep_backoff(self, attempt: int, retry_after: str | None = None) -> None:
        if retry_after:
            try:
                time.sleep(min(float(retry_after), self.backoff_cap))
                return
            except (TypeError, ValueError):
                pass
        delay = min(self.backoff_cap, self.backoff_base**attempt)
        delay += random.uniform(0, delay * 0.3)  # jitter: avoid lockstep retries
        log.debug("backing off %.1fs", delay)
        time.sleep(delay)
