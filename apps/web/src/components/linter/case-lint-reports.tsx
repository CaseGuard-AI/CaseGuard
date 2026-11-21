"use client";

import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { SeverityCounts } from "./findings";
import { useLintReports } from "./queries";

// The lint reports card of the case dashboard (FR-CASE-4, FR-CASE-5). Each report opens on the
// linter screen; "Lint a document" opens it with this case preselected. An archived case keeps
// its reports but takes no new ones, so the link is left out.
export function CaseLintReports({ caseId, archived }: { caseId: string; archived: boolean }) {
  const t = useTranslations("Linter.card");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const reports = useLintReports(caseId);
  const items = reports.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="rounded-md border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("body")}</p>
        </div>
        {!archived && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/linter?case=${caseId}`}>
              <ShieldCheck aria-hidden />
              {t("lint")}
            </Link>
          </Button>
        )}
      </div>
      <div className="mt-4">
        {reports.isPending && (
          <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {t("loading")}
          </p>
        )}
        {reports.isError && items.length === 0 && (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
            <p>{t("error")}</p>
            <Button variant="outline" size="sm" onClick={() => void reports.refetch()}>
              {t("retry")}
            </Button>
          </div>
        )}
        {reports.isSuccess && items.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        )}
        {items.length > 0 && (
          <ul aria-label={t("title")} className="divide-y rounded-md border">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/linter?report=${item.id}`}
                  className="block px-4 py-3 transition-colors hover:bg-accent"
                >
                  <span className="block truncate text-sm" dir="auto">
                    {item.title}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <SeverityCounts counts={item.findingCounts} />
                    {format.relativeTime(new Date(item.createdAt), now)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {reports.hasNextPage && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 w-full"
            disabled={reports.isFetchingNextPage}
            onClick={() => reports.fetchNextPage()}
          >
            {reports.isFetchingNextPage && <LoaderCircle className="animate-spin" aria-hidden />}
            {t("loadMore")}
          </Button>
        )}
      </div>
    </section>
  );
}
