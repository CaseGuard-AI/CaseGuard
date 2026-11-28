"""Document ingestion (#253, ADR-0010): the ai.v1 `ingestion` routes, the pipeline and the worker.

The pure stages run everywhere. The round trips into ai.case_chunks need AI_TEST_DATABASE_URL
(set in CI) and use HashEmbedder, so no model is downloaded. OCR is switched off in these tests
(``no_ocr``): CI has no tesseract binary, and the outcome must not depend on the machine.
"""

from __future__ import annotations

import asyncio
import io
import os
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pymupdf
import pytest
from docx import Document
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.exc import ProgrammingError

from caseguard_ai.api import deps
from caseguard_ai.config import get_document_settings, get_settings
from caseguard_ai.ingest import documents, ingestion
from caseguard_ai.ingest.chunker import Chunk
from caseguard_ai.ingest.embedder import HashEmbedder
from caseguard_ai.main import app
from tests.conftest import TOKEN
from tests.test_answer import conforms

AI_URL = os.environ.get("AI_TEST_DATABASE_URL")
db = pytest.mark.skipif(not AI_URL, reason="needs AI_TEST_DATABASE_URL (set in CI)")
AUTH = {"Authorization": f"Bearer {TOKEN}"}

PARAGRAPHS = [
    "1. The petitioner was arrested on 3 March 2024 under section 9 of the Control of "
    "Narcotic Substances Act and has been in custody since then without a charge.",
    "2. Learned counsel argues that the recovery was not witnessed by any independent "
    "person and that the delay in sending the samples is fatal to the prosecution case.",
]


@pytest.fixture
def no_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(documents, "ocr_available", lambda: False)


def make_pdf(pages: list[str], **save: Any) -> bytes:
    """A PDF with one text page per entry; an empty entry is a page with no text layer."""
    doc = pymupdf.open()
    for body in pages:
        page = doc.new_page()
        if body:
            page.insert_textbox(pymupdf.Rect(50, 50, 550, 800), body, fontsize=10)
    out = doc.tobytes(**save)
    doc.close()
    return bytes(out)


def make_docx() -> bytes:
    document = Document()
    for para in PARAGRAPHS:
        document.add_paragraph(para)
    table = document.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "FIR No."
    table.rows[0].cells[1].text = "112/2024"
    out = io.BytesIO()
    document.save(out)
    return out.getvalue()


# ── the pure stages ────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("data", "media_type"),
    [
        (b"%PDF-1.7\n", documents.PDF),
        (b"PK\x03\x04rest", documents.DOCX),
        (b"\x89PNG\r\n\x1a\nrest", "image/png"),
        (b"\xff\xd8\xff\xe0", "image/jpeg"),
        (b"II*\x00", "image/tiff"),
        (b"MM\x00*", "image/tiff"),
        (b"hello", None),
    ],
)
def test_sniff_reads_the_first_bytes(data: bytes, media_type: str | None) -> None:
    assert documents.sniff(data) == media_type


def test_a_file_that_is_not_its_declared_type_is_refused() -> None:
    with pytest.raises(documents.DocumentError) as err:
        documents.open_document(b"%PDF-1.7", documents.DOCX)
    assert err.value.stage == "extract"
    assert not err.value.retryable


def test_blob_keys_cannot_leave_the_uploads_folder(tmp_path: Path) -> None:
    key = f"users/{uuid.uuid4()}/cases/{uuid.uuid4()}/{uuid.uuid4()}"
    assert ingestion.blob_path(tmp_path, key).is_relative_to(tmp_path.resolve())
    for bad in ("../../etc/passwd", "users/../../x", ""):
        with pytest.raises(ValueError, match="invalid blob key"):
            ingestion.blob_path(tmp_path, bad)


def test_a_pdf_page_without_a_text_layer_is_flagged_when_ocr_is_off(no_ocr: None) -> None:
    opened = documents.open_document(make_pdf(["\n\n".join(PARAGRAPHS), ""]), documents.PDF)
    assert opened.page_count == 2
    assert [p.needs_ocr for p in opened.pages] == [False, True]
    state, flags = documents.run_ocr(opened)
    assert state == "flagged"
    assert [(f["code"], f["page"], f["stage"]) for f in flags] == [("unreadable_page", 2, "ocr")]


