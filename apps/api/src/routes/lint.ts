import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { requireActiveCase } from "../cases/store.js";
import { LINT_DOCUMENT_TYPES, type AiClient, type LintDocumentType } from "../clients/ai.js";
import { parseLintResult, parseLintRulesetList } from "../clients/ai-schemas.js";
import type { Db } from "../db/client.js";
import type { LintReport } from "../db/schema.js";
import {
  deleteLintReport,
  findOwnLintReport,
  insertLintReport,
  listLintReports,
} from "../lint/store.js";
import { HttpProblem } from "../lib/problem.js";
import { lintLimiter } from "../middleware/rate-limit.js";

const MAX_TEXT = 200_000; // code points, as JSON Schema counts maxLength
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Length in code points: astral characters (two UTF-16 units) count once. */
const codePoints = (text: string) =>
  text.length - (text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);

// packages/contracts api.v1: LintReportCreate.
const createBody = z.strictObject({
  documentType: z.enum(LINT_DOCUMENT_TYPES),
  text: z
    .string()
    .min(1)
    .refine((t) => codePoints(t) <= MAX_TEXT, `At most ${MAX_TEXT} characters`)
    // No UTF-8 encoding, so no bytes to hash (FR-LINT-3).
    .refine((t) => !LONE_SURROGATE.test(t), "Not valid Unicode text"),
  title: z.string().trim().min(1).max(200).optional(),
  caseId: z.uuid().nullable().optional(),
  draftId: z.uuid().nullable().optional(),
});

const listQuery = z.object({
  caseId: z.uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const TYPE_TITLES: Record<LintDocumentType, string> = {
  bail_application: "Bail application",
  plaint: "Plaint",
};

/** "Bail application, 2026-11-21": the contract's default title (the date in Pakistan). */
export function defaultTitle(type: LintDocumentType, now = new Date()): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(now);
  return `${TYPE_TITLES[type]}, ${day}`;
}

const unavailable = () =>
  new HttpProblem(503, "Service Unavailable", "The linter is unavailable. Try again shortly.");

const notFound = () => new HttpProblem(404, "Not Found", "No such lint report.");

const countsOf = (r: LintReport) => {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of r.findings) counts[f.severity]++;
  return counts;
};

/** The contract's LintReportSummary. */
const toSummaryDto = (r: LintReport) => ({
  id: r.id,
  documentType: r.documentType,
  title: r.title,
  caseId: r.caseId,
  draftId: r.draftId,
  findingCounts: countsOf(r),
  createdAt: r.createdAt.toISOString(),
});

/** The contract's LintReport: every field present, the text exactly as linted. */
const toReportDto = (r: LintReport) => ({
  id: r.id,
  documentType: r.documentType,
  title: r.title,
  caseId: r.caseId,
  draftId: r.draftId,
  text: r.text,
  inputSha256: r.inputSha256,
  rulesetId: r.rulesetId,
  rulesetVersion: r.rulesetVersion,
  findings: r.findings,
  createdAt: r.createdAt.toISOString(),
});

// api.v1 tag "linter" (FR-LINT-1, FR-LINT-3, FR-CASE-5, ADR-0012). Owner only: another user's
// report is a 404 (FR-AUTH-4). The linter calls no model provider, so nothing here is audited
// as AI use (SEC-8) and the routes work with AI features off. The text is never logged.
export function lintRouter(deps: { db: Db; jwtSecret: string; ai: AiClient }) {
  const { db, ai } = deps;
  const router = Router();
  const auth = requireAuth(deps.jwtSecret);
  router.use(["/lint", "/lint-reports"], auth);

  router.get("/lint/rulesets", async (req, res) => {
    try {
      res.json(parseLintRulesetList(await ai.listLintRulesets()));
    } catch (err) {
      req.log.error({ err }, "AI service lint rule sets failed");
      throw unavailable();
    }
  });

  router.post("/lint-reports", lintLimiter(), async (req, res) => {
    const body = createBody.parse(req.body);
    const owner = req.auth!;
    if (body.caseId) {
      try {
        await requireActiveCase(db, owner, body.caseId);
      } catch (err) {
        if (!(err instanceof HttpProblem)) throw err;
        throw new HttpProblem(400, "Bad Request", "The report can't be saved to that case.", err.extra);
      }
    }
    // draftId is only checked as a uuid and recorded: app.drafts (Track D) isn't here yet, so
    // whether it is the caller's draft is a follow-up (plan 0060).

    let result;
    try {
      const requestId = randomUUID();
      result = parseLintResult(
        await ai.lint({ requestId, documentType: body.documentType, text: body.text }),
        body.text,
      );
      if (result.requestId !== requestId) throw new Error("lint result for another request");
    } catch (err) {
      req.log.error({ err }, "AI service lint failed");
      throw unavailable();
    }
    // The stored text must be the text that was linted (FR-LINT-3).
    const sha = createHash("sha256").update(body.text, "utf8").digest("hex");
    if (result.inputSha256 !== sha) {
      req.log.error("AI service lint hash does not match the text sent");
      throw unavailable();
    }

    const report = await insertLintReport(db, owner, {
      documentType: body.documentType,
      title: body.title ?? defaultTitle(body.documentType),
      text: body.text,
      caseId: body.caseId ?? null,
      draftId: body.draftId ?? null,
      result,
    });
    res.status(201).json(toReportDto(report));
  });

  router.get("/lint-reports", async (req, res) => {
    const page = await listLintReports(db, req.auth!, listQuery.parse(req.query));
    res.json({ ...page, items: page.items.map(toSummaryDto) });
  });

  router.get("/lint-reports/:reportId", async (req, res) => {
    const report = await findOwnLintReport(db, req.auth!, req.params.reportId);
    if (!report) throw notFound();
    res.json(toReportDto(report));
  });

  router.delete("/lint-reports/:reportId", async (req, res) => {
    if (!(await deleteLintReport(db, req.auth!, req.params.reportId))) throw notFound();
    res.status(204).end();
  });

  return router;
}
