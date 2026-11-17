"use client";

import { LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { statusOf } from "@/lib/api-query";
import { isMissing } from "./queries";

// Loading, failed and missing states for a page about one case (the dashboard and its edit form).
// A case that is gone or isn't the caller's (FR-AUTH-4) reads as not found, inside the shell.
export function CaseLoadState({
  pending,
  error,
  onRetry,
}: {
  pending: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const t = useTranslations("Cases.dashboard");
  if (pending) {
    return (
      <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );
  }
  if (isMissing(error)) {
    return (
      <div className="rounded-md border bg-card p-8 text-center">
        <h1 className="text-xl font-bold">{t("notFoundTitle")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("notFoundBody")}</p>
        <Button asChild className="mt-6">
          <Link href="/cases">{t("back")}</Link>
        </Button>
      </div>
    );
  }
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
      <p>{t(statusOf(error) === undefined ? "networkError" : "loadError")}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("retry")}
      </Button>
    </div>
  );
}
