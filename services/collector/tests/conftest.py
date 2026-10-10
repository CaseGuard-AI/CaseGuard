import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def tmp_settings(tmp_path):
    from config import Settings
    settings = Settings()
    settings.output_dir = tmp_path / "data"
    settings.request_delay = 0.0
    settings.ensure_dirs()
    return settings


@pytest.fixture
def state(tmp_settings):
    from storage.state_store import StateStore
    store = StateStore(tmp_settings.state_db)
    yield store
    store.close()


@pytest.fixture
def fixture_html():
    def _read(name: str) -> str:
        return (FIXTURES / name).read_text(encoding="utf-8")
    return _read
