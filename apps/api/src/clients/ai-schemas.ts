// Runtime checks for what services/ai returns (packages/contracts ai.v1). Nothing from the AI
// service reaches a user unchecked. Objects are loose: required fields are checked, extras pass.
import { z } from "zod";
import type { Answer, Citation, Source } from "./ai.js";

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
