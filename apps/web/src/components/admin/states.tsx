"use client";

import { LoaderCircle, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/** Shown to a User, and whenever the API answers 403 to this session. */
export function Forbidden() {
  const t = useTranslations("Admin");
  return (
    <div
      role="alert"
      className="flex max-w-xl gap-3 rounded-md border border-warning/20 bg-warning-soft p-5"
    >
      <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-semibold">{t("forbidden")}</p>
        <p className="text-sm text-muted-foreground">{t("forbiddenBody")}</p>
      </div>
    </div>
  );
}

export function Loading() {
  const t = useTranslations("Admin");
  return (
    <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" aria-hidden />
      {t("loading")}
    </p>
  );
}

export function LoadError({ network, onRetry }: { network: boolean; onRetry: () => void }) {
  const t = useTranslations("Admin");
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
      <p>{t(network ? "errors.network" : "loadError")}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("retry")}
      </Button>
    </div>
  );
}
