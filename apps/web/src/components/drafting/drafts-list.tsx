"use client";

import { FileText, LoaderCircle } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useCase } from "@/components/cases/queries";
import { Link } from "@/i18n/navigation";
import { statusOf } from "@/lib/api-query";
import { useDraftTemplates, useDrafts, type DraftSummary } from "./queries";

// The caller's drafts, most recently updated first, all of them or one case's (FR-CASE-4).
export function DraftsList({ caseId, showCase = false }: { caseId?: string; showCase?: boolean }) {
  const t = useTranslations("Drafting.list");
  const drafts = useDrafts(caseId);
  const items = drafts.data?.pages.flatMap((page) => page.items) ?? [];

  if (drafts.isPending)
    return (
      <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );

  if (drafts.isError && items.length === 0)
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
        <p>{t(statusOf(drafts.error) === undefined ? "networkError" : "error")}</p>
        <Button variant="outline" size="sm" onClick={() => void drafts.refetch()}>
          {t("retry")}
        </Button>
      </div>
    );

  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">{t(caseId ? "emptyCase" : "empty")}</p>;

  return (
    <div>
      <ul aria-label={t("label")} className="divide-y rounded-md border">
        {items.map((draft) => (
          <DraftRow key={draft.id} draft={draft} showCase={showCase} />
        ))}
      </ul>
      {drafts.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full"
          disabled={drafts.isFetchingNextPage}
          onClick={() => drafts.fetchNextPage()}
        >
          {drafts.isFetchingNextPage && <LoaderCircle className="animate-spin" aria-hidden />}
          {t("loadMore")}
        </Button>
      )}
    </div>
  );
}

function DraftRow({ draft, showCase }: { draft: DraftSummary; showCase: boolean }) {
  const t = useTranslations("Drafting.list");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const templates = useDraftTemplates();
  const template = templates.data?.items.find((x) => x.id === draft.templateId);

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <Link
          href={`/drafting/${draft.id}`}
          className="block truncate text-sm font-medium hover:underline"
          dir="auto"
        >
          {draft.title}
        </Link>
        <p className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
          {template && <span>{template.title}</span>}
          <span>{t("updated", { time: format.relativeTime(new Date(draft.updatedAt), now) })}</span>
          {showCase && draft.caseId && <CaseName caseId={draft.caseId} />}
        </p>
      </div>
    </li>
  );
}

function CaseName({ caseId }: { caseId: string }) {
  const t = useTranslations("Drafting.list");
  const found = useCase(caseId);
  return (
    <Link href={`/cases/${caseId}`} className="underline-offset-2 hover:underline" dir="auto">
      {found.data?.title ?? t("openCase")}
    </Link>
  );
}
