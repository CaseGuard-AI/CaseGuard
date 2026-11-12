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
  /** Providers this request's data may go to (SEC-11). Omitted means local only. */
  allowedProviders?: string[];
  /** The user's own key and model for the generation role (FR-SET-2, ADR-0009). Secret. */
  credential?: Credential;
}

/** ai.v1 Credential. `apiKey` is plaintext: never log, store or return it. */
export interface Credential {
  providerId: string;
  model: string;
  apiKey: string;
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
  /** Present when the request gave `lawAsOf`: what the date changed (FR-RES-11). */
  asOfNote?: string;
}

export interface Source {
  id: string;
  kind: "statute" | "judgment" | "rule" | "other";
  title: string;
  citation?: string;
  court?: string;
  decidedOn?: string;
  /** Public URL of the original on the official source (FR-RES-7). */
  officialUrl: string;
  sourceTier?: 1 | 2;
  thirdParty?: boolean;
  headnoteOnly?: boolean;
  language: Language;
  excerpt?: string;
  retrievedAt?: string;
}

/** A non-2xx response from services/ai. `status` lets routes tell a 404 from an outage. */
export class AiHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`AI service ${path} -> ${status}`);
  }
}

// Every method rejects on a non-2xx response (AiHttpError) or a timeout.
export interface AiClient {
  info(): Promise<{ service: string; version: string }>;
  /** Runs the research pipeline. */
  answer(req: AnswerRequest): Promise<Answer>;
  /** A citation with its current stored verification (FR-TRUST-5). */
  getCitation(citationId: string): Promise<Citation>;
  /** A corpus source record (FR-RES-7). */
  getSource(sourceId: string): Promise<Source>;
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
    if (!res.ok) throw new AiHttpError(path, res.status);
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
    getCitation: (id) => call(`/ai/v1/citations/${encodeURIComponent(id)}`),
    getSource: (id) => call(`/ai/v1/sources/${encodeURIComponent(id)}`),
  };
}
