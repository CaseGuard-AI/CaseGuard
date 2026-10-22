"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { getServerSnapshot, getSnapshot, restore, subscribe } from "@/lib/session";

/** Restores the session once per tab, from another tab or through the refresh cookie. */
export function SessionProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void restore();
  }, []);
  return children;
}

export function useSession() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