def test_ocr_is_skipped_when_every_page_has_text(no_ocr: None) -> None:
    opened = documents.open_document(make_pdf(["\n\n".join(PARAGRAPHS)]), documents.PDF)
    assert documents.run_ocr(opened) == ("skipped", [])


def test_a_scan_with_no_text_at_all_fails_with_no_text(no_ocr: None) -> None:
    opened = documents.open_document(b"\x89PNG\r\n\x1a\n", "image/png")
    documents.run_ocr(opened)
    with pytest.raises(documents.DocumentError) as err:
        documents.extract(opened)
    assert err.value.flags[0]["code"] == "no_text"


def test_a_password_protected_pdf_fails_as_encrypted() -> None:
    data = make_pdf(["secret"], encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="u", owner_pw="o")
    with pytest.raises(documents.DocumentError) as err:
        documents.open_document(data, documents.PDF)
    assert err.value.flags[0]["code"] == "encrypted_file"
    assert not err.value.retryable


def test_docx_keeps_paragraphs_and_table_rows_in_order() -> None:
    opened = documents.open_document(make_docx(), documents.DOCX)
    assert opened.page_count is None
    body = opened.pages[0].text
    assert body.index("petitioner") < body.index("FIR No. | 112/2024")


def test_clean_drops_running_headers_and_joins_hyphenated_words() -> None:
    pages = [
        (n, f"HIGH COURT OF SINDH\nThe accused was ar-\nrested on day {n}.\nPage {n}")
        for n in range(1, 5)
    ]
    cleaned = documents.clean(documents.Text(pages), max_chars=10_000)
    assert cleaned.pages[0] == (1, "The accused was arrested on day 1.")
    assert cleaned.flags == []


def test_clean_cuts_an_over_long_text_and_flags_it() -> None:
    cleaned = documents.clean(documents.Text([(1, "a " * 100), (2, "b " * 100)]), max_chars=150)
    assert len(cleaned.full) <= 150
    assert [f["code"] for f in cleaned.flags] == ["truncated"]


def test_a_mostly_urdu_document_is_flagged_not_english() -> None:
    urdu = documents.Text([(1, "درخواست ضمانت بعد از گرفتاری منظور کی جاتی ہے")])
    assert [f["code"] for f in documents.structure(urdu)] == ["not_english"]
    assert documents.structure(documents.Text([(1, PARAGRAPHS[0])])) == []


def test_chunks_are_located_by_page_and_paragraph() -> None:
    text = documents.Text([(1, PARAGRAPHS[0]), (2, PARAGRAPHS[1])])
    pieces = documents.chunk(text, "order.pdf")
    assert pieces and pieces[0].locator == "pp. 1-2, paras 1-2"
    single = documents.chunk(documents.Text([(None, PARAGRAPHS[0])]), "brief.docx")
    assert single[0].locator == "para 1"


# ── the routes, without a database ─────────────────────────────────────────────────────────


def body(
    *,
    user: uuid.UUID | None = None,
    case: uuid.UUID | None = None,
    document: uuid.UUID | None = None,
    **overrides: Any,
) -> tuple[uuid.UUID, dict[str, Any]]:
    user, case, document = user or uuid.uuid4(), case or uuid.uuid4(), document or uuid.uuid4()
    return document, {
        "scope": {
            "userId": str(user),
            "accountId": str(uuid.uuid4()),
            "allowedCaseIds": [str(case)],
        },
        "caseId": str(case),
        "storageKey": f"users/{user}/cases/{case}/{document}",
        "mediaType": documents.PDF,
        "filename": "order.pdf",
        "attempt": 1,
        **overrides,
    }


