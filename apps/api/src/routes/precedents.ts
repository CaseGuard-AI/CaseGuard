import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { AiHttpError, type AiClient, type PrecedentSearchResult } from "../clients/ai.js";
import { parsePrecedentSearchResult, parseRelationshipList } from "../clients/ai-schemas.js";
import type { Db } from "../db/client.js";
import { HttpProblem } from "../lib/problem.js";
import { aiLimiter } from "../middleware/rate-limit.js";
import { auditSearch, auditSearchFailure, type SearchAudit } from "../precedents/audit.js";

// packages/contracts api.v1: PrecedentSearch (filters are ai.v1 PrecedentFilters).
const filtersSchema = z
  .strictObject({
    court: z.string().max(120).optional(),
    area: z.string().max(80).optional(),
    decidedFrom: z.iso.date().optional(),
    decidedTo: z.iso.date().optional(),
    sectionRef: z.string().max(120).optional(),
  })
  .refine((f) => !(f.decidedFrom && f.decidedTo && f.decidedFrom > f.decidedTo), {
    path: ["decidedFrom"],
    message: "must not be after decidedTo",
  });

const searchBody = z.strictObject({
  query: z.string().trim().min(1).max(1000),
  filters: filtersSchema.optional(),
  includeGraphDerived: z.boolean().default(true),
  limit: z.number().int().min(1).max(50).default(20),
});

const sourceId = z.uuid();

const unavailable = () =>
  new HttpProblem(
    503,
    "Service Unavailable",
    "Precedent search is unavailable right now. Try again shortly.",
  );

// api.v1 tag "precedents" (FR-PREC-1, FR-PREC-4, ADR-0011). Judgments are public, so any
// signed-in user may search. No model provider is called, so there is no AI-enabled check:
// the search works with AI features off (api.v1 searchPrecedents).
export function precedentsRouter(deps: { db: Db; jwtSecret: string; ai: AiClient }) {
  const { db, ai } = deps;
  const router = Router();
  router.use("/precedents", requireAuth(deps.jwtSecret));

  // Every search is audited under its own requestId (FR-TRUST-12, PRD §13.3).
  router.post("/precedents/search", aiLimiter(), async (req, res) => {
    const body = searchBody.parse(req.body);
    const requestId = randomUUID();
    const started = Date.now();
    const audit = (): SearchAudit => ({
      requestId,
      owner: req.auth!,
      query: body.query,
      ...(body.filters ? { filters: body.filters } : {}),
      includeGraphDerived: body.includeGraphDerived,
      limit: body.limit,
      latencyMs: Date.now() - started,
    });

    let result: PrecedentSearchResult;
    try {
      result = parsePrecedentSearchResult(
        await ai.searchPrecedents({
          requestId,
          query: body.query,
          ...(body.filters ? { filters: body.filters } : {}),
          includeGraphDerived: body.includeGraphDerived,
          limit: body.limit,
        }),
      );
      if (result.requestId !== requestId) throw new Error("result is for a different request");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      req.log.error({ err, requestId }, "precedent search failed");
      await auditSearchFailure(db, audit(), reason);
      throw unavailable();
    }
    await auditSearch(db, audit(), result);
    res.json(result);
  });

  // A judgment's typed relationships with provenance and status (FR-PREC-2, FR-PREC-4). An
  // ai.v1 404 (not a judgment) stays a 404; any other failure is a 503.
  router.get("/precedents/:sourceId/relationships", async (req, res) => {
    const id = sourceId.safeParse(req.params.sourceId);
    if (!id.success) throw new HttpProblem(404, "Not Found", "No such judgment.");
    try {
      res.json(parseRelationshipList(await ai.getPrecedentRelationships(id.data)));
    } catch (err) {
      if (err instanceof AiHttpError && err.status === 404) {
        throw new HttpProblem(404, "Not Found", "No such judgment.");
      }
      req.log.error({ err }, "precedent relationships lookup failed");
      throw unavailable();
    }
  });

  return router;
}
