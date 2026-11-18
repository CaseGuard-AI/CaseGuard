"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, problemOf, type Schemas } from "@/lib/api";
import { ApiError, unwrap } from "@/lib/api-query";

export type Notification = Schemas["Notification"];

const PAGE = 20;
// How often the bell asks for the unread count. There is no push in P1 (FR-NOT-1).
export const POLL_MS = 60_000;

// Every notifications query starts with `notificationsKey`, so marking read refreshes the
// count and the list together.
export const notificationsKey = ["notifications"] as const;
const unreadKey = [...notificationsKey, "unread"] as const;
const listKey = [...notificationsKey, "list"] as const;

/** The caller's unread total: one notification is enough, `unreadCount` is the whole total. */
export function useUnreadCount() {
  return useQuery({
    queryKey: unreadKey,
    queryFn: async () =>
      (await unwrap(api.GET("/notifications", { params: { query: { limit: 1 } } }))).unreadCount,
    refetchInterval: POLL_MS,
  });
}

/** The list in the sheet, newest first, loaded only while the sheet is open. */
export function useNotifications(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/notifications", { params: { query: { cursor: pageParam, limit: PAGE } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
  });
}

/** Throws unless the answer is a 2xx; these endpoints answer 204 with no body. */
async function noContent(request: Promise<{ error?: unknown; response: Response }>) {
  const { error, response } = await request;
  if (!response.ok) throw new ApiError(response.status, problemOf(error));
}

function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: notificationsKey });
}

export function useMarkRead() {
  const onDone = useRefresh();
  return useMutation({
    mutationFn: (notificationId: string) =>
      noContent(
        api.POST("/notifications/{notificationId}/read", {
          params: { path: { notificationId } },
        }),
      ),
    onSuccess: onDone,
  });
}

export function useMarkAllRead() {
  const onDone = useRefresh();
  return useMutation({
    mutationFn: () => noContent(api.POST("/notifications/read-all")),
    onSuccess: onDone,
  });
}
