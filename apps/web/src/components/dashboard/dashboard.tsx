"use client";

import { ArrowRight, Briefcase, LoaderCircle, MessageSquareText, Search } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useConversations } from "@/components/research/queries";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { RECENT_LIMIT, useRecentCases } from "./queries";

// The home screen (FR-DASH-1): a way into research, then the user's latest conversations and
// active cases. Each section loads and fails on its own. Drafts join once they have a contract.
export function Dashboard() {
  const t = useTranslations("Dashboard");
  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 rounded-md border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-bold">{t("ask.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("ask.body")}</p>
        </div>
        <Button asChild>
          <Link href="/research">
            <Search aria-hidden />
            {t("ask.start")}
          </Link>
        </Button>
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <RecentResearch />
        <RecentCases />
      </div>
    </div>
  );
}

function RecentResearch() {
  const t = useTranslations("Dashboard.research");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  // The Research Hub's history query: its first page, of which the dashboard shows the top few.
  const history = useConversations();
  const items = (history.data?.pages[0]?.items ?? []).slice(0, RECENT_LIMIT);

  return (
    <Section
      title={t("title")}
      seeAll={{ href: "/research", label: t("seeAll") }}
      query={history}
      count={items.length}
      empty={t("empty")}
    >
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={`/research?c=${item.id}`}
            className="flex items-start gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent"
          >
            <MessageSquareText
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="min-w-0">
              <span className="block truncate text-sm" dir="auto">
                {item.title}
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {format.relativeTime(new Date(item.updatedAt), now)}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </Section>
  );
}

function RecentCases() {
  const t = useTranslations("Dashboard.cases");
  const format = useFormatter();
  const cases = useRecentCases();
  const items = cases.data?.items ?? [];

  return (
    <Section
      title={t("title")}
      seeAll={{ href: "/cases", label: t("seeAll") }}
      query={cases}
      count={items.length}
      empty={t("empty")}
    >
      {items.map((item) => {
        const details = [item.caseNumber, item.court].filter(Boolean).join(" · ");
        return (
          <li key={item.id}>
            <Link
              href={`/cases/${item.id}`}
              className="flex items-start gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent"
            >
              <Briefcase className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0">
                <span className="block truncate text-sm" dir="auto">
                  {item.title}
                </span>
                {details && (
                  <span className="block truncate text-[11px] text-muted-foreground" dir="auto">
                    {details}
                  </span>
                )}
                {item.nextHearingOn && (
                  <span className="block text-[11px] text-muted-foreground">
                    {t("nextHearing", {
                      // A calendar date: format it in UTC so no time zone moves it a day.
                      date: format.dateTime(new Date(item.nextHearingOn), {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      }),
                    })}
                  </span>
                )}
              </span>
            </Link>
          </li>
        );
      })}
    </Section>
  );
}

// A dashboard card: heading with "See all", then loading, error (with retry), empty or the list.
function Section({
  title,
  seeAll,
  query,
  count,
  empty,
  children,
}: {
  title: string;
  seeAll: { href: string; label: string };
  query: { isPending: boolean; isError: boolean; isSuccess: boolean; refetch: () => unknown };
  count: number;
  empty: string;
  children: ReactNode;
}) {
  const t = useTranslations("Dashboard");
  return (
    <section aria-label={title} className="space-y-4 rounded-md border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold">{title}</h2>
        <Button asChild variant="link" size="sm" className="px-0">
          <Link href={seeAll.href}>
            {seeAll.label}
            <ArrowRight className="rtl:rotate-180" aria-hidden />
          </Link>
        </Button>
      </div>

      {query.isPending && (
        <p aria-busy="true" className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" aria-hidden />
          {t("loading")}
        </p>
      )}
      {query.isError && count === 0 && (
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>{t("error")}</p>
          <Button variant="link" size="xs" className="px-0" onClick={() => query.refetch()}>
            {t("retry")}
          </Button>
        </div>
      )}
      {query.isSuccess && count === 0 && <p className="text-xs text-muted-foreground">{empty}</p>}
      {count > 0 && <ul className="space-y-1">{children}</ul>}
    </section>
  );
}
