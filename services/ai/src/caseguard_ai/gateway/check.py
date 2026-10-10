"""Check that a configured model provider answers, before the full gateway (#21) exists.

    uv run python -m caseguard_ai.gateway.check                 # LLM_GENERATION_* role
    uv run python -m caseguard_ai.gateway.check --role judge    # LLM_JUDGE_* role
    uv run python -m caseguard_ai.gateway.check --list-models   # what the key can use

Sends one tiny chat completion (or lists models) and prints the result. The API key is
never printed. Works for any OpenAI-compatible provider: NVIDIA NIM, Gemini, Groq,
OpenRouter, OpenAI, Anthropic, Ollama.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from caseguard_ai.config import Settings, get_settings

PROMPT = "Reply with the single word OK."
# Reasoning models (Nemotron, gpt-oss, DeepSeek R-series...) spend tokens thinking before
# they answer. With a tiny budget they hit the limit with empty content, so leave room.
MAX_TOKENS = 512


@dataclass(frozen=True)
class Provider:
    role: str
    base_url: str
    model: str
    api_key: str

    @classmethod
    def from_settings(cls, settings: Settings, role: str) -> "Provider":
        if role == "judge":
            return cls(
                role,
                settings.llm_judge_base_url,
                settings.llm_judge_model,
                settings.llm_judge_api_key.get_secret_value(),
            )
        return cls(
            role,
            settings.llm_generation_base_url,
            settings.llm_generation_model,
            settings.llm_generation_api_key.get_secret_value(),
        )

    def url(self, path: str) -> str:
        return self.base_url.rstrip("/") + "/" + path.lstrip("/")


def build_request(
    provider: Provider, path: str, body: dict[str, Any] | None
) -> urllib.request.Request:
    url = provider.url(path)
    if urlparse(url).scheme not in ("http", "https"):
        raise ValueError(f"base URL must be http(s): {provider.base_url!r}")
    headers = {"Accept": "application/json"}
    if provider.api_key:  # Ollama needs no key
        headers["Authorization"] = f"Bearer {provider.api_key}"
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    return urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")  # noqa: S310  # scheme checked above


def _send(req: urllib.request.Request, timeout: float) -> Any:
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310  # scheme checked in build_request
        return json.load(resp)


def run(provider: Provider, *, list_models: bool, timeout: float = 30.0) -> int:
    prefix = f"LLM_{provider.role.upper()}_"
    if not provider.base_url:
        print(f"{prefix}BASE_URL is empty. Pick a preset from .env.example.", file=sys.stderr)
        return 2
    host = urlparse(provider.base_url).netloc
    try:
        if list_models:
            data = _send(build_request(provider, "models", None), timeout)
            ids = sorted(m.get("id", "?") for m in data.get("data", []))
            print(f"{host}: {len(ids)} models")
            for model_id in ids:
                print(f"  {model_id}")
            return 0

        if not provider.model:
            print(f"{prefix}MODEL is empty. Try --list-models.", file=sys.stderr)
            return 2
        body = {
            "model": provider.model,
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": MAX_TOKENS,
            "temperature": 0,
        }
        started = time.perf_counter()
        data = _send(build_request(provider, "chat/completions", body), timeout)
        elapsed_ms = (time.perf_counter() - started) * 1000
        choice = data["choices"][0]
        message = choice["message"]
        reply = (message.get("content") or "").strip()
        finish = choice.get("finish_reason")
        usage = data.get("usage") or {}
        reasoning_tokens = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
        thought = bool(message.get("reasoning_content") or message.get("reasoning"))
        stats = (
            f"{elapsed_ms:.0f} ms  finish={finish}  tokens={usage.get('completion_tokens', '?')}"
        )
        if reasoning_tokens or thought:
            stats += f" (reasoning={reasoning_tokens if reasoning_tokens is not None else 'yes'})"
        if not reply:
            hint = " The model used its whole budget reasoning." if finish == "length" else ""
            print(
                f"FAIL  {host}  model={provider.model}  {stats}  empty answer.{hint}",
                file=sys.stderr,
            )
            return 1
        print(f"OK  {host}  model={provider.model}  {stats}  reply={reply!r}")
        return 0
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        print(f"FAIL  {host}  HTTP {e.code}: {detail}", file=sys.stderr)
    except TimeoutError:
        print(f"FAIL  {host}  no response within {timeout:.0f} s (try --timeout)", file=sys.stderr)
    except urllib.error.URLError as e:
        if isinstance(e.reason, TimeoutError):
            print(
                f"FAIL  {host}  no response within {timeout:.0f} s (try --timeout)", file=sys.stderr
            )
        else:
            print(f"FAIL  {host}  cannot connect: {e.reason}", file=sys.stderr)
    except (KeyError, IndexError, ValueError) as e:
        print(f"FAIL  {host}  unexpected response: {e}", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--role", choices=["generation", "judge"], default="generation")
    parser.add_argument(
        "--list-models", action="store_true", help="list models instead of chatting"
    )
    parser.add_argument("--timeout", type=float, default=30.0, help="seconds to wait (default 30)")
    args_in = sys.argv[1:] if argv is None else argv
    # `pnpm llm:check -- --flag` forwards the `--` literally; drop it.
    args = parser.parse_args([a for a in args_in if a != "--"])
    provider = Provider.from_settings(get_settings(), args.role)
    return run(provider, list_models=args.list_models, timeout=args.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
