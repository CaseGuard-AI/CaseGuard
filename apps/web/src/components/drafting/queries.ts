"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { api, problemOf, type Schemas } from "@/lib/api";
import { ApiError, unwrap } from "@/lib/api-query";

export type Draft = Schemas["Draft"];
export type DraftSummary = Schemas["DraftSummary"];
export type DraftTemplate = Schemas["DraftTemplate"];
export type DraftTemplateId = Schemas["DraftTemplateId"];
export type DraftUpdate = Schemas["DraftUpdate"];
export type DraftAssist = Schemas["DraftAssist"];

// Every drafts query starts with `draftsKey`, so one invalidation refreshes the lists.
export const draftsKey = ["drafts"] as const;
const listKey = (caseId?: string) => [...draftsKey, "list", caseId ?? "all"] as const;
export const draftKey = (id: string) => [...draftsKey, "draft", id] as const;
const PAGE = 20;

/** The assist error message key under `Drafting.assist.errors`. */
export function assistErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return "network";
  if (error.status === 403) return "aiDisabled";
  if (error.status === 429) return "tooMany";
  if (error.status === 503) return "unavailable";
  return "generic";
}

// The templates change only with a release, so they are fetched once per session.
export function useDraftTemplates() {
  return useQuery({
    queryKey: ["drafting", "templates"],
    queryFn: () => unwrap(api.GET("/drafting/templates")),
    staleTime: Infinity,
  });
}

/** The caller's drafts, most recently updated first, optionally one case's (FR-CASE-4). */
export function useDrafts(caseId?: string) {
  return useInfiniteQuery({
    queryKey: listKey(caseId),
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/drafts", { params: { query: { caseId, cursor: pageParam, limit: PAGE } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

// Citation statuses inside are the trust store's at the time of loading (FR-TRUST-10); the chips
// refresh each one through the shared `["citation", id]` entry.
export function useDraft(id: string) {
  return useQuery({
    queryKey: draftKey(id),
    queryFn: () => unwrap(api.GET("/drafts/{draftId}", { params: { path: { draftId: id } } })),
  });
}

function refreshLists(client: QueryClient) {
  void client.invalidateQueries({ queryKey: [...draftsKey, "list"] });
}

export function useCreateDraft() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { templateId: DraftTemplateId; caseId?: string; title?: string }) =>
      unwrap(api.POST("/drafts", { body })),
    onSuccess: (draft) => {
      client.setQueryData(draftKey(draft.id), draft);
      refreshLists(client);
    },
  });
}

/** Save with the version it was loaded at; a 409 means someone saved in between. */
export function useSaveDraft(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: DraftUpdate) =>
      unwrap(api.PUT("/drafts/{draftId}", { params: { path: { draftId: id } }, body })),
    onSuccess: (draft) => {
      client.setQueryData(draftKey(id), draft);
      refreshLists(client);
    },
  });
}

export function useDeleteDraft(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error, response } = await api.DELETE("/drafts/{draftId}", {
        params: { path: { draftId: id } },
      });
      if (!response.ok) throw new ApiError(response.status, problemOf(error));
    },
    onSuccess: () => {
      client.removeQueries({ queryKey: draftKey(id) });
      refreshLists(client);
    },
  });
}

/** One section drafted by AI. Nothing is saved into the draft (FR-DRAFT-3). */
export function useAssist(id: string, sectionKey: string) {
  return useMutation({
    mutationFn: (instruction: string) =>
      unwrap(
        api.POST("/drafts/{draftId}/sections/{sectionKey}/assist", {
          params: { path: { draftId: id, sectionKey } },
          body: instruction ? { instruction } : {},
        }),
      ),
  });
}

/** A file name for the download, from the draft's title. */
export function exportName(title: string, format: "docx" | "pdf"): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "draft";
  return `${base}.${format}`;
}

// The file comes through the API with the bearer token, so it is read as a blob and saved from an
// object URL (FR-DRAFT-4).
export function useExportDraft(id: string) {
  return useMutation({
    mutationFn: async ({ format, title }: { format: "docx" | "pdf"; title: string }) => {
      const { data, error, response } = await api.GET("/drafts/{draftId}/export", {
        params: { path: { draftId: id }, query: { format } },
        parseAs: "blob",
      });
      if (!response.ok || !data) throw new ApiError(response.status, problemOf(error));
      const url = URL.createObjectURL(data);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportName(title, format);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  });
}
