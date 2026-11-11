"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Schemas } from "@/lib/api";
import { ApiError, statusOf, unwrap } from "@/lib/api-query";

export type Citation = Schemas["Citation"];
export type Conversation = Schemas["Conversation"];
export type Message = Schemas["Message"];
export type ConversationSummary = Schemas["ConversationSummary"];

/** The ask box's error message key under `Research.errors`. */
export function researchErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return "network";
  if (error.status === 403) return "aiDisabled";
  if (error.status === 429) return "tooMany";
  if (error.status === 503) return "unavailable";
  return "generic";
}

const conversationKey = (id: string) => ["conversation", id] as const;
export const historyKey = ["conversations"] as const;
const HISTORY_PAGE = 20;

// The research history (FR-RES-8): the user's conversations, most recently active first,
// a page at a time.
export function useConversations() {
  return useInfiniteQuery({
    queryKey: historyKey,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/conversations", {
          params: { query: { cursor: pageParam, limit: HISTORY_PAGE } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: conversationKey(id ?? ""),
    queryFn: () =>
      unwrap(
        api.GET("/conversations/{conversationId}", { params: { path: { conversationId: id! } } }),
      ),
    enabled: Boolean(id),
    retry: (count, error) => statusOf(error) !== 404 && count < 1,
  });
}

// Asks in the given conversation, or starts one first. `onConversation` hears about a new
// conversation as soon as it exists, so a failed ask (403, 503) is retried in the same one.
export function useAsk(onConversation: (id: string) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      conversationId,
      question,
    }: {
      conversationId: string | null;
      question: string;
    }) => {
      let id = conversationId;
      if (!id) {
        const created = await unwrap(api.POST("/conversations", { body: {} }));
        client.setQueryData(conversationKey(created.id), created);
        id = created.id;
        onConversation(id);
      }
      const answer = await unwrap(
        api.POST("/conversations/{conversationId}/messages", {
          params: { path: { conversationId: id } },
          body: { question },
        }),
      );
      return { id, question, answer };
    },
    onSuccess: ({ id, question, answer }) => {
      // The API returns only the answer. Add the question locally rather than reloading the thread.
      const asked: Message = {
        id: `local-${answer.id}`,
        role: "user",
        text: question,
        createdAt: answer.createdAt,
      };
      client.setQueryData<Conversation>(conversationKey(id), (old) =>
        old ? { ...old, messages: [...old.messages, asked, answer] } : old,
      );
      // A new conversation, or one that just moved to the top, shows in the history at once.
      void client.invalidateQueries({ queryKey: historyKey });
    },
  });
}

// The one trust store in the browser (FR-TRUST-10). Every view of a citation reads this entry:
// it starts from the copy saved with the answer and is replaced by the current stored
// verification from the API. If that lookup fails, the saved copy stays.
export function useCitation(citation: Citation) {
  return useQuery({
    queryKey: ["citation", citation.id],
    queryFn: () =>
      unwrap(api.GET("/citations/{citationId}", { params: { path: { citationId: citation.id } } })),
    initialData: citation,
    initialDataUpdatedAt: 0,
    retry: false,
  });
}

export function useSource(sourceId: string) {
  return useQuery({
    queryKey: ["source", sourceId],
    queryFn: () => unwrap(api.GET("/sources/{sourceId}", { params: { path: { sourceId } } })),
    staleTime: Infinity,
    retry: false,
  });
}
