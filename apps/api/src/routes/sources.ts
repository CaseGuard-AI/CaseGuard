import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { AiHttpError, type AiClient } from "../clients/ai.js";
import { parseCitation, parseSource } from "../clients/ai-schemas.js";
import { userHasCitation } from "../conversations/store.js";
import type { Db } from "../db/client.js";
import { HttpProblem } from "../lib/problem.js";

const id = z.uuid();

const notFound = (what: string) => new HttpProblem(404, "Not Found", `No such ${what}.`);

/**
 * Calls services/ai and validates the result. An ai.v1 404 stays a 404; any other failure,
 * timeout or malformed response becomes 503 (api.v1 Unavailable).
 */
async function fromAi<T>(
  what: string,
  log: { error: (obj: object, msg: string) => void },
  fetchIt: () => Promise<unknown>,
  parse: (raw: unknown) => T,
): Promise<T> {
  try {
    return parse(await fetchIt());
  } catch (err) {
    if (err instanceof AiHttpError && err.status === 404) throw notFound(what);
    log.error({ err }, `AI service ${what} lookup failed`);
    throw new HttpProblem(
      503,
      "Service Unavailable",
      "The research service is unavailable. Try again shortly.",
    );
  }
}

// api.v1 tag "sources": citations and source records (FR-RES-7, FR-TRUST-5, FR-TRUST-10).
export function sourcesRouter(deps: { db: Db; jwtSecret: string; ai: AiClient }) {
  const { db, ai } = deps;
  const router = Router();
  router.use(["/citations", "/sources"], requireAuth(deps.jwtSecret));

  // Only citations from the user's own answers, checked before services/ai is asked
  // (FR-AUTH-4). The response carries the current stored verification, not the copy saved
  // with the message, so re-verification shows up (FR-TRUST-5).
  router.get("/citations/:citationId", async (req, res) => {
    const citationId = id.safeParse(req.params.citationId);
    if (!citationId.success) throw notFound("citation");
    if (!(await userHasCitation(db, req.auth!.userId, citationId.data))) {
      throw notFound("citation");
    }
    res.json(
      await fromAi("citation", req.log, () => ai.getCitation(citationId.data), parseCitation),
    );
  });

  // Public-corpus sources are readable by any signed-in user. Private case documents arrive
  // with cases (P1) and must then be limited to the resolved scope (FR-CASE-6).
  router.get("/sources/:sourceId", async (req, res) => {
    const sourceId = id.safeParse(req.params.sourceId);
    if (!sourceId.success) throw notFound("source");
    res.json(await fromAi("source", req.log, () => ai.getSource(sourceId.data), parseSource));
  });

  return router;
}
