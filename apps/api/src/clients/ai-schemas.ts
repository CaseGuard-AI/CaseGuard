// Runtime checks for what services/ai returns (packages/contracts ai.v1). Nothing from the AI
// service reaches a user unchecked. Objects are loose: required fields are checked, extras pass.
import { z } from "zod";
import {
  DOCUMENT_STAGES,
  GRAPH_EDGE_TYPES,
  GRAPH_ENTITY_TYPES,
  LINT_DOCUMENT_TYPES,
  LINT_FINDING_KINDS,
  LINT_SEVERITIES,
  type Answer,
  type Citation,
  type DraftSectionResult,
  type DraftTemplate,
  type IngestionStatus,
  type LintResult,
  type LintRulesetList,
  type PrecedentSearchResult,
  type RelationshipList,
  type Source,
} from "./ai.js";

export const languageSchema = z.enum(["en", "ur", "roman_ur"]);

// FR-RES-6, FR-TRUST-4: every citation carries exactly one stored verification status.
export const citationSchema = z.looseObject({
  id: z.uuid(),
  sourceId: z.uuid(),
  claim: z.string(),
  verification: z.looseObject({
    status: z.enum(["verified", "needs_review", "unverified"]),
    flags: z.array(z.string()),
    lastVerifiedAt: z.string(),
  }),
});

export const answerSchema = z.object({
  requestId: z.uuid(),
  answerable: z.boolean(),
  language: languageSchema,
  text: z.string(),
  citations: z.array(citationSchema),
  asOfNote: z.string().optional(),
});

export const sourceSchema = z.looseObject({
  id: z.uuid(),
  kind: z.enum(["statute", "judgment", "rule", "other"]),
  title: z.string(),
  officialUrl: z.url(),
  language: languageSchema,
});

export const parseCitation = (raw: unknown) => citationSchema.parse(raw) as Citation;
export const parseSource = (raw: unknown) => sourceSchema.parse(raw) as Source;
export const parseAnswer = (raw: unknown) => answerSchema.parse(raw) as Answer;

// Document ingestion (ADR-0010). Flags and errors reach the user, so their sizes are checked.
export const documentFlagSchema = z.looseObject({
  stage: z.enum(DOCUMENT_STAGES),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().max(500),
  page: z.number().int().min(1).nullable(),
});

const timestamp = z.iso.datetime({ offset: true }).nullable();

export const ingestionStatusSchema = z.looseObject({
  documentId: z.uuid(),
  attempt: z.number().int().min(1),
  state: z.enum(["queued", "running", "done", "flagged", "failed"]),
  stages: z.array(
    z.looseObject({
      stage: z.enum(DOCUMENT_STAGES),
      state: z.enum(["pending", "running", "done", "flagged", "failed", "skipped"]),
      startedAt: timestamp,
      finishedAt: timestamp,
      flags: z.array(documentFlagSchema),
    }),
  ),
  flags: z.array(documentFlagSchema),
  error: z.string().max(500).nullable(),
  retryable: z.boolean(),
  pages: z.number().int().min(0).nullable(),
  chunkCount: z.number().int().min(0).nullable(),
});

export const parseIngestionStatus = (raw: unknown) =>
  ingestionStatusSchema.parse(raw) as IngestionStatus;

// Drafting (#212, #213). Template text reaches the user, so keys are checked like ai.v1's.
const draftKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const draftTemplateSchema = z.looseObject({
  id: z.enum(["bail_application", "plaint", "legal_notice"]),
  version: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  fields: z.array(
    z.looseObject({
      key: draftKey,
      label: z.string(),
      required: z.boolean(),
      caseField: z
        .enum([
          "title",
          "court",
          "caseNumber",
          "caseType",
          "filedOn",
          "status",
          "nextHearingOn",
          "parties",
          "judge",
          "assignedLawyer",
          "relevantLaws",
          "summary",
        ])
        .nullable(),
    }),
  ),
  sections: z.array(
    z.looseObject({
      key: draftKey,
      heading: z.string(),
      required: z.boolean(),
      assistable: z.boolean(),
      guidance: z.string(),
    }),
  ),
});

export const draftTemplateListSchema = z.looseObject({ items: z.array(draftTemplateSchema) });

// FR-DRAFT-3: every citation carries its stored verification, like an answer's.
export const draftSectionResultSchema = z.looseObject({
  requestId: z.uuid(),
  text: z.string(),
  citations: z.array(citationSchema),
});

export const parseDraftTemplates = (raw: unknown) =>
  draftTemplateListSchema.parse(raw) as { items: DraftTemplate[] };
export const parseDraftSection = (raw: unknown) =>
  draftSectionResultSchema.parse(raw) as DraftSectionResult;

