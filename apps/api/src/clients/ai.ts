// Client for services/ai (/ai/v1). Every call carries the service token (ADR-0002, SEC-14).

// packages/contracts/openapi/ai.v1.yaml
export type Language = "en" | "ur" | "roman_ur";

export interface Scope {
  userId: string;
  accountId: string;
  /** Cases whose private documents may be retrieved. Empty = public corpus only (FR-CASE-6). */
  allowedCaseIds: string[];
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface AnswerRequest {
  requestId: string;
  question: string;
  language?: Language;
  lawAsOf?: string;
  history?: Turn[];
  scope: Scope;
}

export interface Verification {
  status: "verified" | "needs_review" | "unverified";
  flags: string[];
  lastVerifiedAt: string;
  checks?: Record<string, string>;
}

export interface Citation {
  id: string;
  sourceId: string;
  claim: string;
  locator?: string;
  quote?: string;
  quoteLanguage?: Language;
  verification: Verification;
}

export interface Answer {
  requestId: string;
  answerable: boolean;
  language: Language;
  text: string;
  citations: Citation[];
}

export interface AiClient {
  info(): Promise<{ service: string; version: string }>;
  /** Runs the research pipeline. Rejects on any non-200 response or a timeout. */
  answer(req: AnswerRequest): Promise<Answer>;
}

export function createAiClient(
  baseUrl: string,
  token: string,
  timeoutMs = 3000,
  answerTimeoutMs = 120_000,
): AiClient {
  async function call<T>(path: string, init: RequestInit = {}, ms = timeoutMs): Promise<T> {
    const res = await fetch(new URL(path, baseUrl), {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) throw new Error(`AI service ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }
  return {
    info: () => call("/ai/v1/info"),
    answer: (req) =>
      call(
        "/ai/v1/research/answer",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        },
        answerTimeoutMs,
      ),
  };
}
