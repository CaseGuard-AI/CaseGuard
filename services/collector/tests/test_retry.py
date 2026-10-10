"""Retry, backoff, robots and conditional-request behaviour of HttpClient."""

import httpx
import pytest

from utils.http_client import FetchError, HttpClient, RobotsDisallowed
from utils.rate_limiter import RateLimiter


def make_client(handler, **kwargs) -> HttpClient:
    client = HttpClient(
        user_agent="test-agent",
        retry_count=kwargs.pop("retry_count", 3),
        backoff_base=1.0,
        backoff_cap=0.01,
        respect_robots=kwargs.pop("respect_robots", False),
        rate_limiter=RateLimiter(default_delay=0.0, max_concurrency=4),
        **kwargs,
    )
    client._client = httpx.Client(transport=httpx.MockTransport(handler),
                                  follow_redirects=True)
    return client


def test_success_first_try():
    calls = []

    def handler(request):
        calls.append(request.url)
        return httpx.Response(200, text="<html>ok</html>",
                              headers={"content-type": "text/html"})

    with make_client(handler) as client:
        response = client.get("https://example.gov.pk/a")
    assert response.status_code == 200
    assert "ok" in response.text
    assert len(calls) == 1


def test_retries_then_succeeds_on_500():
    attempts = {"n": 0}

    def handler(request):
        attempts["n"] += 1
        if attempts["n"] < 3:
            return httpx.Response(500)
        return httpx.Response(200, text="recovered")

    with make_client(handler) as client:
        response = client.get("https://example.gov.pk/flaky")
    assert attempts["n"] == 3
    assert response.text == "recovered"
    assert client.stats["retries"] == 2


def test_gives_up_after_retry_count():
    attempts = {"n": 0}

    def handler(request):
        attempts["n"] += 1
        return httpx.Response(503)

    with make_client(handler, retry_count=2) as client:
        with pytest.raises(FetchError):
            client.get("https://example.gov.pk/down")
    assert attempts["n"] == 3               # first try + 2 retries


def test_404_is_not_retried():
    attempts = {"n": 0}

    def handler(request):
        attempts["n"] += 1
        return httpx.Response(404)

    with make_client(handler) as client:
        with pytest.raises(FetchError) as info:
            client.get("https://example.gov.pk/missing")
    assert attempts["n"] == 1
    assert info.value.status == 404


def test_403_is_not_retried():
    def handler(request):
        return httpx.Response(403)

    with make_client(handler) as client:
        with pytest.raises(FetchError) as info:
            client.get("https://example.gov.pk/blocked")
    assert info.value.status == 403


def test_429_increases_the_host_delay():
    def handler(request):
        return httpx.Response(429, headers={"retry-after": "0"})

    with make_client(handler, retry_count=1) as client:
        with pytest.raises(FetchError):
            client.get("https://slow.gov.pk/x")
        assert client.rate_limiter._per_host_delay["slow.gov.pk"] > 0


def test_transport_errors_are_retried():
    attempts = {"n": 0}

    def handler(request):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise httpx.ConnectError("connection reset")
        return httpx.Response(200, text="ok")

    with make_client(handler) as client:
        assert client.get("https://example.gov.pk/x").text == "ok"
    assert attempts["n"] == 2


def test_304_is_reported_as_not_modified():
    def handler(request):
        assert request.headers["if-none-match"] == 'W/"v1"'
        return httpx.Response(304)

    with make_client(handler) as client:
        response = client.get("https://example.gov.pk/a", etag='W/"v1"')
    assert response.not_modified is True
    assert client.stats["not_modified"] == 1


def test_robots_disallow_blocks_the_request(monkeypatch):
    def handler(request):
        return httpx.Response(200, text="should not be reached")

    client = make_client(handler, respect_robots=True)
    monkeypatch.setattr(client.robots, "allowed", lambda url: False)
    with pytest.raises(RobotsDisallowed):
        client.get("https://disallowed.gov.pk/x")
    client.close()


def test_pdf_detection_by_magic_bytes():
    def handler(request):
        return httpx.Response(200, content=b"%PDF-1.7 body",
                              headers={"content-type": "application/octet-stream"})

    with make_client(handler) as client:
        assert client.get("https://example.gov.pk/a.pdf").is_pdf is True
