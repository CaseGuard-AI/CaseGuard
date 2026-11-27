"use client";

import { CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

// A screen that throws while rendering shows this inside the app shell, so the nav still works.
// `retry` re-renders the screen; errors the screens handle themselves (API calls) never get here.
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useTranslations("RouteError");

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="mx-auto mt-12 max-w-md rounded-md border bg-card p-8 text-center">
      <CircleAlert className="mx-auto size-8 text-danger" aria-hidden />
      <h1 className="mt-4 text-lg font-semibold">{t("title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("body")}</p>
      <Button className="mt-6" onClick={() => retry()}>
        {t("retry")}
      </Button>
    </div>
  );
}
