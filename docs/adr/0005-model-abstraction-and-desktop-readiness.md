# ADR-0005: OpenAI-compatible model abstraction; desktop-ready by construction

- **Status:** Accepted
- **Date:** 2026-10-10
- **PRD refs:** NFR-11, NFR-16..19, SEC-11, FR-SET-2

## Context
The budget is free-tier first, and users may bring their own keys. The long-term target is a **desktop thin client** (Tauri or Electron) that ships a local LLM, while the corpus and retrieval stay server-side. Choices made now must not block that.

## Decision
- All LLM calls go through one gateway in `services/ai` that speaks the **OpenAI-compatible chat/embeddings API**. Providers (free-tier clouds, Ollama, llama.cpp server, user-supplied keys) are configuration, not code.
- Models are assigned **per role** (generation, translation, support-check fallback, judge). Embeddings, reranker and NLI each have a **locally runnable** option.
- The verification pipeline must work on a ~7–8B local model, and evaluation reports a local-model configuration.
- No hosting-vendor-specific runtime features and no proprietary managed vector store.

## Alternatives considered
| Option | Why not |
|---|---|
| Provider SDKs called directly from modules | Provider switching becomes a code change; blocks the desktop target |
| Fully offline desktop (bundled corpus + DB) | Ships gigabytes and needs on-device corpus updates; a separate product |

## Consequences
- The future desktop app swaps the generation endpoint for `localhost`; the rest is unchanged.
- Prompts can't rely on frontier-only behaviour, so prompt work is evaluated on the local configuration too.