@pytest.mark.parametrize(
    "change",
    [
        {"storageKey": f"users/{uuid.uuid4()}/cases/{uuid.uuid4()}/{uuid.uuid4()}"},
        {
            "scope": {
                "userId": str(uuid.uuid4()),
                "accountId": str(uuid.uuid4()),
                "allowedCaseIds": [],
            }
        },
        {"mediaType": "text/plain"},
        {"attempt": 0},
        {"filename": ""},
        {"extra": True},
    ],
)
def test_start_ingestion_rejects_bad_requests(client: TestClient, change: dict[str, Any]) -> None:
    document, payload = body()
    res = client.post(
        f"/ai/v1/documents/{document}/ingestion", json={**payload, **change}, headers=AUTH
    )
    assert res.status_code == 400
    assert res.headers["content-type"].startswith("application/problem+json")


def test_the_ingestion_routes_need_the_service_token(client: TestClient) -> None:
    document, payload = body()
    assert client.post(f"/ai/v1/documents/{document}/ingestion", json=payload).status_code == 401
    assert client.get(f"/ai/v1/documents/{document}/ingestion").status_code == 401
    assert client.delete(f"/ai/v1/documents/{document}").status_code == 401


# ── round trips into ai.case_chunks ────────────────────────────────────────────────────────


@pytest.fixture
def engine() -> Iterator[Engine]:
    from tests.test_graph import migrated_engine

    eng = migrated_engine()
    with eng.begin() as conn:
        conn.execute(text("TRUNCATE ai.ingestions, ai.case_chunks"))
    yield eng
    with eng.begin() as conn:
        conn.execute(text("TRUNCATE ai.ingestions, ai.case_chunks"))
    eng.dispose()


