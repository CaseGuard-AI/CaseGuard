import type { PrecedentFilters, PrecedentSearchResult } from "../clients/ai.js";
import type { Db } from "../db/client.js";
import { aiAuditRecords } from "../db/schema.js";

interface Owner {
  userId: string;
  accountId: string;
}

// The audit record of a precedent search (FR-TRUST-12, PRD §13.3), in the table research uses.
// A search calls no model, so `allowed_providers` is empty. `response_text` keeps what the user
// was shown and the graph context behind it: each hit's origin and the edge that brought it in.
export interface SearchAudit {
  requestId: string;
  owner: Owner;
  query: string;
  filters?: PrecedentFilters;
  includeGraphDerived: boolean;
  limit: number;
  latencyMs: number;
}

function base(a: SearchAudit) {
  return {
    requestId: a.requestId,
    ownerUserId: a.owner.userId,
    accountId: a.owner.accountId,
    question: a.query,
    allowedProviders: [] as string[],
    latencyMs: a.latencyMs,
  };
}

/** One summary per search: the request's options and the hits, ids and labels only. */
export function searchSummary(a: SearchAudit, result: PrecedentSearchResult): string {
  return JSON.stringify({
    kind: "precedent_search",
    filters: a.filters ?? {},
    includeGraphDerived: a.includeGraphDerived,
    limit: a.limit,
    graphAvailable: result.graphAvailable,
    hits: result.hits.map((h) => ({
      sourceId: h.sourceId,
      origin: h.origin,
      ...(h.via ? { via: h.via } : {}),
      ...(h.flags.length ? { flags: h.flags } : {}),
    })),
  });
}

export async function auditSearch(
  db: Db,
  a: SearchAudit,
  result: PrecedentSearchResult,
): Promise<void> {
  await db.insert(aiAuditRecords).values({
    ...base(a),
    outcome: result.hits.length > 0 ? "answered" : "unanswerable",
    responseText: searchSummary(a, result),
  });
}

export async function auditSearchFailure(db: Db, a: SearchAudit, error: string): Promise<void> {
  await db.insert(aiAuditRecords).values({ ...base(a), outcome: "error", error });
}
