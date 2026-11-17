"use client";

import { useQuery } from "@tanstack/react-query";
import { casesKey } from "@/components/cases/queries";
import { api } from "@/lib/api";
import { unwrap } from "@/lib/api-query";

export const RECENT_LIMIT = 5;
// Under the cases module's key, so every case change (#99) refreshes the dashboard too.
export const recentCasesKey = [...casesKey, "recent"] as const;

// The user's active cases, most recently updated first (FR-DASH-1). Only the first few, so not
// the cases module's paged `useCases`, which loads 20 at a time.
export function useRecentCases() {
  return useQuery({
    queryKey: recentCasesKey,
    queryFn: () => unwrap(api.GET("/cases", { params: { query: { limit: RECENT_LIMIT } } })),
  });
}
