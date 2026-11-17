"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type Schemas } from "@/lib/api";
import { unwrap } from "@/lib/api-query";

export type Case = Schemas["Case"];

export const RECENT_LIMIT = 5;
export const recentCasesKey = ["cases", "recent"] as const;

// The user's active cases, most recently updated first (FR-DASH-1). Replaced by the cases
// module's own query (#99) once it is merged, so one key covers cases everywhere.
export function useRecentCases() {
  return useQuery({
    queryKey: recentCasesKey,
    queryFn: () => unwrap(api.GET("/cases", { params: { query: { limit: RECENT_LIMIT } } })),
  });
}
