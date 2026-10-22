"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/components/auth/session-provider";
import { api, type Schemas } from "@/lib/api";
import { statusOf, unwrap } from "@/lib/api-query";
import { updateUser } from "@/lib/session";

export type UserSettings = Schemas["UserSettings"];
export type SettingsUpdate = Schemas["UserSettingsUpdate"];

export const settingsKey = ["me", "settings"] as const;

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
