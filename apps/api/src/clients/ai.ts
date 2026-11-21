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

// Drafting (FR-DRAFT-1, FR-DRAFT-3, #212).
export type DraftTemplateId = "bail_application" | "plaint" | "legal_notice";
export type CaseField =
  | "title"
  | "court"
  | "caseNumber"
  | "caseType"
  | "filedOn"
  | "status"
  | "nextHearingOn"
  | "parties"
  | "judge"
  | "assignedLawyer"
  | "relevantLaws"
  | "summary";

export interface DraftTemplate {
  id: DraftTemplateId;
  version: string;
  title: string;
  description: string;
  fields: { key: string; label: string; required: boolean; caseField: CaseField | null }[];
  sections: {
    key: string;
    heading: string;
    required: boolean;
    assistable: boolean;
    guidance: string;
  }[];
}

export interface DraftSectionRequest {
  requestId: string;
  templateId: DraftTemplateId;
  sectionKey: string;
  instruction?: string;
  fields: Record<string, string | null>;
  otherSections: { key: string; body: string }[];
  scope: Scope;
  allowedProviders?: string[];
  /** As in AnswerRequest. Secret. */
  credential?: Credential;
}

export interface DraftSectionResult {
  requestId: string;
  text: string;
  citations: Citation[];
}

// Precedent search (FR-PREC, ADR-0011). Deterministic: no model provider is called.
export type TrustFlag =
  | "overruled"
  | "repealed"
  | "superseded_version"
  | "conflict"
  | "stale"
  | "third_party_source"
  | "headnote_only"
  | "amended_since";

export const GRAPH_EDGE_TYPES = [
  "CITES_SECTION",
  "CITES_JUDGMENT",
  "AMENDS",
  "SUBSTITUTES",
  "INSERTS",
  "OMITS",
  "REPEALS",
  "OVERRULES",
  "CONNECTED_CASE",
] as const;
export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number];
export const GRAPH_ENTITY_TYPES = [
  "statute",
  "section",
  "judgment",
  "court",
  "amendment_act",
] as const;
export type GraphEntityType = (typeof GRAPH_ENTITY_TYPES)[number];

export interface PrecedentFilters {
  court?: string;
  area?: string;
  decidedFrom?: string;
  decidedTo?: string;
  sectionRef?: string;
}

export interface PrecedentSearchRequest {
  requestId: string;
  query: string;
  filters?: PrecedentFilters;
  includeGraphDerived?: boolean;
  limit?: number;
}

export interface PrecedentVia {
  edgeId: string;
  type: GraphEdgeType;
  relatedSourceId: string;
  sectionLabel: string | null;
}

export interface PrecedentHit {
  sourceId: string;
  title: string;
  citation: string | null;
  court: string | null;
  decidedOn: string | null;
  origin: "retrieved" | "graph_derived";
  via: PrecedentVia | null;
  flags: TrustFlag[];
  locator: string | null;
  snippet: string | null;
  score: number;
}

export interface PrecedentSearchResult {
  requestId: string;
  hits: PrecedentHit[];
  graphAvailable: boolean;
}

export interface Relationship {
  id: string;
  type: GraphEdgeType;
  direction: "outgoing" | "incoming";
  other: { entityType: GraphEntityType; sourceId: string | null; label: string };
  provenance: {
    documentId: string | null;
    extractionMethod: "metadata" | "regex" | "human";
    confidence: number;
    humanConfirmed: boolean;
  };
  verificationStatus: Verification["status"];
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
}

export interface RelationshipList {
  sourceId: string;
  items: Relationship[];
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
  /** The drafting templates (FR-DRAFT-1). */
  listDraftTemplates(): Promise<{ items: DraftTemplate[] }>;
  /** Drafts one section; its citations come from the trust store (FR-DRAFT-3). */
  draftSection(req: DraftSectionRequest): Promise<DraftSectionResult>;
  /** Judgments for a query, with graph-derived precedents labelled (FR-PREC-3). */
  searchPrecedents(req: PrecedentSearchRequest): Promise<PrecedentSearchResult>;
  /** A judgment's typed relationships with provenance (FR-PREC-4). 404 if not a judgment. */
  getPrecedentRelationships(sourceId: string): Promise<RelationshipList>;
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
    listDraftTemplates: () => call("/ai/v1/drafting/templates"),
    draftSection: (req) =>
      call(
        "/ai/v1/drafting/sections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        },
        answerTimeoutMs,
      ),
    // Retrieval and reranking run in-process; the first search may load the models.
    searchPrecedents: (req) =>
      call(
        "/ai/v1/precedents/search",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        },
        answerTimeoutMs,
      ),
    getPrecedentRelationships: (id) =>
      call(`/ai/v1/precedents/${encodeURIComponent(id)}/relationships`),
  };
}