// Precedent search (FR-PREC, ADR-0011). Origins, edge types and flags are closed enums, so a hit
// can never be shown with a label the UI doesn't know (FR-PREC-3, FR-TRUST-10).
export const trustFlagSchema = z.enum([
  "overruled",
  "repealed",
  "superseded_version",
  "conflict",
  "stale",
  "third_party_source",
  "headnote_only",
  "amended_since",
]);
const trustStatusSchema = z.enum(["verified", "needs_review", "unverified"]);
const edgeTypeSchema = z.enum(GRAPH_EDGE_TYPES);
const isoDate = z.iso.date().nullable();

export const precedentHitSchema = z
  .looseObject({
    sourceId: z.uuid(),
    title: z.string(),
    citation: z.string().nullable(),
    court: z.string().nullable(),
    decidedOn: isoDate,
    origin: z.enum(["retrieved", "graph_derived"]),
    via: z
      .looseObject({
        edgeId: z.uuid(),
        type: edgeTypeSchema,
        relatedSourceId: z.uuid(),
        sectionLabel: z.string().nullable(),
      })
      .nullable(),
    flags: z.array(trustFlagSchema),
    locator: z.string().nullable(),
    snippet: z.string().max(500).nullable(),
    score: z.number(),
  })
  // A graph-derived hit always says how it came in; a retrieved one never does.
  .refine((h) => (h.origin === "graph_derived") === (h.via !== null), {
    message: "via must be set exactly for graph-derived hits",
  });

export const precedentSearchResultSchema = z.object({
  requestId: z.uuid(),
  hits: z.array(precedentHitSchema),
  graphAvailable: z.boolean(),
});

export const relationshipListSchema = z.object({
  sourceId: z.uuid(),
  items: z.array(
    z.looseObject({
      id: z.uuid(),
      type: edgeTypeSchema,
      direction: z.enum(["outgoing", "incoming"]),
      other: z.looseObject({
        entityType: z.enum(GRAPH_ENTITY_TYPES),
        sourceId: z.uuid().nullable(),
        label: z.string(),
      }),
      provenance: z.looseObject({
        documentId: z.uuid().nullable(),
        extractionMethod: z.enum(["metadata", "regex", "human"]),
        confidence: z.number().min(0).max(1),
        humanConfirmed: z.boolean(),
      }),
      verificationStatus: trustStatusSchema,
      validFrom: isoDate,
      validTo: isoDate,
      recordedAt: z.iso.datetime({ offset: true }),
    }),
  ),
});

export const parsePrecedentSearchResult = (raw: unknown) =>
  precedentSearchResultSchema.parse(raw) as PrecedentSearchResult;
export const parseRelationshipList = (raw: unknown) =>
  relationshipListSchema.parse(raw) as RelationshipList;

// The linter (ADR-0012). Findings are stored with the report and shown to the user, so they are
// checked strictly, and unknown keys are dropped rather than stored.
const lintSourceSchema = z
  .object({
    provision: z.string().min(1).max(200),
    reference: z.uuid().nullable(),
  })
  .nullable();

const lintRuleIdSchema = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);

export const lintRulesetListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1).max(64),
      documentType: z.enum(LINT_DOCUMENT_TYPES),
      version: z.string().min(1).max(32),
      title: z.string().min(1).max(200),
      rules: z.array(
        z.object({
          id: lintRuleIdSchema,
          kind: z.enum(LINT_FINDING_KINDS),
          severity: z.enum(LINT_SEVERITIES),
          title: z.string().min(1).max(200),
          source: lintSourceSchema,
        }),
      ),
    }),
  ),
});

export const lintFindingSchema = z.object({
  ruleId: lintRuleIdSchema,
  kind: z.enum(LINT_FINDING_KINDS),
  severity: z.enum(LINT_SEVERITIES),
  message: z.string().min(1).max(500),
  span: z
    .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
    .refine((s) => s.start <= s.end, "span end before start")
    .nullable(),
  source: lintSourceSchema,
});

export const lintResultSchema = z.object({
  requestId: z.uuid(),
  rulesetId: z.string().min(1).max(64),
  rulesetVersion: z.string().min(1).max(32),
  inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  findings: z.array(lintFindingSchema),
});

export const parseLintRulesetList = (raw: unknown) =>
  lintRulesetListSchema.parse(raw) as LintRulesetList;

/** A lint result for `text`. Spans must lie within it (its UTF-16 length, as JavaScript counts). */
export function parseLintResult(raw: unknown, text: string): LintResult {
  const result = lintResultSchema.parse(raw) as LintResult;
  if (result.findings.some((f) => f.span && f.span.end > text.length)) {
    throw new Error("lint finding span outside the text");
  }
  return result;
}
