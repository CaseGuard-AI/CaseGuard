"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useRouter } from "@/i18n/navigation";
import { safeNext } from "@/lib/safe-next";
import { useSession } from "./session-provider";

// On the login and register pages: once there is a session (restored, or just signed in), go
// where the user was heading.
export function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const session = useSession();
  const next = safeNext(useSearchParams().get("next"));
  const router = useRouter();

  useEffect(() => {
    if (session.status === "authenticated") router.replace(next);
  }, [session.status, next, router]);

  return children;
}
