"use client";

import { ExternalLink } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TrustBadge } from "@/components/trust-badge";
import { dirOf, langOf } from "@/lib/language";
import { useCitation, useSource } from "./queries";
import type { Numbered } from "./sources-list";
import { FlagChips, LastVerified } from "./trust-details";

/** Only a web URL may become a link, so a `javascript:` value from upstream can never run. */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export function SourcePanel({ item, onClose }: { item: Numbered | null; onClose: () => void }) {
  const t = useTranslations("Research.source");
  const tCommon = useTranslations("Common");
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="end"
        closeLabel={tCommon("close")}
        className="w-full overflow-y-auto sm:max-w-lg"
      >
        <SheetHeader>
          <SheetTitle>
            {t("title")}
            {item && <span className="text-muted-foreground"> [{item.n}]</span>}
          </SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        {item && <PanelBody item={item} />}
      </SheetContent>
    </Sheet>
  );
}

function PanelBody({ item }: { item: Numbered }) {
  const t = useTranslations("Research.source");
  const format = useFormatter();
  const citation = useCitation(item.citation).data;
  const { verification } = citation;
  const source = useSource(citation.sourceId);
  const official = safeUrl(source.data?.officialUrl);

  return (
    <div className="space-y-6 px-4 pb-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TrustBadge status={verification.status} />
          <LastVerified at={verification.lastVerifiedAt} />
        </div>
        <FlagChips flags={verification.flags} />
      </div>

      <div>
        <h3 className="text-xs text-muted-foreground">{t("claim")}</h3>
        <p className="mt-1 text-sm leading-6" dir="auto">
          {citation.claim}
        </p>
      </div>

      {citation.quote && (
        <div>
          <h3 className="text-sm font-bold">{t("quote")}</h3>
          <blockquote
            lang={langOf(citation.quoteLanguage)}
            dir={dirOf(citation.quoteLanguage)}
            className="mt-3 border-s-2 border-primary bg-muted/60 p-4 text-sm leading-6 whitespace-pre-line"
          >
            {citation.quote}
          </blockquote>
        </div>
      )}

      {source.isPending && <p className="text-xs text-muted-foreground">{t("loading")}</p>}
      {source.isError && <p className="text-xs text-muted-foreground">{t("unavailable")}</p>}
      {source.data && (
        <>
          <dl className="grid grid-cols-2 gap-5 border-t pt-6 text-xs">
            <Detail label={t("kindLabel")}>{t(`kind.${source.data.kind}`)}</Detail>
            <Detail label={t("citation")}>
              <span dir="ltr">{source.data.citation ?? citation.locator}</span>
            </Detail>
            {source.data.citation && citation.locator && (
              <Detail label={t("locator")}>
                <span dir="ltr">{citation.locator}</span>
              </Detail>
            )}
            <Detail label={t("court")}>{source.data.court}</Detail>
            <Detail label={t("decidedOn")}>
              {source.data.decidedOn &&
                format.dateTime(new Date(source.data.decidedOn), {
                  dateStyle: "medium",
                  timeZone: "UTC",
                })}
            </Detail>
            <Detail label={t("tier")}>
              {source.data.sourceTier && t("tierValue", { tier: source.data.sourceTier })}
            </Detail>
          </dl>
          <p
            className="text-sm font-semibold"
            lang={langOf(source.data.language)}
            dir={dirOf(source.data.language)}
          >
            {source.data.title}
          </p>
          {(source.data.thirdParty || source.data.headnoteOnly) && (
            <p className="text-xs font-semibold text-warning">
              {[
                source.data.thirdParty && t("thirdParty"),
                source.data.headnoteOnly && t("headnoteOnly"),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {source.data.excerpt && (
            <div>
              <h3 className="text-sm font-bold">{t("excerpt")}</h3>
              <p
                lang={langOf(source.data.language)}
                dir={dirOf(source.data.language)}
                className="mt-3 rounded-sm border p-4 text-sm leading-6 whitespace-pre-line text-muted-foreground"
              >
                {source.data.excerpt}
              </p>
            </div>
          )}
          {official && (
            <Button asChild>
              <a href={official} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden />
                {t("openOfficial")}
              </a>
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  if (!children) return null;
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-semibold">{children}</dd>
    </div>
  );
}
