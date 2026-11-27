"""Ask a research question from the terminal, the way ``POST /ai/v1/research/answer`` would (#191).

    pnpm research:ask -- "What does the National Archives Act 1993 cover?"
    pnpm research:ask -- "..." --providers nvidia-nim          # the allow-list, as the api sends it
    pnpm research:ask -- "..." --json                          # response, trace and raw reply as JSON
    pnpm research:ask -- "..." --show-prompt                   # the numbered passages the model saw

Runs the same orchestration and the same dependencies as the route (``research.answer`` and
``api.deps``), so the answer, citations and statuses are what the api would return. On top of
that it prints what the route hides: the raw model reply, so a format problem (a missing
``ANSWER:`` block, markers pointing at passages that were never shown) is visible at once.

The question gets a scratch scope with no case ids and a fresh request id; its trace is stored
like any other answer. The API key is never printed.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from datetime import date
from typing import Any

import structlog
from sqlalchemy import Engine, select
from sqlalchemy.exc import OperationalError

from caseguard_ai.api import deps
from caseguard_ai.config import Settings, get_settings
from caseguard_ai.db.tables import answer_traces
from caseguard_ai.gateway.client import ChatResult, GatewayError, ModelGateway, NoProviderError
from caseguard_ai.gateway.providers import ProviderConfig, Role
from caseguard_ai.research.answer import Question, answer_question
from caseguard_ai.retrieval.guard import CorpusNotReady, EmbeddingMismatch
from caseguard_ai.retrieval.hybrid import Scope

# One scratch scope for every terminal question: no cases, so only the corpus is searched.
SCRATCH_USER = uuid.uuid5(uuid.NAMESPACE_URL, "caseguard:research:ask:user")
SCRATCH_ACCOUNT = uuid.uuid5(uuid.NAMESPACE_URL, "caseguard:research:ask:account")
QUOTE_PREVIEW = 160


class RecordingGateway(ModelGateway):
    """The gateway, remembering the last generation call so the CLI can show it."""

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self.last: ChatResult | None = None
        self.last_messages: list[dict[str, str]] = []

    def chat(
        self,
        role: Role,
        messages: list[dict[str, str]],
        allowed_providers: list[str] | None,
        *,
        override: ProviderConfig | None = None,
        max_tokens: int | None = None,
        temperature: float = 0.0,
    ) -> ChatResult:
        result = super().chat(
            role,
            messages,
            allowed_providers,
            override=override,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        if role == "generation":
            self.last, self.last_messages = result, messages
        return result


def build_gateway(settings: Settings) -> RecordingGateway:
    return RecordingGateway(settings)


def read_trace(engine: Engine, request_id: uuid.UUID) -> dict[str, Any]:
    """The stored trace as counts plus the models, so the terminal shows the retrieval shape."""
    with engine.connect() as conn:
        row = conn.execute(
            select(answer_traces).where(answer_traces.c.request_id == request_id)
        ).first()
    if row is None:
        return {}
    return {
        "dense": len(row.dense),
        "sparse": len(row.sparse),
        "fused": len(row.fused),
        "reranked": len(row.reranked),
        "models": dict(row.models),
        "provider": row.provider,
        "latencyMs": row.latency_ms,
    }


def _generation(gateway: RecordingGateway) -> dict[str, Any] | None:
    r = gateway.last
    if r is None:
        return None
    return {
        "provider": r.provider_id,
        "model": r.model,
        "latencyMs": r.latency_ms,
        "finishReason": r.finish_reason,
        "usage": r.usage,
        "rawReply": r.text,
    }


def _print_text(
    question: str,
    response: dict[str, Any],
    trace: dict[str, Any],
    generation: dict[str, Any] | None,
    *,
    show_prompt: bool,
    prompt_messages: list[dict[str, str]],
) -> None:
    print(f"Question: {question}")
    if generation is None:
        print("Model: not called (nothing was retrieved)")
    else:
        usage = generation["usage"] or {}
        print(
            f"Model: {generation['provider']} {generation['model']}  "
            f"{generation['latencyMs']} ms  finish={generation['finishReason']}  "
            f"tokens={usage.get('completion_tokens', '?')}"
        )
    print(
        f"Answerable: {'yes' if response['answerable'] else 'no'}  language={response['language']}"
    )
    print()
    print("Answer:")
    print(response["text"])
    if response.get("asOfNote"):
        print(f"({response['asOfNote']})")
    print()
    citations = response["citations"]
    print(f"Citations ({len(citations)}):")
    for i, c in enumerate(citations, start=1):
        v = c["verification"]
        checks = v["checks"]
        flags = f"  flags={','.join(v['flags'])}" if v["flags"] else ""
        print(
            f"  {i}. {v['status']}  {c.get('locator') or '-'}  "
            f"existence={checks.get('existence')} support={checks.get('support')}{flags}"
        )
        print(f"     claim: {c['claim']}")
        if c.get("quote"):
            quote = c["quote"].replace("\n", " ")
            if len(quote) > QUOTE_PREVIEW:
                quote = quote[:QUOTE_PREVIEW] + "…"
            print(f'     quote: "{quote}"')
    print()
    if trace:
        models = trace["models"]
        print(
            f"Trace: dense={trace['dense']} sparse={trace['sparse']} fused={trace['fused']} "
            f"reranked={trace['reranked']}  invalid_markers={models.get('invalid_markers', 0)}  "
            f"total={trace['latencyMs']} ms  prompt={models.get('prompt')}"
        )
    if show_prompt and prompt_messages:
        print()
        print("Prompt (last user message):")
        print("---")
        print(prompt_messages[-1]["content"])
        print("---")
    if generation is not None:
        print()
        print("Raw model reply:")
        print("---")
        print(generation["rawReply"])
        print("---")


def run(args: argparse.Namespace) -> int:
    settings = get_settings()
    gateway = build_gateway(settings)
    engine = deps.get_engine()
    question = Question(
        request_id=uuid.uuid4(),
        question=args.question,
        scope=Scope(user_id=SCRATCH_USER, account_id=SCRATCH_ACCOUNT),
        language=args.language,
        law_as_of=args.law_as_of,
        allowed_providers=args.providers,
    )
    try:
        response = answer_question(
            engine,
            question,
            gateway=gateway,
            embedder=deps.get_embedder(),
            reranker=deps.get_reranker(),
            support_checker=deps.get_support_checker(),
            stale_days=settings.trust_stale_days,
        )
    except NoProviderError as exc:
        print(
            f"FAIL  no generation provider: {exc}. Set LLM_GENERATION_* in .env.", file=sys.stderr
        )
        return 2
    except GatewayError as exc:
        print(f"FAIL  the model provider failed: {exc}", file=sys.stderr)
        return 1
    except (CorpusNotReady, EmbeddingMismatch) as exc:
        print(
            f"FAIL  the corpus is not ready ({type(exc).__name__}): run pnpm data:load, then "
            "pnpm data:embed.",
            file=sys.stderr,
        )
        return 2
    except OperationalError:
        print("FAIL  the database is unavailable: run pnpm db:up.", file=sys.stderr)
        return 2
    finally:
        gateway.close()

    trace = read_trace(engine, question.request_id)
    generation = _generation(gateway)
    if args.json:
        out: dict[str, Any] = {"response": response, "trace": trace, "generation": generation}
        if args.show_prompt:
            out["prompt"] = gateway.last_messages
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        _print_text(
            args.question,
            response,
            trace,
            generation,
            show_prompt=args.show_prompt,
            prompt_messages=gateway.last_messages,
        )
    return 0


def _providers(value: str) -> list[str]:
    ids = [v.strip() for v in value.split(",") if v.strip()]
    if not ids:
        raise argparse.ArgumentTypeError("at least one provider id")
    return ids


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("question", help="the research question")
    parser.add_argument(
        "--providers",
        type=_providers,
        default=None,
        help="comma-separated allow-list of provider ids (default: local providers only, SEC-11)",
    )
    parser.add_argument("--language", choices=["en", "ur", "roman_ur"], default=None)
    parser.add_argument(
        "--law-as-of", type=date.fromisoformat, default=None, help="YYYY-MM-DD (FR-RES-11)"
    )
    parser.add_argument("--json", action="store_true", help="print JSON instead of text")
    parser.add_argument(
        "--show-prompt", action="store_true", help="also print the passages the model was shown"
    )
    # `pnpm research:ask -- "..."` forwards the `--` literally; drop it.
    return parser.parse_args([a for a in argv if a != "--"])


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    # Log lines (llm_call, support checks) go to stderr so stdout stays the report or the JSON.
    structlog.configure(logger_factory=structlog.PrintLoggerFactory(file=sys.stderr))
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
