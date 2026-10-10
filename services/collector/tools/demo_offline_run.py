#!/usr/bin/env python3
"""Offline end-to-end smoke test.

Runs the complete pipeline -- discovery, fetching, PDF download, text
extraction, hashing, duplicate detection, JSONL storage, crawl state and the
validation report -- against a local server that replays the structures
captured from pakistancode.gov.pk. No internet access required.

Use it to prove the plumbing works before you point the crawler at the real
site, and to regenerate the example output in docs/.

    python tools/demo_offline_run.py
"""

from __future__ import annotations

import dataclasses
import http.server
import json
import socketserver
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

FIXTURES = ROOT / "tests" / "fixtures"
BASE_URL = ""  # set once the replay server has a port


def make_pdf(title: str, clause: str) -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 90), title, fontsize=13)
    page.insert_text((72, 130), "AN ACT to provide for the preservation of")
    page.insert_text((72, 150), "archival material and for matters connected")
    page.insert_text((72, 170), "therewith or incidental thereto.")
    page.insert_text((72, 210), clause)
    page.insert_text((72, 240), "It extends to the whole of Pakistan.")
    data = doc.tobytes()
    doc.close()
    return data


class ReplayHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the demo output readable
        pass

    def do_GET(self):  # noqa: N802
        path = self.path
        if "LGu0xAD" in path:
            name = "pakistan_code_index.html" if "alp=A" in path else "pakistan_code_empty.html"
            return self._send((FIXTURES / name).read_text(), "text/html")
        if "-sg-j" in path:
            body = (FIXTURES / "pakistan_code_detail.html").read_text()
            unique = f"{abs(hash(path)) % 10**8:08d}"
            body = body.replace("dfd455a3106327ca3f1c51b7d86c4840", unique)
            # the real page links the PDF absolutely; point it at the replay host
            body = body.replace("https://pakistancode.gov.pk", BASE_URL)
            return self._send(body, "text/html")
        if path.endswith(".pdf"):
            stem = Path(path).stem
            return self._send_bytes(
                make_pdf("THE NATIONAL ARCHIVES ACT, 1993", f"Clause unique to {stem}."),
                "application/pdf",
            )
        self.send_error(404)

    def _send(self, text: str, content_type: str):
        self._send_bytes(text.encode("utf-8"), content_type)

    def _send_bytes(self, data: bytes, content_type: str):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    # A fixed port keeps source_urls stable between runs, so running this twice
    # demonstrates incremental scraping (the second run should skip everything).
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", 8731), ReplayHandler) as server:
        host, port = server.server_address
        base_url = f"http://{host}:{port}"
        globals()["BASE_URL"] = base_url
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        import config
        from config import Settings
        from pipeline.runner import Runner
        from storage.jsonl_storage import JsonlStorage

        # Point the Pakistan Code source at the replay server for this run only.
        config.SOURCES["pakistan_code"] = dataclasses.replace(
            config.SOURCES["pakistan_code"],
            base_url=base_url,
            min_delay_seconds=0.0,
        )

        settings = Settings()
        settings.output_dir = ROOT / "data_demo"
        settings.request_delay = 0.0
        settings.max_pages = 1
        settings.respect_robots = False  # local replay server, no robots
        settings.ensure_dirs()

        print(f"Replay server on {base_url}\n")
        with Runner(settings) as runner:
            report = runner.run(["pakistan_code"])
        print(report.render())

        jsonl = settings.jsonl_dir / "pakistan_code.jsonl"
        rows = list(JsonlStorage.read(jsonl))
        print(f"JSONL written: {jsonl}  ({len(rows)} records)\n")
        if rows:
            docs = ROOT / "docs"
            docs.mkdir(exist_ok=True)
            sample = docs / "example_output.json"
            sample.write_text(
                json.dumps(rows[:2], indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            print(f"Example output written to {sample}")

        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
