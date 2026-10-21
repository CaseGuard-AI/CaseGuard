"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { api, type Schemas } from "@/lib/api";
import { statusOf, unwrap } from "@/lib/api-query";

export type AdminUser = Schemas["AdminUser"];
export type Provider = Schemas["Provider"];
type UsersPage = { items: AdminUser[]; nextCursor?: string | null };

const usersKey = ["admin", "users"] as const;
const providersKey = ["admin", "providers"] as const;
const PAGE_SIZE = 50;

// Retry only a request that got no answer. A 403 or 404 won't change by asking again.
const retryNetwork = (count: number, error: unknown) => statusOf(error) === undefined && count < 1;

export function useAdminUsers() {
  return useInfiniteQuery({
    queryKey: usersKey,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/admin/users", { params: { query: { limit: PAGE_SIZE, cursor: pageParam } } }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: UsersPage) => last.nextCursor ?? undefined,
    retry: retryNetwork,
  });
}

// Each row owns its mutation, so its pending and error state stay on that row. The switch
// shows the server's value: the cache changes only when the PATCH succeeds.
export function useSetUserAi(userId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (aiEnabled: boolean) =>
      unwrap(
        api.PATCH("/admin/users/{userId}", { params: { path: { userId } }, body: { aiEnabled } }),
      ),
    onSuccess: (user) =>
      client.setQueryData<InfiniteData<UsersPage>>(usersKey, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                items: page.items.map((u) => (u.id === user.id ? user : u)),
              })),
            }
          : old,
      ),
    // A 403 means this session lost the Admin role: reload, and the panel shows "Admins only".
    onError: (error) => {
      if (statusOf(error) === 403) void client.invalidateQueries({ queryKey: usersKey });
    },
  });
}

export function useProviders() {
  return useQuery({
    queryKey: providersKey,
    queryFn: () => unwrap(api.GET("/admin/providers")),
    retry: retryNetwork,
  });
}

export function useSetProvider(providerId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      unwrap(
        api.PATCH("/admin/providers/{providerId}", {
          params: { path: { providerId } },
          body: { enabled },
        }),
      ),
    onSuccess: (provider) =>
      client.setQueryData<{ items: Provider[] }>(providersKey, (old) =>
        old ? { items: old.items.map((p) => (p.id === provider.id ? provider : p)) } : old,
      ),
    onError: (error) => {
      if (statusOf(error) === 403) void client.invalidateQueries({ queryKey: providersKey });
    },
  });
}

/** The message key under `Admin.errors` for a failed change. */
export const changeErrorKey = (error: unknown) =>
  statusOf(error) === undefined ? "network" : "generic";
