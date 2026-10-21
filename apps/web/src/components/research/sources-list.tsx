"use client";

import { useTranslations } from "next-intl";
import { TrustBadge } from "@/components/trust-badge";
import { dirOf, langOf } from "@/lib/language";
import { useCitation, useSource, type Citation } from "./queries";

export type Numbered = { citation: Citation; n: number };

// The evidence column beside an answer: one row per citation (FR-RES-7).
export function SourcesList({
  items,
  onOpen,
}: {
  items: Numbered[];
  onOpen: (item: Numbered) => void;
}) {
  const t = useTranslations("Research");
  return (
    <section aria-label={t("sources")} className="rounded-md border bg-card p-5">
      <h3 className="mb-4 text-sm font-bold">{t("sources")}</h3>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.citation.id}>
            <SourceRow item={item} onOpen={() => onOpen(item)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SourceRow({ item, onOpen }: { item: Numbered; onOpen: () => void }) {
  const t = useTranslations("Research.source");
  const citation = useCitation(item.citation).data;
  const source = useSource(citation.sourceId).data;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-sm border p-3 text-start transition-colors hover:border-primary hover:bg-info-soft"
    >
      <div className="flex gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-navy text-xs font-bold text-primary-foreground">
          {item.n}
        </span>
        <div className="min-w-0 space-y-1">
          <p
            className="text-xs font-semibold"
            lang={langOf(source?.language)}
            dir={source ? dirOf(source.language) : "auto"}
          >
            {source?.title ?? citation.locator ?? citation.claim}
          </p>
          {source?.citation && (
            <p className="text-[11px] text-muted-foreground" dir="ltr">
              {source.citation}
            </p>
          )}
          {(source?.thirdParty || source?.headnoteOnly) && (
            <p className="text-[11px] font-semibold text-warning">
              {[source.thirdParty && t("thirdParty"), source.headnoteOnly && t("headnoteOnly")]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          <div className="pt-1">
            <TrustBadge status={citation.verification.status} />
          </div>
        </div>
      </div>
    </button>
  );
}
