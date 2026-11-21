"use client";

import { ArrowDownLeft, ArrowUpRight, ExternalLink } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { safeUrl } from "@/components/research/source-panel";
import { useSource } from "@/components/research/queries";
import { TrustBadge } from "@/components/trust-badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { statusOf } from "@/lib/api-query";
import { useRelationships, type PrecedentHit, type Relationship } from "./queries";

// A judgment's typed relationships, each with its provenance and stored status (FR-PREC-2,
// FR-PREC-4). Outgoing and incoming edges are listed apart. An entity that is a corpus record
// opens its source; one only named in the text is shown by its label.
export function RelationshipsPanel({
  hit,
  onClose,
}: {
  hit: PrecedentHit | null;
  onClose: () => void;
}) {
  const t = useTranslations("Precedents.relationships");
  const tCommon = useTranslations("Common");
  const [source, setSource] = useState<{ id: string; label: string } | null>(null);
  return (
    <Sheet
      open={hit !== null}
      onOpenChange={(open) => {
        if (!open) {
          setSource(null);
          onClose();
        }
      }}
    >
      <SheetContent
        side="end"
        closeLabel={tCommon("close")}
        className="w-full overflow-y-auto sm:max-w-lg"
      >
        <SheetHeader>
          <SheetTitle dir="auto">{source ? source.label : (hit?.title ?? t("title"))}</SheetTitle>
          <SheetDescription>{source ? t("sourceDescription") : t("description")}</SheetDescription>
        </SheetHeader>
        {hit && !source && <RelationshipsBody sourceId={hit.sourceId} onOpenSource={setSource} />}
        {source && <SourceBody sourceId={source.id} onBack={() => setSource(null)} />}
      </SheetContent>
    </Sheet>
  );
}

function RelationshipsBody({
  sourceId,
  onOpenSource,
}: {
  sourceId: string;
  onOpenSource: (s: { id: string; label: string }) => void;
}) {
  const t = useTranslations("Precedents.relationships");
  const query = useRelationships(sourceId);
  if (query.isPending) return <p className="px-4 text-xs text-muted-foreground">{t("loading")}</p>;
  if (query.isError) {
    return (
      <p role="alert" className="px-4 text-xs text-muted-foreground">
        {statusOf(query.error) === 404 ? t("notFound") : t("unavailable")}
      </p>
    );
  }
  const items = query.data.items;
  if (items.length === 0) {
    return <p className="px-4 text-sm text-muted-foreground">{t("none")}</p>;
  }
  const groups = [
    { key: "outgoing" as const, Icon: ArrowUpRight },
    { key: "incoming" as const, Icon: ArrowDownLeft },
  ];
  return (
    <div className="space-y-6 px-4 pb-6">
      {groups.map(({ key, Icon }) => {
        const group = items.filter((r) => r.direction === key);
        if (group.length === 0) return null;
        return (
          <section key={key} aria-label={t(key)}>
            <h3 className="mb-2 flex items-center gap-1 text-xs font-bold text-muted-foreground uppercase">
              <Icon className="size-3.5" aria-hidden />
              {t(key)}
            </h3>
            <ul className="space-y-2">
              {group.map((r) => (
                <RelationshipRow key={r.id} relationship={r} onOpenSource={onOpenSource} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function RelationshipRow({
  relationship: r,
  onOpenSource,
}: {
  relationship: Relationship;
  onOpenSource: (s: { id: string; label: string }) => void;
}) {
  const t = useTranslations("Precedents");
  const format = useFormatter();
  const { other, provenance } = r;
  return (
    <li data-relationship={r.id} data-type={r.type} className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold">{t(`edgeTypes.${r.type}`)}</span>
        <TrustBadge status={r.verificationStatus} />
      </div>
      <p className="text-sm">
        <span className="me-1 text-[11px] text-muted-foreground">
          {t(`relationships.entityTypes.${other.entityType}`)}
        </span>
        {other.sourceId ? (
          <button
            type="button"
            className="font-medium text-primary hover:underline"
            onClick={() => onOpenSource({ id: other.sourceId!, label: other.label })}
            aria-label={t("relationships.openSource", { label: other.label })}
          >
            <bdi>{other.label}</bdi>
          </button>
        ) : (
          <bdi className="font-medium">{other.label}</bdi>
        )}
      </p>
      <dl className="grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <dt className="text-muted-foreground">{t("relationships.method")}</dt>
          <dd data-method={provenance.extractionMethod}>
            {t(`relationships.methods.${provenance.extractionMethod}`)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("relationships.confidence")}</dt>
          <dd>{format.number(provenance.confidence, { style: "percent" })}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("relationships.humanConfirmed")}</dt>
          <dd>{provenance.humanConfirmed ? t("relationships.yes") : t("relationships.no")}</dd>
        </div>
      </dl>
      {r.validFrom && (
        <p className="text-[11px] text-muted-foreground">
          {t("relationships.validFrom", {
            date: format.dateTime(new Date(r.validFrom), { dateStyle: "medium", timeZone: "UTC" }),
          })}
        </p>
      )}
    </li>
  );
}

function SourceBody({ sourceId, onBack }: { sourceId: string; onBack: () => void }) {
  const t = useTranslations("Precedents.source");
  const format = useFormatter();
  const source = useSource(sourceId);
  const official = safeUrl(source.data?.officialUrl);
  return (
    <div className="space-y-4 px-4 pb-6">
      <Button variant="outline" size="sm" onClick={onBack}>
        {t("back")}
      </Button>
      {source.isPending && <p className="text-xs text-muted-foreground">{t("loading")}</p>}
      {source.isError && <p className="text-xs text-muted-foreground">{t("unavailable")}</p>}
      {source.data && (
        <>
          <p className="text-sm font-semibold" dir="auto">
            {source.data.title}
          </p>
          <dl className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <dt className="text-muted-foreground">{t("citation")}</dt>
              <dd dir="ltr">{source.data.citation}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("court")}</dt>
              <dd>{source.data.court}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("decidedOn")}</dt>
              <dd>
                {source.data.decidedOn &&
                  format.dateTime(new Date(source.data.decidedOn), {
                    dateStyle: "medium",
                    timeZone: "UTC",
                  })}
              </dd>
            </div>
          </dl>
          {official && (
            <a
              href={official}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {t("official")}
            </a>
          )}
        </>
      )}
    </div>
  );
}
