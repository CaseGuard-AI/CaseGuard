"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/components/auth/session-provider";
import { api, problemOf, type Schemas } from "@/lib/api";
import { ApiError, statusOf, unwrap } from "@/lib/api-query";
import { updateUser } from "@/lib/session";

export type UserSettings = Schemas["UserSettings"];
export type SettingsUpdate = Schemas["UserSettingsUpdate"];
export type DefaultModel = Schemas["DefaultModel"];
export type UserKey = Schemas["UserKey"];
export type ProviderModels = Schemas["ProviderModels"];

export const settingsKey = ["me", "settings"] as const;
export const keysKey = ["me", "keys"] as const;
export const modelsKey = ["models"] as const;

// Retry only a request that got no answer, as the admin console does.
const retryNetwork = (count: number, error: unknown) => statusOf(error) === undefined && count < 1;

/** The signed-in user's settings (FR-SET-1). Waits for the session, so it never sends a 401. */
export function useSettings() {
  const signedIn = useSession().status === "authenticated";
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => unwrap(api.GET("/me/settings")),
    enabled: signedIn,
    retry: retryNetwork,
  });
}

export const saveSettings = (body: SettingsUpdate) => unwrap(api.PATCH("/me/settings", { body }));

// The cache and the session change only when the PATCH succeeds, so the page shows saved values.
export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: saveSettings,
    onSuccess: (settings) => {
      client.setQueryData(settingsKey, settings);
      updateUser({ name: settings.name, locale: settings.locale });
    },
  });
}

/** The caller's saved provider keys, `last4` only (FR-SET-2). */
export function useKeys() {
  const signedIn = useSession().status === "authenticated";
  return useQuery({
    queryKey: keysKey,
    queryFn: () => unwrap(api.GET("/me/keys")),
    enabled: signedIn,
    retry: retryNetwork,
  });
}

/** The enabled providers and their models, with whether the caller has a key for each. */
export function useModels() {
  const signedIn = useSession().status === "authenticated";
  return useQuery({
    queryKey: modelsKey,
    queryFn: () => unwrap(api.GET("/models")),
    enabled: signedIn,
    retry: retryNetwork,
  });
}

// A saved or deleted key changes both lists: `/me/keys`, and `hasKey` in `/models`.
function useInvalidateKeys() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keysKey }),
      client.invalidateQueries({ queryKey: modelsKey }),
    ]);
}

/** Saves or replaces the key for one provider. The key is only ever in the request body. */
export function usePutKey() {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ providerId, apiKey }: { providerId: string; apiKey: string }) =>
      unwrap(
        api.PUT("/me/keys/{providerId}", { params: { path: { providerId } }, body: { apiKey } }),
      ),
    onSuccess: invalidate,
    // The mutation cache would otherwise keep the key (as `variables`) for five minutes.
    gcTime: 0,
  });
}

export function useDeleteKey() {
  const invalidate = useInvalidateKeys();
  return useMutation({
    // A 204 has no body, so `unwrap` (which needs data) doesn't fit here.
    mutationFn: async (providerId: string) => {
      const { error, response } = await api.DELETE("/me/keys/{providerId}", {
        params: { path: { providerId } },
      });
      if (!response.ok) throw new ApiError(response.status, problemOf(error));
    },
    onSuccess: invalidate,
  });
}
