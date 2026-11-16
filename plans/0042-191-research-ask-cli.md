> **Status:** In progress · **Issue:** [#191](https://github.com/CaseGuard-AI/CaseGuard/issues/191)

# #191: `pnpm research:ask`, a terminal front to the answer path

## Context

The Research Hub's answer path (`services/ai/src/caseguard_ai/research/answer.py`) had only been run against fake gateways. The handoff names the risk: "How well a 7–8B model follows the answer format hasn't been tested yet." The only smoke tool, `pnpm llm:check`, pings the provider with a one-word prompt. Measuring a real model needs the whole path, question to stored citations, without the web and api in between, and it needs to show the raw model reply, which the route hides.

While setting this up the NIM preset `nvidia/nemotron-3-super-120b-a12b` turned out to be end-of-life (HTTP 410 since 2026-10-03). The `.env.example` preset moves to `nvidia/nemotron-3.5-super-vl-120b-a12b`, which answered in about 3 s.

## Decisions

- **Reuse, don't re-implement.** The CLI calls `answer_question` with the same dependencies the route uses (`api/deps.py`), so what it prints is what `/ai/v1/research/answer` would return. A `RecordingGateway` subclass of `ModelGateway` remembers the last generation call (reply, finish reason, usage, the messages sent); nothing in `answer.py` changes.
- **Scratch scope.** A fixed user/account id pair and no case ids: only the corpus is searched, and the trace is stored like any other answer.
- **Text by default, `--json` for scripting**, `--show-prompt` for the numbered passages, `--providers` as the api's allow-list, `--language`, `--law-as-of`.
- Exit codes: 0 when the path ran (answerable or not), 1 when the provider failed, 2 when nothing could run (no provider, corpus not ready, database down).

## Steps

1. `services/ai/src/caseguard_ai/research/ask_cli.py`, and `"research:ask"` in the root `package.json` beside `llm:check`.
2. `services/ai/tests/test_ask_cli.py`: the `test_answer` corpus with the real gateway's HTTP call scripted; text and JSON output, NOT_ANSWERABLE, invalid markers, allow-list refusal.
3. `.env.example`: replace the end-of-life NIM preset.
4. ~~Run demo-law questions on NIM and record the result.~~ Split out as #192: the demo corpus is placeholders, and embedding the real seed laws (2,070 chunks) takes hours on the development laptop and crashed the Docker Postgres for lack of memory. This PR records the CLI in `work-log.md` and points the "hasn't been tested" line in `session-handoff.md` at #192.

## Verification

- `uv run pytest tests/test_ask_cli.py` with `AI_TEST_DATABASE_URL`; `ruff check`, `ruff format --check`, `mypy` clean.
- `pnpm research:ask -- "<demo-law question>" --providers nvidia-nim` prints a cited answer with statuses and the raw reply; an off-corpus question prints `Answerable: no`.