@pytest.fixture
def uploads(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    monkeypatch.setenv("UPLOADS_DIR", str(tmp_path))
    get_document_settings.cache_clear()
    yield tmp_path
    get_document_settings.cache_clear()


@pytest.fixture
def api(engine: Engine, uploads: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("AI_SERVICE_TOKEN", TOKEN)
    get_settings.cache_clear()
    app.dependency_overrides[deps.get_engine] = lambda: engine
    app.dependency_overrides[deps.get_embedder] = HashEmbedder
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    get_settings.cache_clear()


@pytest.fixture
def upload(uploads: Path) -> Callable[..., tuple[uuid.UUID, dict[str, Any]]]:
    """Write a file into the blob store and return (documentId, the request for it)."""

    def _upload(data: bytes, **overrides: Any) -> tuple[uuid.UUID, dict[str, Any]]:
        document, payload = body(**overrides)
        path = ingestion.blob_path(uploads, payload["storageKey"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return document, payload

    return _upload


def run_queue(engine: Engine) -> int:
    return ingestion.run_queue(engine, HashEmbedder, get_document_settings())


def chunks(engine: Engine, document: uuid.UUID) -> list[Any]:
    with engine.connect() as conn:
        return list(
            conn.execute(
                text(
                    "SELECT user_id, case_id, ordinal, locator, chunker_version, "
                    "embedding IS NOT NULL AS embedded FROM ai.case_chunks "
                    "WHERE document_id = :d ORDER BY ordinal"
                ),
                {"d": document},
            )
        )


def post(api: TestClient, document: uuid.UUID, payload: dict[str, Any]) -> Any:
    return api.post(f"/ai/v1/documents/{document}/ingestion", json=payload, headers=AUTH)


def get(api: TestClient, document: uuid.UUID) -> Any:
    return api.get(f"/ai/v1/documents/{document}/ingestion", headers=AUTH)


@db
def test_a_pdf_is_indexed_into_case_chunks_with_its_scope(
    api: TestClient, engine: Engine, upload: Callable[..., Any], no_ocr: None
) -> None:
    user, case = uuid.uuid4(), uuid.uuid4()
    document, payload = upload(make_pdf(["\n\n".join(PARAGRAPHS), ""]), user=user, case=case)

    res = post(api, document, payload)
    assert res.status_code == 202
    queued = res.json()
    conforms("IngestionStatus", queued)
    assert queued["state"] == "queued"
    assert [s["stage"] for s in queued["stages"]] == list(documents.STAGES)
    assert {s["state"] for s in queued["stages"]} == {"pending"}

    assert run_queue(engine) == 1
    status = get(api, document).json()
    conforms("IngestionStatus", status)
    # Page 2 is a scan and OCR is off: the document is retrievable, with that page flagged.
    assert status["state"] == "flagged"
    assert status["pages"] == 2
    assert [(f["code"], f["page"]) for f in status["flags"]] == [("unreadable_page", 2)]
    by_stage = {s["stage"]: s["state"] for s in status["stages"]}
    assert by_stage == {
        "ocr": "flagged",
        "extract": "done",
        "clean": "done",
        "structure": "done",
        "chunk": "done",
        "embed": "done",
        "index": "done",
    }
    assert all(s["startedAt"] and s["finishedAt"] for s in status["stages"])
    assert status["error"] is None and status["retryable"] is False

    rows = chunks(engine, document)
    assert status["chunkCount"] == len(rows) >= 1
    assert {(r.user_id, r.case_id) for r in rows} == {(user, case)}
    assert all(r.embedded for r in rows)
    assert rows[0].locator.startswith("p. 1")


@db
def test_a_docx_is_indexed_and_done(
    api: TestClient, engine: Engine, upload: Callable[..., Any]
) -> None:
    document, payload = upload(make_docx(), mediaType=documents.DOCX, filename="brief.docx")
    post(api, document, payload)
    run_queue(engine)
    status = get(api, document).json()
    conforms("IngestionStatus", status)
    assert status["state"] == "done"
    assert status["pages"] is None
    assert next(s for s in status["stages"] if s["stage"] == "ocr")["state"] == "skipped"
    assert status["chunkCount"] == len(chunks(engine, document)) >= 1


@db
def test_the_same_attempt_twice_changes_nothing(
    api: TestClient, engine: Engine, upload: Callable[..., Any]
) -> None:
    document, payload = upload(make_docx(), mediaType=documents.DOCX)
    post(api, document, payload)
    run_queue(engine)
    done = get(api, document).json()
    again = post(api, document, payload)
    assert again.status_code == 202
    assert again.json() == done
    assert run_queue(engine) == 0


@db
def test_a_lower_attempt_is_a_409(
    api: TestClient, engine: Engine, upload: Callable[..., Any]
) -> None:
    document, payload = upload(make_docx(), mediaType=documents.DOCX, attempt=2)
    assert post(api, document, payload).status_code == 202
    res = post(api, document, {**payload, "attempt": 1})
    assert res.status_code == 409
    assert res.headers["content-type"].startswith("application/problem+json")


@db
def test_a_higher_attempt_supersedes_and_old_chunks_stay_until_it_indexes(
    api: TestClient, engine: Engine, upload: Callable[..., Any]
) -> None:
    document, payload = upload(make_docx(), mediaType=documents.DOCX)
    post(api, document, payload)
    run_queue(engine)
    before = chunks(engine, document)

    queued = post(api, document, {**payload, "attempt": 2}).json()
    assert (queued["attempt"], queued["state"], queued["chunkCount"]) == (2, "queued", None)
    assert chunks(engine, document) == before  # still retrievable meanwhile

    run_queue(engine)
    status = get(api, document).json()
    assert (status["attempt"], status["state"]) == (2, "done")
    assert len(chunks(engine, document)) == len(before)


@db
def test_a_running_attempt_stops_when_a_newer_one_arrives(
    api: TestClient, engine: Engine, upload: Callable[..., Any]
) -> None:
    document, payload = upload(make_docx(), mediaType=documents.DOCX)
    post(api, document, payload)
    running = ingestion.claim(engine)
    assert running is not None and running.state == "running"
    post(api, document, {**payload, "attempt": 2})

    ingestion.Attempt(engine, HashEmbedder(), get_document_settings(), running).run()
    status = get(api, document).json()
    assert (status["attempt"], status["state"]) == (2, "queued")  # attempt 1 wrote nothing
    assert chunks(engine, document) == []


@db
def test_an_attempt_cut_off_by_a_restart_is_failed_and_retryable(
    api: TestClient, engine: Engine, upload: Callable[..., Any]
) -> None:
    document, payload = upload(make_docx(), mediaType=documents.DOCX)
    post(api, document, payload)
    assert ingestion.claim(engine) is not None  # the process dies here
    assert ingestion.recover(engine) == 1
    status = get(api, document).json()
    conforms("IngestionStatus", status)
    assert (status["state"], status["retryable"]) == ("failed", True)
    assert status["error"] == ingestion.INTERRUPTED


@db
def test_purge_removes_chunks_and_state_and_is_idempotent(
    api: TestClient, engine: Engine, upload: Callable[..., Any]
) -> None:
    document, payload = upload(make_docx(), mediaType=documents.DOCX)
    post(api, document, payload)
    run_queue(engine)
    assert chunks(engine, document)

    assert api.delete(f"/ai/v1/documents/{document}", headers=AUTH).status_code == 204
    assert chunks(engine, document) == []
    assert get(api, document).status_code == 404
    assert api.delete(f"/ai/v1/documents/{document}", headers=AUTH).status_code == 204
    assert api.delete(f"/ai/v1/documents/{uuid.uuid4()}", headers=AUTH).status_code == 204


@db
def test_an_unknown_document_is_a_404(api: TestClient) -> None:
    res = get(api, uuid.uuid4())
    assert res.status_code == 404
    assert res.headers["content-type"].startswith("application/problem+json")


@db
@pytest.mark.parametrize(
    ("data", "media_type", "code"),
    [
        (None, documents.PDF, None),  # the blob is missing
        (b"not a pdf", documents.PDF, None),
        (
            make_pdf(["secret"], encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="u", owner_pw="o"),
            documents.PDF,
            "encrypted_file",
        ),
    ],
)
def test_a_bad_file_fails_and_is_not_retryable(
    api: TestClient,
    engine: Engine,
    upload: Callable[..., Any],
    data: bytes | None,
    media_type: str,
    code: str | None,
) -> None:
    if data is None:
        document, payload = body()
    else:
        document, payload = upload(data, mediaType=media_type)
    post(api, document, payload)
    run_queue(engine)
    status = get(api, document).json()
    conforms("IngestionStatus", status)
    assert (status["state"], status["retryable"], status["chunkCount"]) == ("failed", False, None)
    assert status["error"]
    assert next(s for s in status["stages"] if s["stage"] == "extract")["state"] == "failed"
    assert [f["code"] for f in status["flags"]] == ([code] if code else [])
    assert chunks(engine, document) == []


@db
def test_the_background_worker_processes_a_submitted_document(
    engine: Engine, upload: Callable[..., Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("INGEST_WORKERS_ENABLED", "true")
    monkeypatch.setenv("INGEST_POLL_SECONDS", "0.05")
    monkeypatch.setenv("AI_SERVICE_TOKEN", TOKEN)
    get_document_settings.cache_clear()
    get_settings.cache_clear()
    document, payload = upload(make_docx(), mediaType=documents.DOCX)
    app.dependency_overrides[deps.get_engine] = lambda: engine
    app.dependency_overrides[deps.get_embedder] = HashEmbedder
    try:
        with TestClient(app) as api:
            assert post(api, document, payload).status_code == 202
            deadline = time.monotonic() + 20
            while get(api, document).json()["state"] in ("queued", "running"):
                assert time.monotonic() < deadline, "the worker never finished"
                time.sleep(0.05)
            assert get(api, document).json()["state"] == "done"
    finally:
        app.dependency_overrides.clear()
        get_document_settings.cache_clear()
        get_settings.cache_clear()


# ── review fixes (PR #256), one regression test each ───────────────────────────────────────


def _fake_ocr(calls: list[str]) -> Callable[[bytes], tuple[str, float]]:
    def ocr_page(image: bytes) -> tuple[str, float]:
        assert image.startswith(b"\x89PNG")
        calls.append("ocr")
        return "Recognised text of a scanned page, clearly read.", 95.0

    return ocr_page


def _count_renders(opened: documents.Opened, calls: list[str]) -> None:
    for page in opened.pages:
        if page.render is not None:
            inner = page.render

            def render(inner: Callable[[], bytes] = inner) -> bytes:
                calls.append("render")
                return inner()

            page.render = render


def test_scanned_pdf_pages_are_rendered_one_at_a_time(monkeypatch: pytest.MonkeyPatch) -> None:
    # 1: no page image exists until OCR reaches that page, and each is OCR'd before the next.
    monkeypatch.setattr(documents, "ocr_available", lambda: True)
    calls: list[str] = []
    monkeypatch.setattr(documents, "ocr_page", _fake_ocr(calls))
    with documents.open_document(make_pdf(["", "", ""]), documents.PDF) as opened:
        assert all(p.needs_ocr and p.render for p in opened.pages)
        assert not any(hasattr(p, "image") for p in opened.pages)
        _count_renders(opened, calls)
        assert documents.run_ocr(opened) == ("done", [])
    assert calls == ["render", "ocr"] * 3


def test_tiff_frames_are_rendered_one_at_a_time(monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image

    monkeypatch.setattr(documents, "ocr_available", lambda: True)
    out = io.BytesIO()
    first, second = Image.new("RGB", (40, 20), "white"), Image.new("RGB", (30, 60), "white")
    first.save(out, format="TIFF", save_all=True, append_images=[second])
    with documents.open_document(out.getvalue(), "image/tiff") as opened:
        assert opened.page_count == 2
        sizes = []
        for page in opened.pages:
            assert page.render is not None
            sizes.append(Image.open(io.BytesIO(page.render())).size)
    assert sizes == [(40, 20), (30, 60)]


def test_ocr_stops_between_pages_when_asked(monkeypatch: pytest.MonkeyPatch) -> None:
    # 4: a newer attempt, a purge or shutdown stops OCR at the next page.
    monkeypatch.setattr(documents, "ocr_available", lambda: True)
    calls: list[str] = []
    monkeypatch.setattr(documents, "ocr_page", _fake_ocr(calls))

    def check() -> None:
        if calls:
            raise ingestion.Superseded

    with documents.open_document(make_pdf(["", "", ""]), documents.PDF) as opened:
        with pytest.raises(ingestion.Superseded):
            documents.run_ocr(opened, check)
    assert calls == ["ocr"]


def _worker(monkeypatch: pytest.MonkeyPatch, seconds: float, shutdown: float) -> list[str]:
    """A worker whose attempts take ``seconds`` each; returns its event log."""
    events: list[str] = []
    started = threading.Event()

    def slow(*_: Any) -> bool:
        events.append("start")
        started.set()
        time.sleep(seconds)
        events.append("end")
        return True

    monkeypatch.setattr(ingestion, "recover", lambda _engine: 0)
    monkeypatch.setattr(ingestion, "run_once", slow)
    settings = ingestion.DocumentSettings(
        ingest_poll_seconds=0.01, ingest_shutdown_seconds=shutdown
    )

    async def main() -> None:
        worker = ingestion.Worker(lambda: None, HashEmbedder, settings)  # type: ignore[arg-type,return-value]
        worker.start()
        await asyncio.to_thread(started.wait, 5)
        began = time.monotonic()
        await worker.close()
        events.append(f"closed after {time.monotonic() - began:.2f}")

    asyncio.run(main())
    return events


def test_worker_close_waits_for_the_attempt_in_flight(monkeypatch: pytest.MonkeyPatch) -> None:
    # 4: close() no longer cancels the task while its thread keeps running.
    events = _worker(monkeypatch, seconds=0.3, shutdown=5)
    assert events[:2] == ["start", "end"]
    assert events[2].startswith("closed")
    assert events.count("start") == 1  # nothing new is claimed once stop is set


def test_worker_close_gives_up_after_the_shutdown_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    events = _worker(monkeypatch, seconds=1.0, shutdown=0.1)
    closed = next(e for e in events if e.startswith("closed"))
    assert float(closed.split()[-1]) < 0.8


def test_clean_removes_furniture_only_at_page_edges() -> None:
    # 2: a bare number mid-page (a paragraph number, a year, an amount) is not a page number.
    pages = [
        (n, f"IN THE HIGH COURT\nThe sum claimed is\n150000\n12\nas of\n2019\n{n}")
        for n in range(1, 5)
    ]
    cleaned = documents.clean(documents.Text(pages), max_chars=10_000)
    assert cleaned.pages[0] == (1, "The sum claimed is\n150000\n12\nas of\n2019")


@pytest.mark.parametrize(
    ("raw", "joined"),
    [
        ("was ar-\nrested", "was arrested"),
        ("in 2019-\n2020 the", "in 2019-2020 the"),
        ("the Anti-\nTerrorism Act", "the Anti-Terrorism Act"),
    ],
)
def test_hyphen_breaks_join_only_between_lower_case_letters(raw: str, joined: str) -> None:
    # 5: digits or capitals keep their hyphen; only a soft break between lower-case letters goes.
    cleaned = documents.clean(documents.Text([(1, raw)]), max_chars=10_000)
    assert cleaned.pages[0][1] == joined


def test_docx_keeps_adjacent_cells_with_the_same_text_but_merged_cells_once() -> None:
    # 6: dedupe by the cell element, not its text.
    document = Document()
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Nil"
    table.cell(0, 1).text = "Nil"
    table.cell(1, 0).merge(table.cell(1, 1)).text = "Merged"
    out = io.BytesIO()
    document.save(out)
    opened = documents.open_document(out.getvalue(), documents.DOCX)
    lines = opened.pages[0].text.split("\n")
    assert "Nil | Nil" in lines
    assert "Merged" in lines


def test_no_text_mentions_scans_only_when_a_page_needed_ocr(no_ocr: None) -> None:
    # 7: an empty Word file or text PDF is not "a scan".
    out = io.BytesIO()
    Document().save(out)
    with pytest.raises(documents.DocumentError) as err:
        documents.extract(documents.open_document(out.getvalue(), documents.DOCX))
    assert "scan" not in err.value.message
    with documents.open_document(make_pdf([""]), documents.PDF) as scanned:
        with pytest.raises(documents.DocumentError) as err:
            documents.extract(scanned)
    assert "scan" in err.value.message


def test_a_chunk_not_found_after_the_last_one_gets_no_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 8: the old fallback searched from the start and matched page 1's copy of the text.
    repeated = "The same standard paragraph appears on both pages of this order sheet."
    other = "Only the second page carries this sentence about the next hearing date."
    pieces = [
        Chunk(0, other, 12, None, None),
        Chunk(1, repeated, 12, None, None),
    ]
    monkeypatch.setattr(documents, "chunk_document", lambda **_: pieces)
    text = documents.Text([(1, repeated), (2, other)])
    located = documents.chunk(text, "order.pdf")
    assert [c.locator for c in located] == ["p. 2", None]


class _BrokenEngine:
    """An engine whose every connection fails as if ai.ingestions did not exist."""

    def _fail(self) -> Any:
        raise ProgrammingError("SELECT", {}, Exception("relation ai.ingestions does not exist"))

    begin = connect = _fail


def test_any_database_error_is_a_503(client: TestClient) -> None:
    # 9: a ProgrammingError (migration 0003 not applied) was a bare 500.
    app.dependency_overrides[deps.get_engine] = _BrokenEngine
    try:
        document, payload = body()
        for res in (
            client.post(f"/ai/v1/documents/{document}/ingestion", json=payload, headers=AUTH),
            client.get(f"/ai/v1/documents/{document}/ingestion", headers=AUTH),
            client.delete(f"/ai/v1/documents/{document}", headers=AUTH),
        ):
            assert res.status_code == 503
            assert res.headers["content-type"].startswith("application/problem+json")
    finally:
        app.dependency_overrides.clear()


@db
def test_a_retry_keeps_its_place_in_the_queue(
    api: TestClient, engine: Engine, upload: Callable[..., Any]
) -> None:
    # 3: a resubmit no longer goes to the back of the queue while apps/api's deadline runs.
    first, first_payload = upload(make_docx(), mediaType=documents.DOCX)
    second, second_payload = upload(make_docx(), mediaType=documents.DOCX)
    post(api, first, first_payload)
    post(api, second, second_payload)
    post(api, first, {**first_payload, "attempt": 2})
    claimed = ingestion.claim(engine)
    assert claimed is not None
    assert (claimed.document_id, claimed.attempt) == (first, 2)
