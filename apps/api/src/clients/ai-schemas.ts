// Runtime checks for what services/ai returns (packages/contracts ai.v1). Nothing from the AI
// service reaches a user unchecked. Objects are loose: required fields are checked, extras pass.
import { z } from "zod";
import {
  DOCUMENT_STAGES,
  type Answer,
  type Citation,
  type DraftSectionResult,
  type DraftTemplate,
  type IngestionStatus,
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
