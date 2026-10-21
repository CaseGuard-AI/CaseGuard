"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { apiGet } from "@/lib/api";

// Dev aid: shows whether apps/api answers. Proves the web → api wiring end to end.
export function ApiStatus() {
  const t = useTranslations("Status");
  const { isSuccess, isPending } = useQuery({
    queryKey: ["health"],
    queryFn: () => apiGet<{ status: string }>("/health"),
  });
  if (isPending) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {t("api")}:{" "}
      <span className={isSuccess ? "text-success" : "text-danger"}>
        {isSuccess ? t("up") : t("down")}
      </span>
    </p>
  );
}
