"use client";

import { useTranslations } from "next-intl";
import { trustStyles } from "@/components/trust-badge";
import { cn } from "@/lib/utils";
import { useCitation, type Citation } from "./queries";

// An inline `[n]` in the answer, coloured by the citation's stored status. Opens the source panel.
export function CitationChip({
  citation,
  n,
  onOpen,
}: {
  citation: Citation;
  n: number;
  onOpen: () => void;
}) {
  const t = useTranslations("Trust");
  const { status } = useCitation(citation).data.verification;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-status={status}
      aria-label={t("chip", { n, status: t(status) })}
      className={cn(
        "mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-sm border px-1 align-middle text-[10px] font-bold",
        trustStyles[status],
      )}
    >
      <bdi>[{n}]</bdi>
    </button>
  );
}
