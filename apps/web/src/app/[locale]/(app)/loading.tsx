"use client";

import { LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";

// Shown inside the app shell while a screen streams in. A client component, so it reads the
// messages from the provider rather than needing the locale from the request.
export default function AppLoading() {
  const t = useTranslations("Common");
  return (
    <p aria-busy="true" className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" aria-hidden />
      {t("loading")}
    </p>
  );
}
