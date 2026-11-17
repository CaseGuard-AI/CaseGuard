"use client";

import { CalendarDays, LoaderCircle } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "@/i18n/navigation";
import { formatDay } from "./format";
import { useCases, type CaseState } from "./queries";

const tabs = ["active", "archived"] as const satisfies CaseState[];

// The user's cases (FR-CASE-1): active ones by default, archived ones on their own tab. Each
// tab loads only when it is opened.
export function CasesList() {
  const t = useTranslations("Cases");
  const [tab, setTab] = useState<(typeof tabs)[number]>("active");

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as (typeof tabs)[number])}>
      <TabsList aria-label={t("list.label")}>
        {tabs.map((state) => (
          <TabsTrigger key={state} value={state} className="px-4">
            {t(`tabs.${state}`)}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((state) => (
        <TabsContent key={state} value={state} className="mt-2">
          <CasePage state={state} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function CasePage({ state }: { state: (typeof tabs)[number] }) {
  const t = useTranslations("Cases");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const cases = useCases(state);
  const items = cases.data?.pages.flatMap((page) => page.items) ?? [];

  if (cases.isPending) {
    return (
      <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        {t("list.loading")}
      </p>
    );
  }
  if (cases.isError && items.length === 0) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
        <p>{t("list.error")}</p>
        <Button variant="outline" size="sm" onClick={() => void cases.refetch()}>
          {t("list.retry")}
        </Button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
        {t(state === "active" ? "list.emptyActive" : "list.emptyArchived")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-md border bg-card">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={`/cases/${item.id}`}
              className="block px-4 py-3 transition-colors hover:bg-accent sm:px-5"
            >
              <span className="block truncate text-sm font-semibold" dir="auto">
                {item.title}
              </span>
              <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {item.caseNumber && <span dir="auto">{item.caseNumber}</span>}
                {item.court && <span dir="auto">{item.court}</span>}
                {item.nextHearingOn && (
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="size-3" aria-hidden />
                    {t("list.nextHearing", { date: formatDay(format, item.nextHearingOn) })}
                  </span>
                )}
                <span>
                  {t("list.updated", { time: format.relativeTime(new Date(item.updatedAt), now) })}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {cases.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={cases.isFetchingNextPage}
          onClick={() => cases.fetchNextPage()}
        >
          {cases.isFetchingNextPage && <LoaderCircle className="animate-spin" aria-hidden />}
          {t("list.loadMore")}
        </Button>
      )}
    </div>
  );
}
