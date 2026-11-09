"""robots.txt gate.

Policy: if robots.txt disallows a path, we do not fetch it. There is no
override flag for this in the crawler itself -- a source that is disallowed is
marked `blocked_by_robots` in config.py and ships disabled, and enabling it is
a deliberate decision recorded there plus written permission from the site
owner.
"""

from __future__ import annotations

import ssl
import threading
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

from utils.logging_config import get_logger
from utils.tls import ssl_context

log = get_logger("robots")


class RobotsCache:
    def __init__(self, user_agent: str, enabled: bool = True, timeout: float = 15.0) -> None:
        self.user_agent = user_agent
        self.enabled = enabled
        self.timeout = timeout
        self._parsers: dict[str, RobotFileParser | None] = {}
        # Hosts whose certificate failed verification on robots.txt: nothing is fetched from them.
        self._untrusted: set[str] = set()
        self._lock = threading.Lock()

    def _parser_for(self, url: str) -> RobotFileParser | None:
        root = self._root(url)
        with self._lock:
            if root in self._parsers:
                return self._parsers[root]
        parser: RobotFileParser | None = RobotFileParser()
        robots_url = urljoin(root, "/robots.txt")
        parser.set_url(robots_url)
        try:
            request = urllib.request.Request(robots_url, headers={"User-Agent": self.user_agent})
            # Same trust as the main client (certifi + bundled intermediates, #147). Always verified.
            with urllib.request.urlopen(  # noqa: S310 (robots_url is http(s), built from the URL)
                request, timeout=self.timeout, context=ssl_context()
            ) as resp:
                body = resp.read().decode("utf-8", errors="replace")
            parser.parse(body.splitlines())
            log.info("Loaded robots.txt for %s", root)
        except (urllib.error.URLError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            if isinstance(reason, ssl.SSLCertVerificationError):
                # Not "no robots.txt": the host can't be trusted. Fail closed (NFR-14).
                log.warning(
                    "robots.txt for %s failed TLS verification (%s); skipping host", root, exc
                )
                with self._lock:
                    self._untrusted.add(root)
            else:
                # No robots.txt (or unreachable) == nothing disallowed.
                log.info("No usable robots.txt for %s (%s); treating as allow-all", root, exc)
            parser = None
        with self._lock:
            self._parsers[root] = parser
        return parser

    def allowed(self, url: str) -> bool:
        if not self.enabled:
            return True
        parser = self._parser_for(url)
        if self._root(url) in self._untrusted:
            return False
        if parser is None:
            return True
        return parser.can_fetch(self.user_agent, url)

    @staticmethod
    def _root(url: str) -> str:
        parsed = urlparse(url)
        return f"{parsed.scheme}://{parsed.netloc}"

    def crawl_delay(self, url: str) -> float | None:
        if not self.enabled:
            return None
        parser = self._parser_for(url)
        if parser is None:
            return None
        try:
            value = parser.crawl_delay(self.user_agent)
            return float(value) if value is not None else None
        except (AttributeError, TypeError, ValueError):
            return None
