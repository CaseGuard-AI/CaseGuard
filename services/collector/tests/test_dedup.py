"""Incremental scraping + duplicate detection -- the state store."""


def test_new_url_is_processed_then_skipped(state):
    url = "https://pakistancode.gov.pk/english/a-sg-jjj"
    assert state.should_process(url) is True
    assert state.mark_seen(url, "pakistan_code", content_hash="h1") == "new"
    assert state.should_process(url) is False


def test_force_overrides_seen(state):
    url = "https://x/a"
    state.mark_seen(url, "s", content_hash="h1")
    assert state.should_process(url, force=True) is True


def test_same_hash_reports_unchanged(state):
    url = "https://x/a"
    state.mark_seen(url, "s", content_hash="h1")
    assert state.mark_seen(url, "s", content_hash="h1") == "unchanged"


def test_changed_hash_is_detected_and_bumps_revision(state):
    url = "https://x/a"
    state.mark_seen(url, "s", content_hash="h1")
    assert state.mark_seen(url, "s", content_hash="h2") == "changed"
    assert state.get_seen(url)["revision"] == 2


def test_duplicate_content_across_different_urls(state):
    assert state.register_hash("hash-abc", "doc-1", "s", "https://x/a") is True
    duplicate = state.duplicate_of("hash-abc")
    assert duplicate["document_id"] == "doc-1"
    # a second URL carrying identical text is refused registration
    assert state.register_hash("hash-abc", "doc-2", "s", "https://x/b") is False


def test_none_hash_is_never_treated_as_duplicate(state):
    assert state.duplicate_of(None) is None
    assert state.register_hash(None, "doc-1", "s", "https://x/a") is False


def test_conditional_request_validators_round_trip(state):
    url = "https://x/a"
    state.mark_seen(url, "s", etag='W/"abc"', last_modified="Wed, 01 Jan 2025 00:00:00 GMT")
    etag, last_modified = state.validators_for(url)
    assert etag == 'W/"abc"'
    assert last_modified.startswith("Wed")


def test_failures_are_tracked_and_resolvable(state):
    url = "https://x/broken"
    state.record_failure(url, "s", "HTTP 500")
    state.record_failure(url, "s", "HTTP 500")
    open_failures = state.open_failures("s")
    assert len(open_failures) == 1 and open_failures[0]["attempts"] == 2
    state.clear_failure(url)
    assert state.open_failures("s") == []


def test_counts_reports_per_source(state):
    state.mark_seen("https://x/a", "pakistan_code", content_hash="h")
    state.register_hash("h", "d1", "pakistan_code", "https://x/a")
    counts = state.counts("pakistan_code")
    assert counts["seen"] == 1 and counts["unique_hashes"] == 1
