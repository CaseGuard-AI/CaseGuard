"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type Schemas } from "@/lib/api";
import { ApiError, unwrap } from "@/lib/api-query";

export type PrecedentSearch = Schemas["PrecedentSearch"];
export type PrecedentFilters = Schemas["PrecedentFilters"];
export type PrecedentHit = Schemas["PrecedentHit"];
export type PrecedentResult = Schemas["PrecedentSearchResult"];
export type Relationship = Schemas["Relationship"];
export type EdgeType = Schemas["GraphEdgeType"];

/** The search's error message key under `Precedents.errors`. */
export function precedentErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return "network";
  if (error.status === 429) return "tooMany";
  if (error.status === 503) return "unavailable";
  if (error.status === 400) return "invalid";
  return "generic";
}

// A search is a POST with no lasting effect on the server beyond its audit record, so it is a
// mutation: each submit is one search, and the last result stays on screen.
export function useSearchPrecedents() {
  return useMutation({
    mutationFn: (body: PrecedentSearch) => unwrap(api.POST("/precedents/search", { body })),
  });
}

// A judgment's typed relationships with provenance and status (FR-PREC-4).
export function useRelationships(sourceId: string | null) {
  return useQuery({
    queryKey: ["precedent-relationships", sourceId ?? ""],
    queryFn: () =>
      unwrap(
        api.GET("/precedents/{sourceId}/relationships", {
          params: { path: { sourceId: sourceId! } },
        }),
      ),
    enabled: Boolean(sourceId),
    retry: false,
  });
}
