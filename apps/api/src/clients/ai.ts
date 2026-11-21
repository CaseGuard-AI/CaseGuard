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

// Document ingestion (FR-DOC-2, ADR-0010).
export const DOCUMENT_MEDIA_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
  "image/tiff",
] as const;
export type DocumentMediaType = (typeof DOCUMENT_MEDIA_TYPES)[number];

export const DOCUMENT_STAGES = [
  "ocr",
  "extract",
  "clean",
  "structure",
  "chunk",
  "embed",
  "index",
] as const;
export type DocumentStage = (typeof DOCUMENT_STAGES)[number];

export interface DocumentFlag {
  stage: DocumentStage;
  code: string;
  message: string;
  page: number | null;
}

export interface IngestionRequest {
  scope: Scope;
  caseId: string;
  storageKey: string;
  mediaType: DocumentMediaType;
  filename: string;
  attempt: number;
}

export type IngestionState = "queued" | "running" | "done" | "flagged" | "failed";
export type IngestionStageState = "pending" | "running" | "done" | "flagged" | "failed" | "skipped";

export interface IngestionStage {
  stage: DocumentStage;
  state: IngestionStageState;
  startedAt: string | null;
  finishedAt: string | null;
  flags: DocumentFlag[];
}

export interface IngestionStatus {
  documentId: string;
  attempt: number;
  state: IngestionState;
  stages: IngestionStage[];
  flags: DocumentFlag[];
  error: string | null;
  retryable: boolean;
  pages: number | null;
  chunkCount: number | null;
}

// The procedural linter (FR-LINT, ADR-0012). Deterministic: no model provider is called.
export const LINT_DOCUMENT_TYPES = ["bail_application", "plaint"] as const;
export type LintDocumentType = (typeof LINT_DOCUMENT_TYPES)[number];
export const LINT_SEVERITIES = ["error", "warning", "info"] as const;
export type LintSeverity = (typeof LINT_SEVERITIES)[number];
export const LINT_FINDING_KINDS = ["missing_section", "missing_particular", "structure"] as const;
export type LintFindingKind = (typeof LINT_FINDING_KINDS)[number];

/** Where a rule comes from (FR-LINT-2). Null on a rule or finding: none was identified. */
export interface LintRuleSource {
  provision: string;
  reference: string | null;
}

export interface LintRule {
  id: string;
  kind: LintFindingKind;
  severity: LintSeverity;
  title: string;
  source: LintRuleSource | null;
}

export interface LintRuleset {
  id: string;
  documentType: LintDocumentType;
  version: string;
  title: string;
  rules: LintRule[];
}

export interface LintRulesetList {
  items: LintRuleset[];
}

export interface LintRequest {
  requestId: string;
  documentType: LintDocumentType;
  text: string;
}

export interface LintFinding {
  ruleId: string;
  kind: LintFindingKind;
  severity: LintSeverity;
  message: string;
  /** `[start, end)` in UTF-16 code units; null when missing from the whole document. */
  span: { start: number; end: number } | null;
  source: LintRuleSource | null;
}

export interface LintResult {
  requestId: string;
  rulesetId: string;
  rulesetVersion: string;
  /** SHA-256 of the text's UTF-8 bytes, lowercase hex (FR-LINT-3). */
  inputSha256: string;
  findings: LintFinding[];
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
  /** Submits an ingestion attempt (202). Idempotent per (documentId, attempt). */
  startIngestion(documentId: string, req: IngestionRequest): Promise<IngestionStatus>;
  /** The current attempt's status, for polling. */
  getIngestion(documentId: string): Promise<IngestionStatus>;
  /** Removes the document's chunks and ingestion records (204). Idempotent. */
  purgeDocument(documentId: string): Promise<void>;
  /** The linter's rule sets (FR-LINT-2). */
  listLintRulesets(): Promise<LintRulesetList>;
  /** Lints a document's text; services/ai never modifies or stores it (FR-LINT-3). */
  lint(req: LintRequest): Promise<LintResult>;
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
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  const doc = (id: string) => `/ai/v1/documents/${encodeURIComponent(id)}`;
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
    startIngestion: (id, req) =>
      call(`${doc(id)}/ingestion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      }),
    getIngestion: (id) => call(`${doc(id)}/ingestion`),
    purgeDocument: (id) => call(doc(id), { method: "DELETE" }),
    listLintRulesets: () => call("/ai/v1/lint/rulesets"),
    lint: (req) =>
      call("/ai/v1/lint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      }),
  };
}
