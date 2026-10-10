import json
import urllib.request
from typing import Any

import pytest

from caseguard_ai.gateway import check
from caseguard_ai.gateway.check import Provider, build_request, run

NIM = Provider(
    "generation",
    "https://integrate.api.nvidia.com/v1",
    "nvidia/nemotron-3-super-120b-a12b",
    "nvapi-secret",
)


def test_url_joins_with_or_without_trailing_slash() -> None:
    gemini = Provider(
        "generation", "https://generativelanguage.googleapis.com/v1beta/openai/", "m", "k"
    )
    assert (
        gemini.url("chat/completions")
        == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    )
    assert NIM.url("/models") == "https://integrate.api.nvidia.com/v1/models"


def test_chat_request_has_bearer_key_and_json_body() -> None:
    req = build_request(NIM, "chat/completions", {"model": NIM.model})
    assert req.get_method() == "POST"
    assert req.get_header("Authorization") == "Bearer nvapi-secret"
    assert json.loads(req.data) == {"model": NIM.model}  # type: ignore[arg-type]


def test_no_key_sends_no_auth_header() -> None:
    ollama = Provider("generation", "http://localhost:11434/v1", "llama3.2", "")
    assert build_request(ollama, "models", None).get_header("Authorization") is None


def test_rejects_non_http_base_url() -> None:
    with pytest.raises(ValueError):
        build_request(Provider("generation", "file:///etc", "m", ""), "models", None)


def test_run_prints_reply_and_hides_key(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def fake_send(req: urllib.request.Request, timeout: float) -> Any:
        return {"choices": [{"message": {"content": " OK "}}]}

    monkeypatch.setattr(check, "_send", fake_send)
    assert run(NIM, list_models=False) == 0
    out = capsys.readouterr().out
    assert "integrate.api.nvidia.com" in out and "reply='OK'" in out
    assert "nvapi-secret" not in out


def test_run_lists_models(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(check, "_send", lambda req, timeout: {"data": [{"id": "b"}, {"id": "a"}]})
    assert run(NIM, list_models=True) == 0
    assert capsys.readouterr().out.splitlines()[1:] == ["  a", "  b"]


def test_run_explains_missing_config(capsys: pytest.CaptureFixture[str]) -> None:
    assert run(Provider("judge", "", "", ""), list_models=False) == 2
    assert "LLM_JUDGE_BASE_URL" in capsys.readouterr().err


def test_main_ignores_pnpm_double_dash(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    def fake_run(provider: Provider, *, list_models: bool) -> int:
        seen.update(role=provider.role, list_models=list_models)
        return 0

    monkeypatch.setenv("AI_SERVICE_TOKEN", "t" * 16)
    monkeypatch.setattr(check, "run", fake_run)
    assert check.main(["--", "--list-models", "--role", "judge"]) == 0
    assert seen == {"role": "judge", "list_models": True}
