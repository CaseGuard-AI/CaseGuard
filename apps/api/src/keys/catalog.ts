// The models offered per provider (FR-SET-2, ADR-0005): what GET /models lists and what a
// user's defaultModel is checked against. A static catalogue of current, well-known ids for
// the providers seeded by migration 0003; provider catalogues change, so update it when they
// do (services/ai: `pnpm llm:check --list-models`). Ollama is local and keyless, and its
// models depend on what each machine pulled, so none are offered here.
const CATALOG: Readonly<Record<string, readonly string[]>> = {
  "nvidia-nim": [
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/llama-3.3-nemotron-super-49b-v1",
    "meta/llama-3.3-70b-instruct",
  ],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-120b"],
  openrouter: [
    "meta-llama/llama-3.3-70b-instruct",
    "google/gemini-2.5-flash",
    "openai/gpt-4o-mini",
  ],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  ollama: [],
};

/** The model ids offered for a provider; empty for an unknown one. */
export function modelsFor(providerId: string): string[] {
  return Object.hasOwn(CATALOG, providerId) ? [...CATALOG[providerId]!] : [];
}
