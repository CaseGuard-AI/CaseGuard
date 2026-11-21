// Runtime checks for what services/ai returns (packages/contracts ai.v1). Nothing from the AI
// service reaches a user unchecked. Objects are loose: required fields are checked, extras pass.
import { z } from "zod";
import {
  DOCUMENT_STAGES,
  LINT_DOCUMENT_TYPES,
  LINT_FINDING_KINDS,
  LINT_SEVERITIES,
  type Answer,
  type Citation,
  type IngestionStatus,
  type LintResult,
  type LintRulesetList,
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
