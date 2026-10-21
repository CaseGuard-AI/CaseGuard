"use client";

import { LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { usePathname, useRouter } from "@/i18n/navigation";
import { refresh } from "@/lib/session";
import { useSession } from "./session-provider";

// Every page in the app shell needs a session (FR-AUTH-1). The API still checks every call;
// this only decides what the browser shows.
export function RequireSession({ children }: { children: ReactNode }) {
  const t = useTranslations("Auth.session");
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (session.status === "anonymous") {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [session.status, pathname, router]);

  if (session.status === "authenticated") return children;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      {session.status === "unavailable" ? (
        <div role="alert" className="flex max-w-sm flex-col items-center gap-4 text-center">
          <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
          <Button onClick={() => void refresh({ force: true })}>{t("retry")}</Button>
        </div>
      ) : (
        <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          {t("checking")}
        </p>
      )}
    </div>
  );
}
