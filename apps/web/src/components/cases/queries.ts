"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Schemas } from "@/lib/api";
import { statusOf, unwrap } from "@/lib/api-query";

export type Case = Schemas["Case"];
export type CaseInput = Schemas["CaseInput"];
export type CaseUpdate = Schemas["CaseUpdate"];
export type Party = Schemas["Party"];
export type CaseState = "active" | "archived" | "all";

// Every cases query starts with `casesKey`, so one invalidation refreshes the lists, the case
// itself and its research after any change.
export const casesKey = ["cases"] as const;
const listKey = (state: CaseState) => [...casesKey, "list", state] as const;
export const caseKey = (id: string) => [...casesKey, "case", id] as const;
const caseConversationsKey = (id: string) => [...casesKey, "case", id, "conversations"] as const;
const PAGE = 20;

/** A case that is gone, isn't the caller's, or isn't a valid id: asking again won't help. */
export const isMissing = (error: unknown) => {
  const status = statusOf(error);
  return status === 404 || status === 400;
};

// The user's cases, most recently updated first (FR-CASE-1), a page at a time.
export function useCases(state: CaseState = "active") {
  return useInfiniteQuery({
    queryKey: listKey(state),
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/cases", { params: { query: { state, cursor: pageParam, limit: PAGE } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useCase(id: string | null) {
  return useQuery({
    queryKey: caseKey(id ?? ""),
    queryFn: () => unwrap(api.GET("/cases/{caseId}", { params: { path: { caseId: id! } } })),
    enabled: Boolean(id),
    retry: (count, error) => !isMissing(error) && count < 1,
  });
}

// The research saved to one case (FR-CASE-4), newest first.
export function useCaseConversations(caseId: string) {
  return useInfiniteQuery({
    queryKey: caseConversationsKey(caseId),
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/conversations", {
          params: { query: { caseId, cursor: pageParam, limit: PAGE } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

// The saved case goes into the cache before the lists are refreshed, so its page shows at once.
function useSaved() {
  const client = useQueryClient();
  return (saved: Case) => {
    client.setQueryData(caseKey(saved.id), saved);
    void client.invalidateQueries({ queryKey: casesKey });
  };
}

export function useCreateCase() {
  const onSaved = useSaved();
  return useMutation({
    mutationFn: (body: CaseInput) => unwrap(api.POST("/cases", { body })),
    onSuccess: onSaved,
  });
}

export function useUpdateCase(caseId: string) {
  const onSaved = useSaved();
  return useMutation({
    mutationFn: (body: CaseUpdate) =>
      unwrap(api.PATCH("/cases/{caseId}", { params: { path: { caseId } }, body })),
    onSuccess: onSaved,
  });
}

/** Archives the case, or unarchives it with `false`. Both are idempotent in the API. */
export function useArchiveCase(caseId: string) {
  const onSaved = useSaved();
  return useMutation({
    mutationFn: (archived: boolean) =>
      unwrap(
        archived
          ? api.POST("/cases/{caseId}/archive", { params: { path: { caseId } } })
          : api.POST("/cases/{caseId}/unarchive", { params: { path: { caseId } } }),
      ),
    onSuccess: onSaved,
  });
}
