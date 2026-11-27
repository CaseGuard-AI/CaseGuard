> **Status:** In progress · **Issues:** [#243](https://github.com/CaseGuard-AI/CaseGuard/issues/243) (notebook), [#244](https://github.com/CaseGuard-AI/CaseGuard/issues/244) (token budget) · **PR:** [#245](https://github.com/CaseGuard-AI/CaseGuard/pull/245), [#246](https://github.com/CaseGuard-AI/CaseGuard/pull/246)

# First real run of the Colab AI notebook

## Context
Plan 0066 shipped `notebooks/colab-ai-service.ipynb`, which runs `services/ai` on a free Colab GPU for laptops too small to hold the models. Nobody had run it end to end yet. Claude drove it through the Playwright MCP browser on a T4 (2026-11-27), fixed each failing step on a `fix/` branch, and re-ran it until every step passed.

## What failed and the fix

| Step | Failure | Fix |
|---|---|---|
| 3 | CUDA torch never installed, so models ran on CPU. `uv pip` targeted Colab's system Python, and the cu126, cu128 and cu124 indexes have no torch 2.15.0. | `--python .venv/bin/python`; try cu132 first, then older; keep a build only if `torch.cuda.is_available()`, else restore the locked CPU build. |
| 4 | The echoed `psql` command printed the generated DB passwords. | `run(..., shown=...)` redacts them. |
| 4 | A lost newline in the pasted `CASEGUARD_ENV` secret glued `LLM_JUDGE_API_KEY` and `NVIDIA_API_KEY` together, so the judge got HTTP 401. | Warn, by key name only, when a value holds another `KEY=` setting. |
| 7, 9b | `no allowed model provider`: with no allow-list, a request may use local providers only (SEC-11). | Pass the provider ids the `.env` configures (`--providers`, `allowedProviders`). Corrected the `ask_cli --providers` help text. |
| 7 | `empty answer (the model used its whole budget reasoning)`. Nemotron models reason for 800–1,100 tokens before answering; the gateway gave generation 1024 and the judge 256. | #244: `LLM_GENERATION_MAX_TOKENS` (4096) and `LLM_JUDGE_MAX_TOKENS` (1024) in `Settings`, used when a caller doesn't set `max_tokens`. |
| 10 | `NameResolutionError`: the new trycloudflare.com name didn't resolve after a fixed 5 s wait. | Retry the health check for up to 90 s. |
| 10 (rerun) | `curl: (23)`: rerunning overwrote the `cloudflared` binary while the old tunnel was running it. | Stop the old tunnel first; download the binary only once. |

## Model choice (probed on Colab with the real prompts)
- **Judge:** `nemotron-3-super-120b-a12b` was retired on 2026-10-03 (HTTP 410). `nvidia/nemotron-3.5-super-vl-120b-a12b` was 5/5 on labelled support claims at 1–3 s each. `nemotron-3-ultra-550b` was also 5/5 but slower. `nemotron-3.5-lightning-30b` scored 4/5.
- **Generation:** keep `nvidia/nemotron-3.5-super-vl-120b-a12b`. It gave a complete s. 302 answer in 18 s with 4 citations. `ultra-550b` was complete but took 40 s; `lightning-30b` took 15 s but left out the proviso. `mistral-large-4` timed out, and `gemma-3-12b` returned 404 for this key.

## Verification
On a Colab T4, steps 1–11 pass. Steps 3 and 7–10 ran from the fix branch's notebook via scratch cells, with services/ai at the #244 branch.
- Step 3: models run on `cuda`.
- Step 7: cited answer.
- Step 9a: 200, 5 precedents including graph-derived ones.
- Step 9b: 200, a drafted section.
- Step 10: health 200 through the tunnel.

From the laptop, `/health` returns 200 through the tunnel, and `/ai/v1/info` returns 200 with the local `AI_SERVICE_TOKEN` and 401 with a wrong token. `services/ai` passes pytest, ruff and mypy with the #244 change.

## Follow-ups (not in these PRs)
- Answers attach one marker to a whole multi-clause sentence, so every citation shows the same long claim. That's for #192, answer format on the real laws.
- The dump-publisher re-run (plan 0066) is still needed to drop the alembic stamp workaround.
