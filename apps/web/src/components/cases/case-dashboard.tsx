"use client";

import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  LoaderCircle,
  Network,
  Pencil,
  Search,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { CaseDocuments } from "@/components/documents/case-documents";
import { CaseLintReports } from "@/components/linter/case-lint-reports";
import { CaseDrafts } from "@/components/drafting/case-drafts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { statusOf } from "@/lib/api-query";
import { formatDay } from "./format";
import { useArchiveCase, useCase, useCaseConversations, type Case, type Party } from "./queries";
import { CaseLoadState } from "./states";

// The case dashboard (FR-CASE-4): the case's fields, its research, documents, lint reports and
// drafts, and a way into precedent search. Nothing here is sample data.
export function CaseDashboard({ caseId }: { caseId: string }) {
  const found = useCase(caseId);

  if (!found.isSuccess)
    return (
      <CaseLoadState
        pending={found.isPending}
        error={found.error}
        onRetry={() => void found.refetch()}
      />
    );

  const item = found.data;
  return (
    <div className="space-y-6">
      <Header item={item} />
      <Details item={item} />
      <CaseResearch caseId={item.id} />
      <CaseDocuments caseId={item.id} archived={item.archivedAt !== null} />
      <CaseLintReports caseId={item.id} archived={item.archivedAt !== null} />
      <div className="grid gap-6 md:grid-cols-2">
        <CaseDrafts caseId={item.id} archived={item.archivedAt !== null} />
        <PrecedentsCard />
      </div>
    </div>
  );
}

function Header({ item }: { item: Case }) {
  const t = useTranslations("Cases.dashboard");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const archive = useArchiveCase(item.id);
  const archived = item.archivedAt !== null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-foreground" dir="auto">
            {item.title}
          </h1>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {item.caseNumber && <span dir="auto">{item.caseNumber}</span>}
            {item.status && <span dir="auto">{item.status}</span>}
            <span>
              {t("updated", { time: format.relativeTime(new Date(item.updatedAt), now) })}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!archived && (
            <Button asChild>
              <Link href={`/research?case=${item.id}`}>
                <Search aria-hidden />
                {t("ask")}
              </Link>
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link href={`/cases/${item.id}/edit`}>
              <Pencil aria-hidden />
              {t("edit")}
            </Link>
          </Button>
          {archived ? (
            <Button
              variant="outline"
              disabled={archive.isPending}
              onClick={() => archive.mutate(false)}
            >
              {archive.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden />
              ) : (
                <ArchiveRestore aria-hidden />
              )}
              {t("unarchive")}
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={archive.isPending}>
                  {archive.isPending ? (
                    <LoaderCircle className="animate-spin" aria-hidden />
                  ) : (
                    <Archive aria-hidden />
                  )}
                  {t("archive")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("archiveTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("archiveBody")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => archive.mutate(true)}>
                    {t("archiveConfirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
      {archived && (
        <p role="status" className="rounded-sm border bg-muted p-3 text-sm text-muted-foreground">
          {t("archivedBanner")}
        </p>
      )}
      {archive.isError && (
        <p role="alert" className="text-sm text-danger">
          {t(statusOf(archive.error) === undefined ? "networkError" : "archiveError")}
        </p>
      )}
    </div>
  );
}

function Card({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <section className="rounded-md border bg-card p-5 sm:p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      {body && <p className="mt-1 text-sm text-muted-foreground">{body}</p>}
      {children && <div className="mt-4">{children}</div>}
    </section>
  );
}

function Details({ item }: { item: Case }) {
  const t = useTranslations("Cases");
  const format = useFormatter();
  const day = (value: string | null) => (value ? formatDay(format, value) : null);
  const rows: [string, string | null][] = [
    ["court", item.court],
    ["caseNumber", item.caseNumber],
    ["caseType", item.caseType],
    ["status", item.status],
    ["judge", item.judge],
    ["assignedLawyer", item.assignedLawyer],
    ["filedOn", day(item.filedOn)],
    ["nextHearingOn", day(item.nextHearingOn)],
  ];
  const sides: Party["side"][] = ["claimant", "respondent"];

  return (
    <Card title={t("dashboard.details")}>
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map(([field, value]) => (
          <div key={field}>
            <dt className="text-xs font-medium text-muted-foreground">{t(`fields.${field}`)}</dt>
            <dd className="mt-1 text-sm" dir="auto">
              {value ?? <span className="text-muted-foreground">{t("dashboard.notSet")}</span>}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        {sides.map((side) => {
          const parties = item.parties.filter((p) => p.side === side);
          return (
            <div key={side}>
              <h3 className="text-xs font-medium text-muted-foreground">{t(`sides.${side}`)}</h3>
              {parties.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">{t("dashboard.notSet")}</p>
              ) : (
                <ul className="mt-1 space-y-1 text-sm">
                  {parties.map((party, i) => (
                    <li key={i} dir="auto">
                      {party.name}
                      {party.label && (
                        <span className="text-muted-foreground"> ({party.label})</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6">
        <h3 className="text-xs font-medium text-muted-foreground">{t("fields.relevantLaws")}</h3>
        {item.relevantLaws.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">{t("dashboard.notSet")}</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {item.relevantLaws.map((law, i) => (
              <li key={i} dir="auto" className="rounded-sm bg-muted px-2 py-1 text-xs font-medium">
                {law}
              </li>
            ))}
          </ul>
        )}
      </div>

      {item.summary && (
        <div className="mt-6">
          <h3 className="text-xs font-medium text-muted-foreground">{t("fields.summary")}</h3>
          <p className="mt-1 text-sm whitespace-pre-line" dir="auto">
            {item.summary}
          </p>
        </div>
      )}
    </Card>
  );
}

// The conversations saved to this case (FR-CASE-4, FR-CASE-5), each opening in the Research Hub.
function CaseResearch({ caseId }: { caseId: string }) {
  const t = useTranslations("Cases.dashboard.research");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const research = useCaseConversations(caseId);
  const items = research.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card title={t("title")} body={t("body")}>
      {research.isPending && (
        <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          {t("loading")}
        </p>
      )}
      {research.isError && items.length === 0 && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
          <p>{t("error")}</p>
          <Button variant="outline" size="sm" onClick={() => void research.refetch()}>
            {t("retry")}
          </Button>
        </div>
      )}
      {research.isSuccess && items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      )}
      {items.length > 0 && (
        <ul aria-label={t("title")} className="divide-y rounded-md border">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/research?c=${item.id}`}
                className="block px-4 py-3 transition-colors hover:bg-accent"
              >
                <span className="block truncate text-sm" dir="auto">
                  {item.title}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {format.relativeTime(new Date(item.updatedAt), now)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {research.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full"
          disabled={research.isFetchingNextPage}
          onClick={() => research.fetchNextPage()}
        >
          {research.isFetchingNextPage && <LoaderCircle className="animate-spin" aria-hidden />}
          {t("loadMore")}
        </Button>
      )}
    </Card>
  );
}

// Precedents can't be saved to a case yet, so the card is a way into precedent search.
function PrecedentsCard() {
  const t = useTranslations("Cases.dashboard.precedents");
  return (
    <Link
      href="/precedents"
      className="group block rounded-md border bg-card p-5 transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:p-6"
    >
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Network className="size-4 text-muted-foreground" aria-hidden />
        {t("title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("body")}</p>
      <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary group-hover:underline">
        {t("action")}
        <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
      </span>
    </Link>
  );
}
