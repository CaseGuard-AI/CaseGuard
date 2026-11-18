"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, problemOf, type Schemas } from "@/lib/api";
import { ApiError, unwrap } from "@/lib/api-query";

export type Document = Schemas["Document"];
export type DocumentStatus = Schemas["DocumentStatus"];
export type DocumentFlag = Schemas["DocumentFlag"];

// Every documents query starts with `documentsKey`, so one invalidation refreshes all the lists.
export const documentsKey = ["documents"] as const;
const listKey = (caseId?: string) => [...documentsKey, "list", caseId ?? "all"] as const;
const PAGE = 20;
const POLL_MS = 3_000;

/** Still moving: the list keeps polling while any document is in one of these (FR-DOC-3). */
export const isPending = (status: DocumentStatus) => status === "queued" || status === "processing";

// The caller's documents, newest first, optionally of one case (FR-CASE-4).
export function useDocuments(caseId?: string) {
  return useInfiniteQuery({
    queryKey: listKey(caseId),
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/documents", {
          params: { query: { caseId, cursor: pageParam, limit: PAGE } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.items.some((d) => isPending(d.status)))
        ? POLL_MS
        : false,
  });
}

function useRefresh() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: documentsKey });
}

// One file into one case. The API stores it and queues it; nothing is processed in the request.
export function useUploadDocument(caseId: string) {
  const onDone = useRefresh();
  return useMutation({
    mutationFn: (file: File) =>
      unwrap(
        api.POST("/cases/{caseId}/documents", {
          params: { path: { caseId } },
          // The typed body is the schema's `{ file: string }`; what goes on the wire is the FormData
          // below, whose boundary the browser sets.
          body: { file: file.name },
          bodySerializer: () => {
            const form = new FormData();
            form.append("file", file, file.name);
            return form;
          },
        }),
      ),
    onSuccess: onDone,
  });
}

// 202 with no body, so this checks the status rather than unwrapping data.
async function noContent(request: Promise<{ error?: unknown; response: Response }>) {
  const { error, response } = await request;
  if (!response.ok) throw new ApiError(response.status, problemOf(error));
}

export function useDeleteDocument() {
  const onDone = useRefresh();
  return useMutation({
    mutationFn: (documentId: string) =>
      noContent(api.DELETE("/documents/{documentId}", { params: { path: { documentId } } })),
    onSuccess: onDone,
  });
}

export function useRetryDocument() {
  const onDone = useRefresh();
  return useMutation({
    mutationFn: (documentId: string) =>
      unwrap(api.POST("/documents/{documentId}/retry", { params: { path: { documentId } } })),
    onSuccess: onDone,
  });
}

// The file goes through the API with the bearer token, so a plain link can't fetch it: it is read
// as a blob and saved from an object URL under its stored name.
export function useDownloadDocument() {
  return useMutation({
    mutationFn: async (doc: Document) => {
      const { data, error, response } = await api.GET("/documents/{documentId}/file", {
        params: { path: { documentId: doc.id } },
        parseAs: "blob",
      });
      if (!response.ok || !data) {
        throw new ApiError(response.status, problemOf(error));
      }
      const url = URL.createObjectURL(data);
      const link = document.createElement("a");
      link.href = url;
      link.download = doc.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },  });
}
